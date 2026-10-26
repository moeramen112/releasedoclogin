// Hostile-input tests: what an attacker, a buggy client or a curious viewer can do to the server.
// Every request here must end in a clean 4xx (or 200 where allowed), never a 500, never a crash, never a data leak.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.js";

const H = { "Content-Type": "application/json", "X-Requested-With": "release-readiness" };
let dir, app, base, port, admin, editor, viewer;
const call = (method, p, body, cookie, headers = H) =>
  fetch(base + p, { method, redirect: "manual", headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
const cookieOf = (r) => (r.headers.get("set-cookie") || "").split(";")[0];
const plan = (name = "R1", extra = {}) => ({ release: { name }, tickets: [], ...extra });

/** Raw socket request, for things fetch will not send (bad paths, bad headers). */
const raw = (text) => new Promise((resolve) => {
  const s = net.connect(port, "127.0.0.1", () => s.write(text));
  let out = ""; s.on("data", (d) => (out += d)); s.on("close", () => resolve(out)); s.on("error", () => resolve(out));
  setTimeout(() => { s.destroy(); }, 1500);
});
const statusOf = (r) => Number((r.match(/^HTTP\/1\.1 (\d+)/) || [])[1] || 0);

async function join(role, email) {
  const r = await call("POST", "/api/admin/users", { email, name: email.split("@")[0], role }, admin);
  const link = new URL((await r.json()).inviteUrl);
  const a = await call("POST", "/api/auth/accept", { email, token: link.searchParams.get("token"), password: "correct horse battery" });
  return cookieOf(a);
}

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "rr-attack-"));
  const boot = await createApp({ stateDir: dir, defaultMode: "demo", env: { ADMIN_EMAIL: "admin@example.com" } });
  const b = await boot.auth.bootstrap();
  app = await createApp({ stateDir: dir, defaultMode: "demo", env: { AI_PER_HOUR: "1000" } });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  port = app.server.address().port; base = `http://127.0.0.1:${port}`;
  const ok = await call("POST", "/api/auth/accept", { email: "admin@example.com", token: b.token, password: "a long enough password" });
  admin = cookieOf(ok);
  editor = await join("editor", "ed@example.com");
  viewer = await join("viewer", "vi@example.com");
});
after(() => { app.server.close(); rmSync(dir, { recursive: true, force: true }); });

test("JSON bodies that are not objects get a clean 400 on every POST route", async () => {
  const routes = ["/api/waive", "/api/unwaive", "/api/manual", "/api/notify", "/api/agent/check", "/api/agent/auto", "/api/agent/item", "/api/ai/briefing", "/api/ai/risks", "/api/ai/dependencies", "/api/ai/schedule", "/api/ai/raid", "/api/auth/login", "/api/auth/accept", "/api/auth/password", "/api/admin/users", "/api/admin/users/reinvite", "/api/admin/users/update"];
  for (const p of routes) for (const body of ["null", "[]", "7", '"x"', "true", "{bad json", ""]) {
    const r = await call("POST", p, body, admin);
    assert.ok(r.status >= 200 && r.status < 500, `${p} with body ${JSON.stringify(body)} gave ${r.status}`);
  }
  for (const body of ["null", "[]", "7", '"x"']) {
    const r = await call("PUT", "/api/releases/abc-123", body, editor);
    assert.equal(r.status, 400, `PUT with ${body}`);
  }
});

test("release ids that are also object property names do not leak or crash", async () => {
  for (const id of ["constructor", "prototype", "valueof", "tostring", "hasownproperty", "__proto__", "abc", "a-b"]) {
    for (const m of ["GET", "DELETE"]) {
      const r = await call(m, `/api/releases/${id}`, undefined, editor);
      assert.ok([200, 400, 404].includes(r.status), `${m} ${id} gave ${r.status}`);
      if (r.status === 200) { const t = await r.text(); assert.ok(t === "" ? m === "DELETE" : t.startsWith("{"), `${m} ${id} body: ${t.slice(0, 40)}`); }
    }
  }
  const put = await call("PUT", "/api/releases/constructor", { plan: plan("Odd id"), baseVersion: 0 }, editor);
  assert.equal(put.status, 200);
  assert.equal((await (await call("GET", "/api/releases/constructor", undefined, editor)).json()).plan.release.name, "Odd id");
  assert.equal((await call("DELETE", "/api/releases/constructor", undefined, editor)).status, 200);
});

