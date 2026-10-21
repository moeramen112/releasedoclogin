import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.js";
import { createClient, fetchGithub } from "../src/sources/github.js";
import { startMockGithub } from "../testing/mock-github.js";

const H = { "Content-Type": "application/json", "X-Requested-With": "release-readiness" };
let dir, app, base, sent;

async function start(opts) {
  const a = await createApp({ stateDir: dir, auth: false, ...opts });
  await new Promise((r) => a.server.listen(0, "127.0.0.1", r));
  return { a, base: `http://127.0.0.1:${a.server.address().port}` };
}
const post = (b, p, body, headers = H) => fetch(b + p, { method: "POST", headers, body: JSON.stringify(body) });

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "rr-"));
  sent = [];
  const s = await start({ defaultMode: "demo", env: { SLACK_WEBHOOK_URL: "https://hooks.example/x" }, deps: { sendSlack: async (url, payload) => sent.push(payload) } });
  app = s.a; base = s.base;
});
after(() => { app.server.close(); rmSync(dir, { recursive: true, force: true }); });

test("demo mode starts at NO-GO with the seeded failing migration check", async () => {
  const d = await (await fetch(base + "/api/readiness")).json();
  assert.equal(d.mode, "demo");
  assert.equal(d.result.verdict.call, "NO-GO");
  const mig = d.result.criteria.find((c) => c.id === "migration");
  assert.equal(mig.status, "fail");
});

test("changes need the custom header", async () => {
  const r = await post(base, "/api/waive", { id: "p0" }, { "Content-Type": "application/json" });
  assert.equal(r.status, 403);
});

test("cross-origin requests are refused", async () => {
  const r = await post(base, "/api/waive", { id: "p0" }, { ...H, Origin: "https://evil.example" });
  assert.equal(r.status, 403);
});

test("a waiver needs an approver and a real reason", async () => {
  let r = await post(base, "/api/waive", { id: "p0", approver: "", reason: "Fix ships in 4.12.1" });
  assert.equal(r.status, 400);
  r = await post(base, "/api/waive", { id: "p0", approver: "VP Eng", reason: "ok" });
  assert.equal(r.status, 400);
});

test("a passing criterion cannot be waived", async () => {
  const r = await post(base, "/api/waive", { id: "rollback", approver: "VP Eng", reason: "Not needed at all" });
  assert.equal(r.status, 400);
});

test("waiving the failures moves the call to HOLD, and the audit log records who", async () => {
  for (const id of ["p0", "migration"]) {
    const r = await post(base, "/api/waive", { id, approver: "Sam Okafor", reason: "Hotfix 4.12.1 is scheduled for Friday" });
    assert.equal(r.status, 200);
  }
  const d = await (await fetch(base + "/api/readiness")).json();
  assert.equal(d.result.verdict.call, "HOLD");
  assert.equal(d.result.criteria.find((c) => c.id === "p0").effective, "waived");
  assert.equal(d.audit.filter((a) => a.action === "waive").length, 2);
  assert.equal(d.audit[0].by, "Sam Okafor");
});

test("waivers survive on disk", () => {
  const saved = JSON.parse(readFileSync(path.join(dir, "state.demo.json"), "utf8"));
  assert.equal(saved.waivers.p0.approver, "Sam Okafor");
  assert.equal(saved.waivers.p0.statusAtWaive, "fail");
});

test("removing a waiver puts the failure back", async () => {
  const r = await post(base, "/api/unwaive", { id: "p0", by: "Sam Okafor" });
  const d = await r.json();
  assert.equal(d.result.criteria.find((c) => c.id === "p0").effective, "fail");
  assert.equal(d.result.verdict.call, "NO-GO");
});

test("manual checks need a name and a valid state", async () => {
  let r = await post(base, "/api/manual", { checkId: "migration", state: "pass", by: "" });
  assert.equal(r.status, 400);
  r = await post(base, "/api/manual", { checkId: "nope", state: "pass", by: "Hiro" });
  assert.equal(r.status, 404);
  r = await post(base, "/api/manual", { checkId: "migration", state: "pass", by: "Hiro N.", note: "Re-run took 2s" });
  const d = await r.json();
  assert.equal(d.result.criteria.find((c) => c.id === "migration").status, "pass");
});

test("Slack summary is built from the current verdict", async () => {
  const r = await post(base, "/api/notify", { by: "Sam Okafor" });
  assert.equal(r.status, 200);
  assert.match(sent[0].text, /Release 4\.12: NO-GO/);
});

test("path traversal on static files is refused", async () => {
  const r = await fetch(base + "/..%2Fpackage.json");
  assert.equal(r.status, 404);
});

test("live mode end to end against the mock GitHub", async () => {
  const mock = await startMockGithub();
  const liveDir = mkdtempSync(path.join(tmpdir(), "rr-live-"));
  const s = await createApp({
    stateDir: liveDir,
    auth: false,
    defaultMode: "live",
    env: { GITHUB_TOKEN: "t" },
    deps: { fetchGithub: (args) => fetchGithub({ ...args, client: createClient({ token: "t", baseUrl: mock.base }) }) },
  });
  await new Promise((r) => s.server.listen(0, "127.0.0.1", r));
  const b = `http://127.0.0.1:${s.server.address().port}`;
  try {
    const d = await (await fetch(`${b}/api/readiness?repo=acme/web&base=v4.11.0&head=release/4.12`)).json();
    assert.equal(d.mode, "live");
    assert.equal(d.snapshot.sources.jira, "off");
    assert.equal(d.result.criteria.find((c) => c.id === "p0").status, "fail");
    assert.equal(d.result.criteria.find((c) => c.id === "ci").status, "fail");
    assert.equal(d.result.verdict.call, "NO-GO");
    const bad = await fetch(`${b}/api/readiness?repo=not a repo`);
    assert.equal(bad.status, 400);
  } finally {
    s.server.close(); await mock.close(); rmSync(liveDir, { recursive: true, force: true });
  }
});
