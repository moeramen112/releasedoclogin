import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJsonStore } from "../src/state.js";
import { createAi } from "../src/ai.js";
import { checkRelease, diffSnapshots, snapshotOf, trimInbox, newItem } from "../src/agent.js";
import { createAgentService } from "../src/agent-service.js";
import { defaultPlan } from "../src/plan.js";

const NOW = Date.UTC(2026, 9, 22, 16);
const HOUR = 3_600_000;
const ai = createAi({ env: {} });
const clone = (o) => JSON.parse(JSON.stringify(o));
const asItems = (drafts, status = "open") => drafts.map((d, i) => ({ ...d, id: "i" + i + Math.random(), status }));

test("first check: saves a starting point and drafts an update, a chase note and suggestions", async () => {
  const r = await checkRelease({ plan: defaultPlan(NOW), ai, prev: null, existing: [], now: NOW });
  assert.equal(r.first, true);
  assert.equal(r.changes.length, 0, "nothing to compare with yet");
  const kinds = r.drafts.map((d) => d.kind);
  assert.ok(kinds.includes("slack") && kinds.includes("chase") && kinds.includes("suggestion"));
  assert.match(r.drafts.find((d) => d.kind === "chase").text, /overdue/);
});

test("later checks: notice moves, new P0s and call changes, and stay quiet when nothing changed", async () => {
  const p = defaultPlan(NOW);
  const a = await checkRelease({ plan: p, ai, prev: null, existing: [], now: NOW });
  const same = await checkRelease({ plan: p, ai, prev: a.snapshot, existing: asItems(a.drafts), now: NOW + HOUR });
  assert.equal(same.quiet, true);
  assert.equal(same.drafts.length, 0);

  const p2 = clone(p);
  p2.tickets.find((t) => t.key === "REL-2841").status = "In progress"; // moved backward
  p2.tickets.push({ key: "REL-9999", summary: "Payment crash on checkout", type: "Bug", priority: "P0", points: 2, status: "To do", assignee: "", area: "Payments", team: "Backend", blockedBy: "", tags: {} });
  const b = await checkRelease({ plan: p2, ai, prev: a.snapshot, existing: asItems(a.drafts), now: NOW + 2 * HOUR });
  const text = b.changes.map((c) => c.text).join("\n");
  assert.match(text, /REL-2841 moved from In review to In progress/);
  assert.match(text, /New ticket REL-9999 \(P0\)/);
  assert.equal(b.changes[0].importance, "high");
  const slack = b.drafts.filter((d) => d.kind === "slack");
  assert.equal(slack.length, 1);
  assert.match(slack[0].text, /Since the last check/);
});

test("diff: call change, handoff overdue, date moves, and forward moves are rated sensibly", () => {
  const base = snapshotOf(defaultPlan(NOW), NOW);
  const cur = clone(base);
  cur.call = "GO"; base.call = "HOLD";
  cur.tickets["REL-2903"].status = "Done";
  cur.dates.deploy = "2026-11-01T02:00";
  cur.handoffs[Object.keys(cur.handoffs)[0]].overdue = true;
  base.handoffs[Object.keys(base.handoffs)[0]].overdue = false;
  const d = diffSnapshots(base, cur);
  const by = (k) => d.find((c) => c.kind === k);
  assert.equal(by("call").importance, "high");
  assert.equal(by("handoff-overdue").importance, "high");
  assert.equal(by("date").importance, "high");
  const move = by("ticket-move");
  assert.ok(move && move.importance !== "high", "moving forward is not an alarm");
  assert.deepEqual(diffSnapshots(null, cur), []);
});

test("drafts are never made twice, and decided suggestions do not come back", async () => {
  const p = defaultPlan(NOW);
  const a = await checkRelease({ plan: p, ai, prev: null, existing: [], now: NOW });
  const sug = a.drafts.find((d) => d.kind === "suggestion");
  assert.ok(sug);
  const existing = asItems(a.drafts, "dismissed");
  const b = await checkRelease({ plan: p, ai, prev: null, existing, now: NOW + HOUR });
  assert.ok(!b.drafts.some((d) => d.kind === "suggestion"), "a dismissed suggestion stays dismissed");
  assert.ok(!b.drafts.some((d) => d.kind === "chase"), "the same overdue handoff is not chased twice");
});

test("an open suggestion expires when the plan no longer needs it", async () => {
  const p = defaultPlan(NOW);
  const a = await checkRelease({ plan: p, ai, prev: null, existing: [], now: NOW });
  const items = asItems(a.drafts);
  const p2 = clone(p);
  p2.handoffs.push({ what: "Backend to Frontend handoff", from: "Backend", to: "Frontend", owner: "", due: "", status: "Not started", blocks: "REL-2750, REL-2744" });
  const b = await checkRelease({ plan: p2, ai, prev: a.snapshot, existing: items, now: NOW + HOUR });
  const handoffSug = items.find((i) => i.kind === "suggestion" && i.suggestion.kind === "handoff");
  assert.ok(handoffSug && b.expire.includes(handoffSug.id));
});

test("low-confidence team guesses stay out of the Inbox", async () => {
  const r = await checkRelease({ plan: defaultPlan(NOW), ai, prev: null, existing: [], now: NOW });
  assert.ok(!r.drafts.some((d) => d.suggestion?.kind === "team"));
});

test("the Inbox is bounded and drops the oldest decided items first", () => {
  const mk = (n, status, at) => ({ ...newItem("r", "R", { kind: "chase", title: "t" + n, dedupe: "d" + n }, "manual", at), status, decidedAt: at });
  const items = [mk(0, "open", 1), ...Array.from({ length: 305 }, (_, i) => mk(i + 1, "done", i + 10))];
  const out = trimInbox(items);
  assert.equal(out.length, 300);
  assert.ok(out.some((i) => i.title === "t0"), "open items are never dropped");
});

