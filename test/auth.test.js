import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.js";

const H = { "Content-Type": "application/json", "X-Requested-With": "release-readiness" };
let dir, app, base, adminCookie;

const call = (method, p, body, cookie, headers = H) =>
  fetch(base + p, { method, redirect: "manual", headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const cookieOf = (r) => (r.headers.get("set-cookie") || "").split(";")[0];
const plan = (name = "R1") => ({ release: { name }, tickets: [] });

async function invite(role, email, by = adminCookie) {
  const r = await call("POST", "/api/admin/users", { email, name: email.split("@")[0], role }, by);
  assert.equal(r.status, 200);
  const link = new URL((await r.json()).inviteUrl);
  return { email: link.searchParams.get("email"), token: link.searchParams.get("token") };
}
async function join(role, email, password = "correct horse battery") {
  const { token } = await invite(role, email);
  const r = await call("POST", "/api/auth/accept", { email, token, password });
  assert.equal(r.status, 200);
  return cookieOf(r);
}

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "rr-auth-"));
  app = await createApp({ stateDir: dir, defaultMode: "demo", env: {} });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const b = await app.auth.bootstrap();
  assert.equal(b.missing, true); // no ADMIN_EMAIL, so no account is invented
});
after(() => { app.server.close(); rmSync(dir, { recursive: true, force: true }); });

test("with no accounts yet, nothing is open and the login page says so", async () => {
  assert.equal((await call("GET", "/api/releases")).status, 401);
  const st = await (await call("GET", "/api/auth/status")).json();
  assert.equal(st.hasUsers, false);
});

test("first admin comes from ADMIN_EMAIL and sets a password from a one-time link", async () => {
  const a2 = await createApp({ stateDir: mkdtempSync(path.join(tmpdir(), "rr-b-")), env: { ADMIN_EMAIL: "Boss@Example.com" } });
  const b = await a2.auth.bootstrap();
  assert.equal(b.email, "boss@example.com");
  assert.ok(b.token.length > 30);
  assert.equal(await a2.auth.bootstrap(), null); // only when there are no users
  // become the admin of the main app by using the same mechanism there
  const first = await (async () => {
    const m = await createApp({ stateDir: dir, defaultMode: "demo", env: { ADMIN_EMAIL: "admin@example.com" } });
    return m.auth.bootstrap();
  })();
  assert.ok(first.token);
  app.server.close();
  app = await createApp({ stateDir: dir, defaultMode: "demo", env: {} });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const r = await call("POST", "/api/auth/accept", { email: "admin@example.com", token: first.token, password: "short" });
  assert.equal(r.status, 400); // too short
  const ok = await call("POST", "/api/auth/accept", { email: "admin@example.com", token: first.token, password: "a long enough password" });
  assert.equal(ok.status, 200);
  adminCookie = cookieOf(ok);
  assert.match(adminCookie, /^rr_session=/);
  assert.equal((await call("POST", "/api/auth/accept", { email: "admin@example.com", token: first.token, password: "another long password" })).status, 400); // single use
});

test("pages and API need a session; login page and styles do not", async () => {
  assert.equal((await call("GET", "/")).status, 302);
  assert.match((await call("GET", "/plan.html")).headers.get("location"), /^\/login\.html\?next=/);
  assert.equal((await call("GET", "/login.html")).status, 200);
  assert.equal((await call("GET", "/styles.css")).status, 200);
  assert.equal((await call("GET", "/plan-ui.js")).status, 401);
  assert.equal((await call("GET", "/engine.js")).status, 401);
  assert.equal((await call("GET", "/api/readiness")).status, 401);
  assert.equal((await call("GET", "/", undefined, adminCookie)).status, 200);
  assert.equal((await call("GET", "/api/readiness", undefined, adminCookie)).status, 200);
});

test("a forged or tampered cookie does not work", async () => {
  const [name, val] = adminCookie.split("=");
  const [payload, sig] = val.split(".");
  const forged = Buffer.from(JSON.stringify({ e: "admin@example.com", x: Date.now() + 1e9, v: 0 })).toString("base64url");
  assert.equal((await call("GET", "/api/releases", undefined, `${name}=${forged}.${sig}`)).status, 401);
  assert.equal((await call("GET", "/api/releases", undefined, `${name}=${payload}.AAAA`)).status, 401);
});

