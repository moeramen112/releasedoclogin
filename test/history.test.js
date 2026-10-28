import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultPlan, blankPlan, nextPlan, generateRunbook, syncHandoffSteps, runbookStatus, isClosed, emptyOutcome, OUTCOMES } from "../src/plan.js";
import { takeSnapshot, applyOutcomeChange, historyRows, historySummary, historyTrends } from "../src/history.js";
import { createJsonStore } from "../src/state.js";
import { createJobs } from "../src/jobs.js";
import { createAgentService } from "../src/agent-service.js";
import { createAi } from "../src/ai.js";

const NOW = Date.UTC(2026, 9, 21, 16);

/* ---------- runbook steps from handoffs ---------- */

const planWith = (handoffs) => { const p = defaultPlan(NOW); p.handoffs = handoffs; p.runbook = generateRunbook(p); return p; };
const H = (what, status, extra = {}) => ({ what, from: "Design", to: "Frontend", owner: "Rin Aoki", due: "2026-10-25T17:00", status, blocks: "", ...extra });

test("handoff steps: one step per open handoff, none for Done, placed with the pre-release steps", () => {
  const p = planWith([H("Final designs", "Done"), H("Test devices", "In progress"), H("API contract", "Not started", { due: "2026-10-23T09:00" })]);
  const before = p.runbook.length;
  const r = syncHandoffSteps(p);
  assert.deepEqual(r, { added: 2, updated: 0 });
  assert.equal(p.runbook.length, before + 2);
  const made = p.runbook.filter((x) => x.handoff);
  assert.deepEqual(made.map((x) => x.step), ["Handoff: API contract (Design to Frontend)", "Handoff: Test devices (Design to Frontend)"], "earliest due first");
  assert.ok(made.every((x) => x.phase === "Pre-release" && x.owner === "Rin Aoki"));
  assert.equal(made.find((x) => /Test devices/.test(x.step)).status, "doing");
  const last = p.runbook.findLastIndex((x) => x.phase === "Pre-release");
  assert.ok(p.runbook.indexOf(made[1]) <= last, "inside the pre-release block");
  assert.equal(new Set(p.runbook.map((x) => x.id)).size, p.runbook.length, "ids stay unique");
});

test("handoff steps: repeatable, follow the handoff's status, and never touch hand-made steps", () => {
  const p = planWith([H("Test devices", "In progress")]);
  p.runbook.push({ id: "s99", phase: "After", step: "Handoff: my own note", owner: "", at: "", status: "todo" });
  const mine = JSON.stringify(p.runbook.filter((x) => !x.handoff));
  syncHandoffSteps(p);
  assert.deepEqual(syncHandoffSteps(p), { added: 0, updated: 0 }, "second run changes nothing");
  p.handoffs[0].status = "Done";
  assert.deepEqual(syncHandoffSteps(p), { added: 0, updated: 1 });
  assert.equal(p.runbook.find((x) => x.handoff).status, "done");
  p.handoffs[0].status = "Blocked";
  syncHandoffSteps(p);
  assert.equal(p.runbook.find((x) => x.handoff).status, "blocked");
  assert.equal(JSON.stringify(p.runbook.filter((x) => !x.handoff)), mine);
});

test("handoff steps: blank handoffs are skipped, missing owner falls back to the release manager, and an overdue step shows in runbook status", () => {
  const p = planWith([H("", "Not started"), H("Late one", "Not started", { owner: "", due: "2020-01-01T10:00" })]);
  p.people.releaseManager = "Maya";
  assert.deepEqual(syncHandoffSteps(p), { added: 1, updated: 0 });
  const s = p.runbook.find((x) => x.handoff);
  assert.equal(s.owner, "Maya");
  assert.ok(runbookStatus(p, NOW).overdue.includes(s.step));
});

test("handoff steps: a plan with no runbook or handoffs fields still works", () => {
  const p = blankPlan(NOW);
  delete p.handoffs; delete p.runbook;
  assert.deepEqual(syncHandoffSteps(p), { added: 0, updated: 0 });
  assert.deepEqual(p.runbook, []);
});

/* ---------- release history ---------- */

