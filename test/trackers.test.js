import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTrackers, checkTracker, jiraTracker } from "../src/trackers.js";
import { createJsonStore } from "../src/state.js";
import { createJobs } from "../src/jobs.js";
import { blankPlan } from "../src/plan.js";
import { createApp } from "../src/server.js";
import { mapStatus, fetchJiraRelease } from "../src/sources/jira.js";

const config = JSON.parse(await fs.readFile(new URL("../readiness.config.json", import.meta.url), "utf8"));
const ticket = (key, extra = {}) => ({ key, summary: key, type: "Task", priority: "P1", points: 2, status: "To do", assignee: "", area: "Core", team: "", blockedBy: "", tags: {}, ...extra });
const linear = { id: "linear", label: "Linear", versionLabel: "cycle", needs: "LINEAR_API_KEY", configured: (env) => Boolean(env.LINEAR_API_KEY), fetchTickets: async ({ version }) => [ticket("LIN-1", { summary: `from cycle ${version}` })] };

test("checkTracker names exactly what is wrong", () => {
  assert.throws(() => checkTracker(null), /must be an object/);
  assert.throws(() => checkTracker({ ...linear, id: "" }), /missing "id"/);
  assert.throws(() => checkTracker({ ...linear, id: "Bad Id" }), /lowercase/);
  assert.throws(() => checkTracker({ ...linear, configured: true }), /configured\(env\)/);
  assert.throws(() => checkTracker({ ...linear, fetchTickets: null }), /fetchTickets/);
  assert.equal(checkTracker(linear), linear);
});

test("the registry has Jira built in, takes extra trackers, and never lists secrets", () => {
  const t = createTrackers([linear]);
  assert.equal(t.get("jira").label, "Jira");
  assert.equal(t.get(undefined).id, "jira"); // no tracker named means Jira, as before
  assert.equal(t.get("linear").label, "Linear");
  assert.equal(t.get("nope"), null);
  const list = t.list({ LINEAR_API_KEY: "secret-key", JIRA_API_TOKEN: "secret-token" });
  assert.deepEqual(list.map((x) => [x.id, x.configured]), [["jira", false], ["linear", true]]);
  assert.ok(!JSON.stringify(list).includes("secret"));
  assert.equal(createTrackers([{ ...linear, id: "jira", label: "Jira (custom)" }]).get("jira").label, "Jira (custom)"); // an extra can replace a built-in
  assert.throws(() => createTrackers([{ id: "x" }]));
});

test("the Jira tracker is the same fetcher as before", async () => {
  assert.equal(jiraTracker.configured({ JIRA_BASE_URL: "u", JIRA_EMAIL: "e", JIRA_API_TOKEN: "t" }), true);
  assert.equal(jiraTracker.configured({}), false);
  const f = async () => ({ ok: true, status: 200, json: async () => ({ issues: [], isLast: true }) });
  assert.deepEqual(await jiraTracker.fetchTickets({ version: "1", config, env: { JIRA_BASE_URL: "https://a.b", JIRA_EMAIL: "e", JIRA_API_TOKEN: "t" }, fetchImpl: f }), []);
});

test("Jira statusMap and typeMap let a site with its own workflow map without code changes", async () => {
  assert.equal(mapStatus({ name: "Ready for QA", statusCategory: { key: "indeterminate" } }), "In review"); // default rule
  assert.equal(mapStatus({ name: "Awaiting Sign-off", statusCategory: { key: "indeterminate" } }), "In progress");
  assert.equal(mapStatus({ name: "Awaiting Sign-off", statusCategory: { key: "indeterminate" } }, { "Awaiting Sign-off": "In review" }), "In review");
  assert.equal(mapStatus({ name: "constructor", statusCategory: { key: "new" } }, {}), "To do"); // a status named like an Object method is not a mapping
  const page = { issues: [{ key: "J-1", fields: { summary: "s", issuetype: { name: "Spike" }, priority: { name: "High" }, status: { name: "Awaiting Sign-off", statusCategory: { key: "indeterminate" } }, components: [], labels: [] } }], isLast: true };
  const out = await fetchJiraRelease({ version: "1", config: { jira: { statusMap: { "Awaiting Sign-off": "In review" }, typeMap: { Spike: "Story" } } }, env: { JIRA_BASE_URL: "https://a.b", JIRA_EMAIL: "e", JIRA_API_TOKEN: "t" }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => page }) });
  assert.deepEqual([out[0].status, out[0].type], ["In review", "Story"]);
});