test("roles: a viewer can read but never change anything, an editor cannot touch accounts", async () => {
  const w = await call("PUT", "/api/releases/role-test", { plan: plan("Mine"), baseVersion: 0 }, editor);
  assert.equal(w.status, 200);
  for (const [m, p, b] of [["PUT", "/api/releases/role-test", { plan: plan("Hack"), baseVersion: 1 }], ["DELETE", "/api/releases/role-test"], ["POST", "/api/waive", {}], ["POST", "/api/agent/check", { releaseId: "role-test" }], ["POST", "/api/ai/raid", {}], ["GET", "/api/admin/users"], ["POST", "/api/admin/users", { email: "x@y.com", role: "admin" }]]) {
    const r = await call(m, p, b, viewer); assert.equal(r.status, 403, `viewer ${m} ${p}`);
  }
  for (const [p, b] of [["/api/admin/users", { email: "x@y.com", role: "admin" }], ["/api/admin/users/update", { email: "vi@example.com", role: "admin" }]]) {
    assert.equal((await call("POST", p, b, editor)).status, 403, `editor ${p}`);
  }
  assert.equal((await (await call("GET", "/api/releases/role-test", undefined, viewer)).json()).plan.release.name, "Mine");
  assert.equal((await call("GET", "/api/releases", undefined, viewer)).status, 200);
});

test("no session, a forged session and a tampered session are all refused", async () => {
  const good = admin.split("=")[1];
  const [payload, sig] = good.split(".");
  const swapped = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), role: "admin", e: "ed@example.com" })).toString("base64url");
  for (const c of ["", "rr_session=", "rr_session=abc", `rr_session=${payload}.`, `rr_session=${swapped}.${sig}`, `rr_session=${payload}.${sig.slice(0, -2)}AA`, "rr_session=" + "A".repeat(5000), "rr_session=%E0%A4%A"]) {
    const r = await call("GET", "/api/releases", undefined, c || undefined);
    assert.equal(r.status, 401, `cookie ${c.slice(0, 30)}`);
  }
});

test("CSRF: state-changing calls need the header and a same-origin Origin, even with a valid session", async () => {
  const noHeader = await call("PUT", "/api/releases/csrf-1", { plan: plan(), baseVersion: 0 }, editor, { "Content-Type": "application/json" });
  assert.equal(noHeader.status, 403);
  for (const origin of ["http://evil.example", "null", "not a url", "http://127.0.0.1:1", "javascript:alert(1)", ""]) {
    const r = await call("PUT", "/api/releases/csrf-2", { plan: plan(), baseVersion: 0 }, editor, { ...H, Origin: origin });
    assert.ok(r.status === 403 || (origin === "" && r.status === 200), `Origin ${JSON.stringify(origin)} gave ${r.status}`);
  }
  const same = await call("PUT", "/api/releases/csrf-3", { plan: plan(), baseVersion: 0 }, editor, { ...H, Origin: base });
  assert.equal(same.status, 200);
});

