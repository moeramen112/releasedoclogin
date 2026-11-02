import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.js";
import { defaultPlan } from "../src/plan.js";
import { newToken, hashToken, clampDays, linkState, publicView, renderSharePage, TOKEN_RE } from "../src/share.js";

const H = { "Content-Type": "application/json", "X-Requested-With": "release-readiness" };

test("tokens are random, long, and only their hash is compared", () => {
  const a = newToken(), b = newToken();
  assert.notEqual(a, b); assert.match(a, TOKEN_RE); assert.equal(hashToken(a).length, 64); assert.notEqual(hashToken(a), a);
});

test("clampDays and linkState", () => {
  assert.equal(clampDays(undefined), 7); assert.equal(clampDays("x"), 7); assert.equal(clampDays(0), 7); assert.equal(clampDays(-3), 7);
  assert.equal(clampDays(500), 90); assert.equal(clampDays(2.9), 2);
  const now = 1_000;
  assert.equal(linkState({ expiresAt: now + 1 }, now), "active");
  assert.equal(linkState({ expiresAt: now }, now), "expired");
  assert.equal(linkState({ expiresAt: now + 5, revoked: true }, now), "revoked");
  assert.equal(linkState({}, now), "expired"); assert.equal(linkState(undefined, now), "missing");
});

test("the public view leaves out people, ticket text, notes and settings", () => {
  const plan = defaultPlan(Date.now());
  plan.tickets[0].summary = "SECRET-TICKET-TEXT"; plan.tickets[0].assignee = "Secret Person";
  plan.outcome = { status: "Shipped cleanly", at: "", note: "SECRET-NOTE", snapshot: null };
  const text = JSON.stringify(publicView(plan)) + renderSharePage(publicView(plan));
  for (const s of ["SECRET-TICKET-TEXT", "Secret Person", "SECRET-NOTE", "slack", "webhook"]) assert.ok(!text.toLowerCase().includes(s.toLowerCase()), s);
  assert.match(text, /GO|HOLD|NO-GO/);
});

test("the share page escapes everything and has no scripts", () => {
  const plan = defaultPlan(Date.now()); plan.release.name = '<script>alert(1)</script>"x';
  const html = renderSharePage(publicView(plan));
  assert.ok(!html.includes("<script")); assert.ok(html.includes("&lt;script&gt;"));
  assert.match(renderSharePage(null), /no longer active/);
  assert.doesNotThrow(() => publicView({})); assert.doesNotThrow(() => publicView(null));
});

async function boot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "share-"));
  const app = await createApp({ stateDir: dir, auth: false, defaultMode: "demo" });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { base, dir, close: () => new Promise((r) => app.server.close(r)) };
}
const put = (base, id, plan) => fetch(`${base}/api/releases/${id}`, { method: "PUT", headers: H, body: JSON.stringify({ plan, baseVersion: 0 }) });

test("create, open without sign-in, expire, revoke, and no other release leaks", async () => {
  const { base, dir, close } = await boot();
  try {
    const a = defaultPlan(Date.now()); a.release.name = "Alpha release";
    const b = defaultPlan(Date.now()); b.release.name = "Bravo release";
    assert.equal((await put(base, "rel-a", a)).status, 200); assert.equal((await put(base, "rel-b", b)).status, 200);
    assert.equal((await fetch(`${base}/api/share/create`, { method: "POST", headers: H, body: JSON.stringify({ releaseId: "nope" }) })).status, 404);
    const made = await (await fetch(`${base}/api/share/create`, { method: "POST", headers: H, body: JSON.stringify({ releaseId: "rel-a", days: 3 }) })).json();
    assert.match(made.url, /\/share\/[A-Za-z0-9_-]{32}$/);
    const page = await fetch(made.url);
    assert.equal(page.status, 200); assert.match(page.headers.get("content-security-policy"), /default-src 'none'/); assert.match(page.headers.get("x-robots-tag"), /noindex/);
    const html = await page.text();
    assert.ok(html.includes("Alpha release")); assert.ok(!html.includes("Bravo release"));
    const list = await (await fetch(`${base}/api/share/list?releaseId=rel-a`)).json();
    assert.equal(list.links.length, 1); assert.equal(list.links[0].state, "active");
    assert.ok(!JSON.stringify(list).includes(made.url.split("/").pop()), "the list never shows the secret");
    const saved = await fs.readFile(path.join(dir, "shares.json"), "utf8");
    assert.ok(!saved.includes(made.url.split("/").pop()), "only the hash is saved");
    await fetch(`${base}/api/share/revoke`, { method: "POST", headers: H, body: JSON.stringify({ id: made.id }) });
    const gone = await fetch(made.url);
    assert.equal(gone.status, 404); assert.match(await gone.text(), /no longer active/);
  } finally { await close(); }
});

test("bad codes, junk ids and hostile bodies are refused cleanly", async () => {
  const { base, close } = await boot();
  try {
    for (const t of ["x", "a".repeat(32), "../../etc/passwd", "constructor", "__proto__", "a".repeat(200)]) {
      const r = await fetch(`${base}/share/${t}`);
      assert.ok([404].includes(r.status) || r.status === 429, t + " " + r.status);
    }
    for (const body of ["null", "[]", "7", '{"releaseId":{"a":1}}', '{"releaseId":"constructor"}']) {
      const r = await fetch(`${base}/api/share/create`, { method: "POST", headers: H, body });
      assert.ok(r.status === 400 || r.status === 404, body + " " + r.status);
    }
    assert.equal((await fetch(`${base}/api/share/create`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 403);
    assert.equal((await fetch(`${base}/api/share/revoke`, { method: "POST", headers: H, body: '{"id":"zzz"}' })).status, 404);
  } finally { await close(); }
});

test("repeated wrong guesses are rate-limited", async () => {
  const { base, close } = await boot();
  try {
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await fetch(`${base}/share/${newToken()}`)).status;
    assert.equal(last, 429);
  } finally { await close(); }
});
