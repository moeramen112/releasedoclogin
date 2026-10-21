import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJsonStore } from "../src/state.js";
import { createJobs } from "../src/jobs.js";
import { mergeTickets, blankPlan } from "../src/plan.js";
import { buildChangeMessage } from "../src/notify.js";

const config = JSON.parse(await fs.readFile(new URL("../readiness.config.json", import.meta.url), "utf8"));
const ENV = { JIRA_BASE_URL: "https://x.atlassian.net", JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "t", SLACK_WEBHOOK_URL: "https://hooks.slack.test/x", ALERT_SETTLE_MINUTES: "2", SYNC_MINUTES: "5" };
const MIN = 60_000;

async function setup({ autoSync = true, slackAlerts = true, issues = [], env = ENV } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jobs-"));
  const relDb = await createJsonStore(path.join(dir, "r.json"), () => ({ releases: {}, audit: [] }));
  const jobsDb = await createJsonStore(path.join(dir, "j.json"), () => ({ releases: {} }));
  const plan = blankPlan(Date.UTC(2026, 9, 21));
  plan.release.name = "R1"; plan.release.fixVersion = "1.0"; plan.release.autoSync = autoSync; plan.release.slackAlerts = slackAlerts;
  await relDb.mutate((s) => { s.releases.r1 = { id: "r1", plan, version: 1, createdAt: "", createdBy: "t", updatedAt: "", updatedBy: "t" }; });
  const state = { issues, sent: [], jira: 0, fail: false };
  const deps = {
    fetchJiraRelease: async () => { state.jira++; if (state.fail) throw new Error("Jira down"); return state.issues; },
    sendSlack: async (url, payload) => { if (state.slackFail) throw new Error("Slack 500"); state.sent.push(payload); },
  };
  const jobs = createJobs({ relDb, jobsDb, config, env, deps });
  return { relDb, jobsDb, jobs, state };
}
const issue = (key, extra = {}) => ({ key, summary: key, type: "Bug", priority: "P0", points: 3, status: "To do", assignee: "", area: "Core", tags: {}, team: "", blockedBy: "", ...extra });

test("mergeTickets is repeatable and keeps tickets Jira does not know", () => {
  const cur = [{ key: "A-1", status: "To do", points: 1, tags: {} }, { key: "HAND-1", status: "To do", points: 1, tags: {} }];
  const rem = [{ key: "a-1", status: "Done", points: 1, tags: {} }, { key: "B-2", status: "To do", points: 2, tags: {} }];
  const a = mergeTickets(cur, rem);
  assert.deepEqual([a.updated, a.added, a.kept], [1, 1, 1]);
  const b = mergeTickets(a.tickets, rem);
  assert.deepEqual([b.updated, b.added, b.kept], [0, 0, 1]);
});

test("auto-refresh pulls tickets, bumps the version, and waits for the interval", async () => {
  const { relDb, jobs, state } = await setup({ issues: [issue("P-1")] });
  await jobs.tick(0);
  assert.equal(state.jira, 1);
  assert.equal(relDb.get().releases.r1.plan.tickets.length, 1);
  assert.equal(relDb.get().releases.r1.version, 2);
  assert.equal(relDb.get().releases.r1.updatedBy, "Jira auto-refresh");
  await jobs.tick(2 * MIN);
  assert.equal(state.jira, 1, "too soon");
  await jobs.tick(6 * MIN);
  assert.equal(state.jira, 2);
  assert.equal(relDb.get().releases.r1.version, 2, "nothing changed, so no new version");
});

test("auto-refresh skips releases that did not opt in, and records Jira errors", async () => {
  const off = await setup({ autoSync: false, issues: [issue("P-1")] });
  await off.jobs.tick(0);
  assert.equal(off.state.jira, 0);
  const bad = await setup({ issues: [] });
  bad.state.fail = true;
  await bad.jobs.tick(0);
  assert.match(bad.jobs.status().r1.lastError, /Jira down/);
});

test("Slack: first look is silent, a change waits to settle, then one message is sent", async () => {
  const { relDb, jobs, state } = await setup({ autoSync: false });
  await jobs.tick(0);
  assert.equal(state.sent.length, 0, "first observation never alerts");
  const first = jobs.status().r1.lastCall;
  await relDb.mutate((s) => { s.releases.r1.plan.tickets.push(issue("P-9")); });
  await jobs.tick(1 * MIN);
  assert.equal(state.sent.length, 0, "still settling");
  const call = jobs.status().r1.pendingCall;
  assert.notEqual(call, first);
  await jobs.tick(4 * MIN);
  assert.equal(state.sent.length, 1);
  assert.match(state.sent[0].text, new RegExp(`from ${first} to ${call}`));
  await jobs.tick(9 * MIN);
  assert.equal(state.sent.length, 1, "no repeat");
});

test("Slack: a call that flips back before settling sends nothing", async () => {
  const { relDb, jobs, state } = await setup({ autoSync: false });
  await jobs.tick(0);
  await relDb.mutate((s) => { s.releases.r1.plan.tickets.push(issue("P-9")); });
  await jobs.tick(1 * MIN);
  await relDb.mutate((s) => { s.releases.r1.plan.tickets = []; });
  await jobs.tick(2 * MIN);
  await jobs.tick(10 * MIN);
  assert.equal(state.sent.length, 0);
});

test("Slack: off per release, and a failed send is retried", async () => {
  const off = await setup({ autoSync: false, slackAlerts: false });
  await off.jobs.tick(0);
  await off.relDb.mutate((s) => { s.releases.r1.plan.tickets.push(issue("P-9")); });
  await off.jobs.tick(10 * MIN);
  assert.equal(off.state.sent.length, 0);

  const { relDb, jobs, state } = await setup({ autoSync: false });
  await jobs.tick(0);
  await relDb.mutate((s) => { s.releases.r1.plan.tickets.push(issue("P-9")); });
  await jobs.tick(1 * MIN);
  state.slackFail = true;
  await jobs.tick(5 * MIN);
  assert.equal(state.sent.length, 0);
  assert.match(jobs.status().r1.alertError, /Slack 500/);
  state.slackFail = false;
  await jobs.tick(6 * MIN);
  assert.equal(state.sent.length, 1);
});

test("change message names both calls", () => {
  const result = { verdict: { call: "HOLD", reason: "Waiting on QA.", holding: [] }, criteria: [] };
  const m = buildChangeMessage({ release: { name: "R1" }, from: "GO", result, dashboardUrl: "https://x/plan.html" });
  assert.match(m.text, /from GO to HOLD/);
  assert.match(m.blocks[0].text.text, /GO.*HOLD/);
});