test("new, example and next plans all start open with an empty outcome", () => {
  for (const p of [blankPlan(NOW), defaultPlan(NOW), nextPlan({ ...defaultPlan(NOW), outcome: { status: "Rolled back", at: "x", note: "n", snapshot: {} } }, NOW)]) {
    assert.deepEqual(p.outcome, emptyOutcome());
    assert.equal(isClosed(p), false);
  }
});

test("closing records the call and risk at that moment; reopening drops them", () => {
  const p = defaultPlan(NOW);
  p.outcome.status = "Shipped with issues";
  assert.equal(applyOutcomeChange(p, NOW), true);
  assert.equal(isClosed(p), true);
  const s = p.outcome.snapshot;
  assert.equal(s.takenAt, NOW);
  assert.ok(["GO", "HOLD", "NO-GO"].includes(s.call));
  assert.ok(Number.isFinite(s.risk) && s.tickets === p.tickets.length);
  assert.match(p.outcome.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d$/);
  const at = p.outcome.at;
  p.outcome.status = "Rolled back"; // changing the outcome keeps the original snapshot and time
  assert.equal(applyOutcomeChange(p, NOW + 86_400_000), false);
  assert.equal(p.outcome.snapshot.takenAt, NOW);
  assert.equal(p.outcome.at, at);
  p.outcome.status = "";
  assert.equal(applyOutcomeChange(p, NOW), true);
  assert.equal(p.outcome.snapshot, null);
  assert.equal(isClosed(p), false);
  p.outcome.status = "Totally made up"; // not an allowed outcome: ignored, not stored
  applyOutcomeChange(p, NOW);
  assert.equal(p.outcome.status, "");
});

test("takeSnapshot matches the call the engine gives", () => {
  const p = defaultPlan(NOW);
  const s = takeSnapshot(p, NOW);
  assert.equal(s.call, "NO-GO", "the example release has failing required checks");
  assert.ok(s.open > 0);
});

test("history rows keep only closed releases, newest first, and the summary counts them", () => {
  const mk = (id, name, status, at, call) => ({ id, release: { name, version: "1" }, outcome: { status, at, note: `${name} note`, snapshot: call ? { call, risk: 40, riskLevel: "Moderate", waived: 0 } : null }, tickets: [] });
  const plans = [
    mk("a", "Alpha", "Shipped cleanly", "2026-10-01T10:00", "GO"),
    mk("b", "Beta", "Rolled back", "2026-10-10T10:00", "HOLD"),
    mk("c", "Gamma", "Shipped with issues", "2026-10-15T10:00", "NO-GO"),
    mk("d", "Delta", "Cancelled", "2026-10-16T10:00", "NO-GO"),
    mk("e", "Open one", "", "", null),
    null,
  ];
  const rows = historyRows(plans);
  assert.deepEqual(rows.map((r) => r.name), ["Delta", "Gamma", "Beta", "Alpha"]);
  const sum = historySummary(rows);
  assert.deepEqual([sum.total, sum.clean, sum.issues, sum.rolledBack, sum.cancelled], [4, 1, 1, 1, 1]);
  assert.equal(sum.shippedAgainstCall, 2, "Beta and Gamma shipped on HOLD and NO-GO; the cancelled one did not ship");
  assert.deepEqual(sum.byCall, { GO: { shipped: 1, trouble: 0 }, HOLD: { shipped: 1, trouble: 1 }, "NO-GO": { shipped: 1, trouble: 1 } });
  assert.deepEqual(historyRows([]), []);
  assert.equal(historySummary([]).total, 0);
});

test("a release closed without a snapshot (older data) still appears", () => {
  const rows = historyRows([{ id: "x", release: { name: "Old" }, outcome: { status: "Shipped cleanly", at: "", note: "" } }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].call, "");
  assert.equal(rows[0].risk, null);
});

test("OUTCOMES are the four expected values", () => {
  assert.deepEqual(OUTCOMES, ["Shipped cleanly", "Shipped with issues", "Rolled back", "Cancelled"]);
});

/* ---------- closed releases are left alone by the background jobs ---------- */

const config = JSON.parse(await fs.readFile(new URL("../readiness.config.json", import.meta.url), "utf8"));