/* ---------- the service ---------- */

async function setup(env = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-"));
  const relDb = await createJsonStore(path.join(dir, "r.json"), () => ({ releases: {}, audit: [] }));
  const agentDb = await createJsonStore(path.join(dir, "a.json"), () => ({ runs: {}, auto: {}, inbox: [] }));
  const sent = [];
  const svc = createAgentService({ relDb, agentDb, ai, env, deps: { sendSlack: async (url, body) => { if (env.FAIL) throw new Error("Slack 500"); sent.push({ url, body }); } } });
  await relDb.mutate((s) => { s.releases.r1 = { id: "r1", plan: defaultPlan(NOW), version: 1, createdAt: "", createdBy: "t", updatedAt: "", updatedBy: "t" }; });
  return { relDb, agentDb, svc, sent };
}

test("service: check, then act on items (edit, post, done, dismiss, applied)", async () => {
  const { svc, sent } = await setup({ SLACK_WEBHOOK_URL: "https://hooks.test/x" });
  const v = await svc.run("r1", "manual", "Maya", NOW);
  assert.equal(v.run.first, true);
  const slack = v.items.find((i) => i.kind === "slack"), chase = v.items.find((i) => i.kind === "chase"), sug = v.items.find((i) => i.kind === "suggestion");
  await svc.act(slack.id, "edit", "My own words", "Maya");
  await svc.act(slack.id, "send", undefined, "Maya");
  assert.equal(sent[0].body.text, "My own words");
  await assert.rejects(svc.act(slack.id, "send", undefined, "Maya"), /already handled/);
  await assert.rejects(svc.act(chase.id, "send", undefined, "Maya"), /Only Slack drafts/);
  await svc.act(chase.id, "done", undefined, "Maya");
  await assert.rejects(svc.act(sug.id, "edit", "x", "Maya"), /cannot be edited/);
  await assert.rejects(svc.act(chase.id, "applied", undefined, "Maya"), /already handled/);
  await svc.act(sug.id, "applied", undefined, "Maya");
  const after = svc.view("r1");
  assert.equal(after.items.filter((i) => i.status === "open").length, svc.inbox().openCount);
  const done = svc.inbox().items.find((i) => i.id === slack.id);
  assert.equal(done.status, "sent");
  assert.equal(done.decidedBy, "Maya");
});

test("service: posting needs Slack set up, and a Slack failure leaves the item open", async () => {
  const none = await setup({});
  const v = await none.svc.run("r1", "manual", "Maya", NOW);
  await assert.rejects(none.svc.act(v.items.find((i) => i.kind === "slack").id, "send", undefined, "Maya"), /not configured/);
  const bad = await setup({ SLACK_WEBHOOK_URL: "https://hooks.test/x", FAIL: "1" });
  const w = await bad.svc.run("r1", "manual", "Maya", NOW);
  const id = w.items.find((i) => i.kind === "slack").id;
  await assert.rejects(bad.svc.act(id, "send", undefined, "Maya"), /Slack 500/);
  assert.equal(bad.svc.inbox().items.find((i) => i.id === id).status, "open");
});

test("service: Auto runs on its schedule, never more than the daily cap, and only drafts", async () => {
  const { svc, sent, agentDb } = await setup({ SLACK_WEBHOOK_URL: "https://hooks.test/x", AGENT_PER_DAY: "2" });
  await svc.autoTick(NOW);
  assert.equal(agentDb.get().runs.r1, undefined, "off by default");
  await svc.setAuto("r1", true, 1);
  await svc.autoTick(NOW);
  assert.equal(agentDb.get().runs.r1.source, "auto");
  await svc.autoTick(NOW + 30 * 60_000);
  assert.equal(agentDb.get().runs.r1.at, NOW, "too soon");
  await svc.autoTick(NOW + 61 * 60_000);
  assert.equal(agentDb.get().runs.r1.at, NOW + 61 * 60_000);
  await svc.autoTick(NOW + 125 * 60_000);
  assert.equal(agentDb.get().runs.r1.at, NOW + 61 * 60_000, "daily cap of 2 reached");
  assert.equal(sent.length, 0, "Auto never posts to Slack by itself");
  assert.equal(svc.view("r1").auto.on, true);
});

test("service: an unknown release and a double run are refused", async () => {
  const { svc } = await setup({});
  await assert.rejects(svc.run("nope", "manual", "x"), /No such release/);
  await assert.rejects(svc.setAuto("nope", true, 4), /No such release/);
  const a = svc.run("r1", "manual", "x", NOW);
  await assert.rejects(svc.run("r1", "manual", "x", NOW), /already running/);
  await a;
});

test("service: a newer Slack update replaces an older one nobody has sent", async () => {
  const { svc, relDb } = await setup({});
  const v1 = await svc.run("r1", "manual", "Maya", NOW);
  const first = v1.items.find((i) => i.kind === "slack");
  await relDb.mutate((s) => { s.releases.r1.plan.tickets.find((t) => t.key === "REL-2841").status = "To do"; });
  const v2 = await svc.run("r1", "manual", "Maya", NOW + HOUR);
  const open = v2.items.filter((i) => i.kind === "slack" && i.status === "open");
  assert.equal(open.length, 1);
  assert.notEqual(open[0].id, first.id);
  assert.equal(svc.inbox().items.find((i) => i.id === first.id).outcome, "Replaced by a newer update");
});