test("login needs the custom header, and wrong passwords get the same answer for known and unknown emails", async () => {
  assert.equal((await call("POST", "/api/auth/login", { email: "admin@example.com", password: "x" }, undefined, { "Content-Type": "application/json" })).status, 403);
  const a = await call("POST", "/api/auth/login", { email: "admin@example.com", password: "wrong password!" });
  const b = await call("POST", "/api/auth/login", { email: "nobody@example.com", password: "wrong password!" });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal((await a.json()).error, (await b.json()).error);
  const ok = await call("POST", "/api/auth/login", { email: "ADMIN@example.com", password: "a long enough password" });
  assert.equal(ok.status, 200);
});

test("five wrong passwords lock that email and address for a while", async () => {
  await join("viewer", "lock@example.com");
  for (let i = 0; i < 5; i++) assert.equal((await call("POST", "/api/auth/login", { email: "lock@example.com", password: "nope nope nope" })).status, 401);
  const r = await call("POST", "/api/auth/login", { email: "lock@example.com", password: "correct horse battery" });
  assert.equal(r.status, 429); // even the right password waits
});

test("roles: viewers read, editors change releases, only admins manage people", async () => {
  const viewer = await join("viewer", "view@example.com");
  const editor = await join("editor", "edit@example.com");
  assert.equal((await call("PUT", "/api/releases/r-one", { plan: plan(), baseVersion: 0 }, viewer)).status, 403);
  assert.equal((await call("PUT", "/api/releases/r-one", { plan: plan("Spring"), baseVersion: 0 }, editor)).status, 200);
  const list = await (await call("GET", "/api/releases", undefined, viewer)).json();
  assert.equal(list.me.role, "viewer");
  assert.equal(list.releases[0].plan.release.name, "Spring");
  assert.equal(list.releases[0].updatedBy, "edit");
  assert.equal((await call("GET", "/api/admin/users", undefined, editor)).status, 403);
  assert.equal((await call("POST", "/api/admin/users", { email: "x@example.com", role: "viewer" }, editor)).status, 403);
  assert.equal((await call("POST", "/api/waive", { id: "migration", reason: "long enough reason" }, viewer)).status, 403);
  assert.equal((await call("DELETE", "/api/releases/r-one", undefined, viewer)).status, 403);
});

test("two people cannot silently overwrite each other", async () => {
  const e1 = await join("editor", "e1@example.com"), e2 = await join("editor", "e2@example.com");
  const created = await (await call("PUT", "/api/releases/r-conf", { plan: plan("A"), baseVersion: 0 }, e1)).json();
  assert.equal(created.version, 1);
  const second = await (await call("PUT", "/api/releases/r-conf", { plan: plan("B"), baseVersion: 1 }, e1)).json();
  assert.equal(second.version, 2);
  const stale = await call("PUT", "/api/releases/r-conf", { plan: plan("C"), baseVersion: 1 }, e2);
  assert.equal(stale.status, 409);
  const body = await stale.json();
  assert.match(body.error, /e1 changed this release/);
  assert.equal(body.current.version, 2);
  const kept = await (await call("GET", "/api/releases/r-conf", undefined, e2)).json();
  assert.equal(kept.plan.release.name, "B");
  assert.equal((await call("PUT", "/api/releases/r-conf", { plan: plan("C"), baseVersion: 2 }, e2)).status, 200);
});

test("bad release input is refused", async () => {
  assert.equal((await call("PUT", "/api/releases/r-bad", { plan: { nope: 1 }, baseVersion: 0 }, adminCookie)).status, 400);
  assert.equal((await call("PUT", "/api/releases/BAD ID", { plan: plan(), baseVersion: 0 }, adminCookie)).status, 404);
  assert.equal((await call("PUT", "/api/releases/r-bad", { plan: plan(), baseVersion: 0 }, adminCookie, { "Content-Type": "application/json" })).status, 403);
  assert.equal((await call("PUT", "/api/releases/r-gone", { plan: plan(), baseVersion: 3 }, adminCookie)).status, 409);
});

test("delete works for editors and can be undone by saving again", async () => {
  assert.equal((await call("PUT", "/api/releases/r-del", { plan: plan("Del"), baseVersion: 0 }, adminCookie)).status, 200);
  assert.equal((await call("DELETE", "/api/releases/r-del", undefined, adminCookie)).status, 200);
  assert.equal((await call("GET", "/api/releases/r-del", undefined, adminCookie)).status, 404);
  assert.equal((await call("PUT", "/api/releases/r-del", { plan: plan("Del"), baseVersion: 0 }, adminCookie)).status, 200);
});