async function boot(env, deps = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trk-"));
  const app = await createApp({ stateDir: dir, defaultMode: "demo", env, auth: false, deps });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

test("GET /api/tickets works for any tracker, and the old /api/jira/issues address still works", async () => {
  const { app, base } = await boot({ LINEAR_API_KEY: "k", JIRA_BASE_URL: "https://a.b", JIRA_EMAIL: "e", JIRA_API_TOKEN: "t" }, { trackers: [linear], fetchJiraRelease: async ({ version }) => [ticket("JIRA-1", { summary: version })] });
  try {
    const j = (p) => fetch(base + p).then(async (r) => [r.status, await r.json()]);
    let [st, b] = await j("/api/tickets?tracker=linear&version=Q4");
    assert.equal(st, 200); assert.equal(b.tracker, "linear"); assert.equal(b.issues[0].summary, "from cycle Q4");
    [st, b] = await j("/api/tickets?version=4.12"); // no tracker named: Jira
    assert.equal(b.tracker, "jira"); assert.equal(b.issues[0].summary, "4.12");
    [st, b] = await j("/api/jira/issues?version=4.12");
    assert.equal(st, 200); assert.equal(b.issues[0].key, "JIRA-1"); assert.equal(b.version, "4.12");
    [st, b] = await j("/api/tickets?tracker=nope&version=1"); assert.equal(st, 400); assert.match(b.error, /not set up/);
    [st, b] = await j("/api/tickets?tracker=linear"); assert.equal(st, 400); assert.match(b.error, /Enter the Linear cycle first/);
    [st, b] = await j("/api/tickets?tracker=constructor&version=1"); assert.equal(st, 400);
    const cfg = await (await fetch(base + "/api/config")).json();
    assert.deepEqual(cfg.integrations.trackers.map((t) => t.id), ["jira", "linear"]);
    assert.equal(cfg.integrations.jira, true); // the old flag is still there
  } finally { app.server.close(); }
});

test("a tracker that is not set up says what to set, and one that fails gives a clean 502", async () => {
  const { app, base } = await boot({}, { trackers: [linear, { ...linear, id: "broken", label: "Broken", configured: () => true, fetchTickets: async () => { throw new Error("tracker said no"); } }] });
  try {
    let r = await fetch(base + "/api/tickets?tracker=linear&version=1"); assert.equal(r.status, 400); assert.match((await r.json()).error, /Set LINEAR_API_KEY on the server/);
    r = await fetch(base + "/api/jira/issues?version=1"); assert.equal(r.status, 400); assert.match((await r.json()).error, /Jira is not configured. Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN on the server/);
    r = await fetch(base + "/api/tickets?tracker=broken&version=1"); assert.equal(r.status, 502); assert.equal((await r.json()).error, "tracker said no");
  } finally { app.server.close(); }
});

test("auto-refresh uses the release's own tracker", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trkj-"));
  const relDb = await createJsonStore(path.join(dir, "r.json"), () => ({ releases: {}, audit: [] }));
  const jobsDb = await createJsonStore(path.join(dir, "j.json"), () => ({ releases: {} }));
  const mk = (tracker) => { const p = blankPlan(Date.UTC(2026, 9, 21)); Object.assign(p.release, { name: tracker || "jira", fixVersion: "1", autoSync: true, slackAlerts: false, ...(tracker ? { tracker } : {}) }); return p; };
  await relDb.mutate((s) => { for (const [id, t] of [["a", "linear"], ["b", "unknown"]]) s.releases[id] = { id, plan: mk(t), version: 1, createdAt: "", createdBy: "t", updatedAt: "", updatedBy: "t" }; });
  const jobs = createJobs({ relDb, jobsDb, config, env: { LINEAR_API_KEY: "k" }, deps: { trackers: [linear] } });
  await jobs.tick(0);
  assert.equal(relDb.get().releases.a.plan.tickets[0].key, "LIN-1");
  assert.equal(relDb.get().releases.a.updatedBy, "Linear auto-refresh");
  assert.equal(relDb.get().releases.b.plan.tickets.length, 0, "an unknown tracker is skipped, not a crash");
});