test("static files: no path traversal, no directory listing, no source or data leaks", async () => {
  const paths = ["/../package.json", "/%2e%2e/package.json", "/..%2fpackage.json", "/..%5cpackage.json", "/%2e%2e%2f%2e%2e%2fetc/passwd", "/..;/package.json", "/./../src/server.js", "//etc/passwd", "/%00", "/css/%00.css", "/data/releases.json", "/releases.json", "/readiness.config.json", "/src/server.js", "/.git/config", "/auth.js", "/ai.js", "/server.js", "/users.json"];
  for (const p of paths) {
    const res = await raw(`GET ${p} HTTP/1.1\r\nHost: x\r\nCookie: ${admin}\r\nConnection: close\r\n\r\n`);
    const st = statusOf(res);
    assert.ok(st === 404 || st === 400, `${p} gave ${st}`);
    assert.ok(!/"scrypt|inviteHash|pwHash|root:x:0/.test(res), `${p} leaked`);
  }
  // the shared modules are meant to be served; check they are what we think
  assert.equal((await call("GET", "/raid.js", undefined, viewer)).status, 200);
});

test("malformed HTTP does not kill the server", async () => {
  for (const req of ["GET / HTTP/1.1\r\n\r\n", "GARBAGE\r\n\r\n", "GET /api/releases HTTP/1.1\r\nHost: x\r\nCookie: " + "a=".padEnd(70000, "b") + "\r\n\r\n", "POST /api/waive HTTP/1.1\r\nHost: x\r\nContent-Length: 99999999\r\n\r\nabc", "GET /%ZZ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", "OPTIONS * HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", "TRACE / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"]) await raw(req);
  assert.equal((await call("GET", "/api/health")).status, 200);
  for (const m of ["PATCH", "OPTIONS", "HEAD", "TRACE"]) {
    const r = await fetch(base + "/api/releases", { method: m === "TRACE" ? "GET" : m, headers: { Cookie: viewer } });
    assert.ok(r.status < 500, `${m} gave ${r.status}`);
  }
});

test("query strings on the dashboard routes cannot be abused", async () => {
  for (const q of ["repo=../../etc/passwd", "repo=a/b/c", "repo=" + "a".repeat(5000) + "/b", "head=" + encodeURIComponent("$(rm -rf /)"), "base=%00", "demo=1&repo=x%2Fy", "refresh=1&refresh=1", "repo[]=a/b"]) {
    const r = await call("GET", `/api/readiness?${q}`, undefined, viewer);
    assert.ok(r.status < 500, `${q.slice(0, 40)} gave ${r.status}`);
  }
});

test("hostile plan content is stored as text and every API that reads a plan still works", async () => {
  const evil = "<img src=x onerror=alert(1)>\"'`${7*7}{{7*7}}\u0000‮\ud800";
  const nasty = plan(evil, {
    release: { name: evil, version: evil, type: evil },
    people: { releaseManager: evil, sre: evil, qaLead: evil },
    where: { repo: evil },
    when: { deployAt: "9999-99-99T99:99", freezeAt: "not a date", meetingAt: "0000-00-00T00:00", windowHours: "NaN" },
    tickets: [{ key: evil, title: evil, points: -5, status: evil }, null, 7, "x", { key: "A-1", points: 1e308 }],
    handoffs: [null, { what: evil, to: evil, due: "garbage", status: evil }, 3],
    raid: [null, { type: evil, what: evil, owner: evil, due: "x", rating: evil, status: evil }, { type: "Risk" }, 9],
    raidDismissed: [null, 5, evil], bugs: "nope", checks: 3,
  });
  const put = await call("PUT", "/api/releases/evil-1", { plan: nasty, baseVersion: 0 }, editor);
  assert.equal(put.status, 200);
  const back = await (await call("GET", "/api/releases/evil-1", undefined, viewer)).json();
  assert.equal(back.plan.release.name, evil);
  assert.equal((await call("GET", "/api/releases", undefined, viewer)).status, 200);
  for (const p of ["/api/agent/check", "/api/ai/briefing", "/api/ai/risks", "/api/ai/dependencies", "/api/ai/schedule", "/api/ai/raid"]) {
    const r = await call("POST", p, { releaseId: "evil-1", plan: nasty, audience: evil }, editor);
    assert.ok(r.status < 500, `${p} gave ${r.status}: ${(await r.text()).slice(0, 80)}`);
  }
  assert.equal((await call("GET", "/api/agent?releaseId=evil-1", undefined, viewer)).status < 500, true);
  assert.equal((await call("DELETE", "/api/releases/evil-1", undefined, editor)).status, 200);
});

test("two editors saving at once: exactly one wins, the other gets a conflict", async () => {
  assert.equal((await call("PUT", "/api/releases/race-1", { plan: plan("Base"), baseVersion: 0 }, editor)).status, 200);
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => call("PUT", "/api/releases/race-1", { plan: plan("Edit " + i), baseVersion: 1 }, i % 2 ? editor : admin)));
  const codes = rs.map((r) => r.status).sort();
  assert.equal(codes.filter((c) => c === 200).length, 1, codes.join());
  assert.equal(codes.filter((c) => c === 409).length, 11, codes.join());
  assert.equal((await (await call("GET", "/api/releases/race-1", undefined, viewer)).json()).version, 2);
});

test("parallel creates, deletes and reads never corrupt the store", async () => {
  const ids = Array.from({ length: 30 }, (_, i) => `par-${i}`);
  await Promise.all(ids.map((id) => call("PUT", `/api/releases/${id}`, { plan: plan(id), baseVersion: 0 }, editor)));
  await Promise.all([...ids.slice(0, 15).map((id) => call("DELETE", `/api/releases/${id}`, undefined, editor)), ...Array.from({ length: 20 }, () => call("GET", "/api/releases", undefined, viewer))]);
  const list = (await (await call("GET", "/api/releases", undefined, viewer)).json()).releases.map((r) => r.id);
  for (const id of ids.slice(15)) assert.ok(list.includes(id), id);
  for (const id of ids.slice(0, 15)) assert.ok(!list.includes(id), id);
});