test("waivers carry the signed-in name, whatever the request says", async () => {
  const editor = await join("editor", "waiver@example.com");
  const r = await call("POST", "/api/waive", { id: "migration", approver: "Somebody Else", reason: "accepted for this release" }, editor);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.audit[0].by, "waiver");
  assert.ok(!JSON.stringify(d.audit).includes("Somebody Else"));
});

test("invites: duplicates, bad email, bad role, wrong token", async () => {
  assert.equal((await call("POST", "/api/admin/users", { email: "view@example.com", role: "viewer" }, adminCookie)).status, 409);
  assert.equal((await call("POST", "/api/admin/users", { email: "not-an-email", role: "viewer" }, adminCookie)).status, 400);
  assert.equal((await call("POST", "/api/admin/users", { email: "z@example.com", role: "boss" }, adminCookie)).status, 400);
  const { email } = await invite("viewer", "late@example.com");
  assert.equal((await call("POST", "/api/auth/accept", { email, token: "wrong", password: "long enough password" })).status, 400);
  const again = await call("POST", "/api/admin/users/reinvite", { email }, adminCookie);
  const t2 = new URL((await again.json()).inviteUrl).searchParams.get("token");
  assert.equal((await call("POST", "/api/auth/accept", { email, token: t2, password: "long enough password" })).status, 200);
});

test("passwords are stored hashed, never in the clear", () => {
  const raw = readFileSync(path.join(dir, "users.json"), "utf8");
  assert.ok(!raw.includes("a long enough password"));
  assert.ok(!raw.includes("correct horse battery"));
  assert.match(raw, /"hash"/);
});

test("the last admin cannot be removed, and you cannot demote yourself", async () => {
  const r = await call("POST", "/api/admin/users/update", { email: "admin@example.com", role: "viewer" }, adminCookie);
  assert.equal(r.status, 400);
  const e2 = await call("POST", "/api/admin/users/update", { email: "admin@example.com", active: false }, adminCookie);
  assert.equal(e2.status, 400);
});

test("deactivating someone ends their session at once", async () => {
  const c = await join("editor", "gone@example.com");
  assert.equal((await call("GET", "/api/releases", undefined, c)).status, 200);
  assert.equal((await call("POST", "/api/admin/users/update", { email: "gone@example.com", active: false }, adminCookie)).status, 200);
  assert.equal((await call("GET", "/api/releases", undefined, c)).status, 401);
  assert.equal((await call("POST", "/api/auth/login", { email: "gone@example.com", password: "correct horse battery" })).status, 401);
});

test("changing a password ends the other sessions but keeps this one", async () => {
  const first = await join("editor", "pw@example.com", "first password here");
  const second = cookieOf(await call("POST", "/api/auth/login", { email: "pw@example.com", password: "first password here" }));
  const r = await call("POST", "/api/auth/password", { current: "first password here", next: "second password here" }, first);
  assert.equal(r.status, 200);
  const kept = cookieOf(r);
  assert.equal((await call("GET", "/api/releases", undefined, second)).status, 401);
  assert.equal((await call("GET", "/api/releases", undefined, first)).status, 401);
  assert.equal((await call("GET", "/api/releases", undefined, kept)).status, 200);
  assert.equal((await call("POST", "/api/auth/password", { current: "wrong", next: "third password here" }, kept)).status, 400);
});

test("logout clears the cookie", async () => {
  const r = await call("POST", "/api/auth/logout", {}, adminCookie);
  assert.match(r.headers.get("set-cookie"), /Max-Age=0/);
});

test("cookies are HttpOnly and SameSite=Strict, and Secure behind https", async () => {
  const r = await call("POST", "/api/auth/login", { email: "admin@example.com", password: "a long enough password" });
  const c = r.headers.get("set-cookie");
  assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Strict/); assert.ok(!/Secure/.test(c));
  const s = await createApp({ stateDir: dir, env: { COOKIE_SECURE: "1" } });
  await new Promise((res) => s.server.listen(0, "127.0.0.1", res));
  const r2 = await fetch(`http://127.0.0.1:${s.server.address().port}/api/auth/login`, { method: "POST", headers: H, body: JSON.stringify({ email: "admin@example.com", password: "a long enough password" }) });
  assert.match(r2.headers.get("set-cookie"), /Secure/);
  s.server.close();
});