test("auto-refresh, Slack alerts and Auto agent checks skip a closed release, and resume when it is reopened", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hist-"));
  const relDb = await createJsonStore(path.join(dir, "r.json"), () => ({ releases: {}, audit: [] }));
  const jobsDb = await createJsonStore(path.join(dir, "j.json"), () => ({ releases: {} }));
  const agentDb = await createJsonStore(path.join(dir, "a.json"), () => ({ runs: {}, auto: {}, inbox: [] }));
  const plan = blankPlan(NOW);
  plan.release.name = "R1"; plan.release.fixVersion = "1.0"; plan.release.autoSync = true; plan.release.slackAlerts = true;
  await relDb.mutate((s) => { s.releases.r1 = { id: "r1", plan, version: 1, createdAt: "", createdBy: "t", updatedAt: "", updatedBy: "t" }; });
  const calls = { jira: 0, slack: 0 };
  const env = { JIRA_BASE_URL: "https://x.atlassian.net", JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "t", SLACK_WEBHOOK_URL: "https://hooks.test/x", ALERT_SETTLE_MINUTES: "0", SYNC_MINUTES: "5" };
  const deps = { fetchJiraRelease: async () => { calls.jira++; return []; }, sendSlack: async () => { calls.slack++; } };
  const ai = createAi({ env: {} });
  const agent = createAgentService({ relDb, agentDb, ai, env, deps });
  const jobs = createJobs({ relDb, jobsDb, config, env, deps, agent });
  await agent.setAuto("r1", true, 1);

  await relDb.mutate((s) => { s.releases.r1.plan.outcome = { status: "Shipped cleanly", at: "", note: "", snapshot: null }; });
  await jobs.tick(NOW);
  assert.equal(calls.jira, 0, "no Jira refresh for a closed release");
  assert.equal(agentDb.get().runs.r1, undefined, "no Auto agent check for a closed release");
  assert.equal(jobsDb.get().releases.r1?.lastCall, undefined, "no Slack alert bookkeeping either");

  await relDb.mutate((s) => { s.releases.r1.plan.outcome = emptyOutcome(); });
  await jobs.tick(NOW + 1000);
  assert.equal(calls.jira, 1, "reopened, so it refreshes again");
  assert.equal(agentDb.get().runs.r1.source, "auto");
});

/* ---------- trends ---------- */
const row = (status, call, risk, at) => ({ status, call, risk, at, shipped: ["Shipped cleanly", "Shipped with issues", "Rolled back"].includes(status), trouble: ["Shipped with issues", "Rolled back"].includes(status) });

test("trends: change failure rate, call accuracy, risk by outcome and months", () => {
  const t = historyTrends([
    row("Shipped cleanly", "GO", 10, "2026-08-03T10:00"), row("Shipped cleanly", "GO", 20, "2026-08-20T10:00"),
    row("Shipped with issues", "GO", 50, "2026-09-02T10:00"), row("Rolled back", "NO-GO", 80, "2026-09-15T10:00"),
    row("Shipped cleanly", "HOLD", 40, "2026-09-20T10:00"), row("Cancelled", "HOLD", 70, "2026-09-21T10:00"),
  ]);
  assert.equal(t.shipped, 5); assert.equal(t.trouble, 2); assert.equal(t.changeFailureRate, 40);
  assert.equal(t.judged, 5); assert.equal(t.right, 3); assert.equal(t.callRight, 60); assert.equal(t.missed, 1); assert.equal(t.cautious, 1);
  assert.deepEqual(t.riskByOutcome["Shipped cleanly"], { avg: 23, n: 3 });
  assert.equal(t.riskByOutcome.Cancelled.avg, 70);
  assert.deepEqual(t.months, [{ month: "2026-08", shipped: 2, trouble: 0 }, { month: "2026-09", shipped: 3, trouble: 2 }]);
  assert.equal(t.enough, true);
});

test("trends: empty, thin and odd input never divide by zero or throw", () => {
  for (const bad of [[], null, undefined, "x", [{ status: "Cancelled" }]]) {
    const t = historyTrends(bad);
    assert.equal(t.changeFailureRate, null); assert.equal(t.callRight, null); assert.equal(t.enough, false); assert.deepEqual(t.months, []);
  }
  const one = historyTrends([row("Shipped cleanly", "", null, "not a date")]);
  assert.equal(one.changeFailureRate, 0); assert.equal(one.callRight, null); assert.equal(one.enough, false); assert.deepEqual(one.months, []);
});