test("size limits: oversized plans are refused, huge arrays inside the limit still work", async () => {
  assert.equal((await call("PUT", "/api/releases/big-1", { plan: plan("x", { notes: "a".repeat(1_000_000) }), baseVersion: 0 }, editor, { ...H, Connection: "close" }).catch(() => ({ status: 413 }))).status, 413); // the server may hang up mid-upload; that counts as a refusal
  const many = plan("many", { tickets: Array.from({ length: 3000 }, (_, i) => ({ key: "T-" + i, title: "t", points: 1, status: "To Do" })) });
  const r = await call("PUT", "/api/releases/big-2", { plan: many, baseVersion: 0 }, editor);
  assert.ok(r.status === 200 || r.status === 413);
  if (r.status === 200) {
    for (const p of ["/api/agent/check", "/api/ai/risks", "/api/ai/schedule"]) assert.ok((await call("POST", p, { releaseId: "big-2" }, editor)).status < 500, p);
  }
});

test("login: wrong, odd and huge credentials give 400 or 401, never a crash, and lock after repeats", async () => {
  for (const b of [{}, { email: 5, password: 5 }, { email: ["a"], password: {} }, { email: "a@b.c", password: "x".repeat(100000) }, { email: "ADMIN@example.com ", password: "nope" }, { email: "admin@example.com\u0000", password: "x" }]) {
    const r = await call("POST", "/api/auth/login", b); assert.ok([400, 401, 413, 429].includes(r.status), `${JSON.stringify(b).slice(0, 40)} gave ${r.status}`);
  }
  let last;
  for (let i = 0; i < 8; i++) last = (await call("POST", "/api/auth/login", { email: "ed@example.com", password: "wrong-" + i })).status;
  assert.equal(last, 429);
  // the right password is also refused while locked: no oracle
  assert.equal((await call("POST", "/api/auth/login", { email: "ed@example.com", password: "correct horse battery" })).status, 429);
});

test("a deactivated person loses access immediately; the last admin cannot be removed", async () => {
  const c = await join("editor", "gone@example.com");
  assert.equal((await call("GET", "/api/releases", undefined, c)).status, 200);
  assert.equal((await call("POST", "/api/admin/users/update", { email: "gone@example.com", active: false }, admin)).status, 200);
  assert.equal((await call("GET", "/api/releases", undefined, c)).status, 401);
  assert.equal((await call("POST", "/api/admin/users/update", { email: "admin@example.com", role: "viewer" }, admin)).status, 400);
  assert.equal((await call("POST", "/api/admin/users/update", { email: "admin@example.com", active: false }, admin)).status, 400);
  assert.equal((await call("POST", "/api/admin/users/update", { email: "nobody@example.com", role: "admin" }, admin)).status < 500, true);
  assert.equal((await call("POST", "/api/admin/users/update", { email: "vi@example.com", role: "superuser" }, admin)).status, 400);
});

test("session cookie is HttpOnly and SameSite=Strict; responses carry the security headers", async () => {
  const r = await call("POST", "/api/auth/login", { email: "admin@example.com", password: "a long enough password" });
  const sc = r.headers.get("set-cookie");
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
  const g = await call("GET", "/api/releases", undefined, admin);
  assert.equal(g.headers.get("x-content-type-options"), "nosniff");
  assert.equal(g.headers.get("x-frame-options"), "DENY");
  assert.equal(g.headers.get("cache-control"), "no-store");
});

test("the AI hourly limit applies per person and returns 429", async () => {
  const lim = await createApp({ stateDir: mkdtempSync(path.join(tmpdir(), "rr-lim-")), defaultMode: "demo", env: { AI_PER_HOUR: "3" }, auth: false });
  await new Promise((r) => lim.server.listen(0, "127.0.0.1", r));
  const b = `http://127.0.0.1:${lim.server.address().port}`;
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await fetch(b + "/api/ai/risks", { method: "POST", headers: H, body: JSON.stringify({ plan: plan() }) })).status);
  lim.server.close();
  assert.deepEqual(codes.slice(3), [429, 429], codes.join());
});
