import test from "node:test";
import assert from "node:assert/strict";
import { createAi, buildScheduleFacts, demoSchedule, validateScheduleAdvice } from "../src/ai.js";
import { checkRelease } from "../src/agent.js";
import { buildSchedule, conflictsFor } from "../src/schedule.js";
import { blankPlan } from "../src/plan.js";

const NOW = new Date(2026, 9, 26, 9, 0).getTime();
const mk = (id, name, deployAt, repo = "") => { const p = { ...blankPlan(NOW), id }; p.release = { ...p.release, name }; p.when = { ...p.when, deployAt, windowHours: 2 }; p.where = { ...p.where, repo }; return p; };
const clash = [mk("a", "Alpha", "2026-10-28T02:00"), mk("b", "Beta", "2026-10-28T03:00")];
const calm = [mk("a", "Alpha", "2026-10-28T02:00"), mk("c", "Gamma", "2026-11-04T02:00")];

test("facts: one entry per pair of releases, with free slots, and nothing else from the plans", () => {
  const f = buildScheduleFacts(clash, NOW);
  assert.equal(f.clashes.length, 1);
  assert.deepEqual(f.clashes[0].releases.map((r) => r.id), ["a", "b"]);
  assert.ok(f.clashes[0].releases.every((r) => r.freeSlots.length === 3 && typeof r.call === "string"));
  assert.deepEqual(Object.keys(f.clashes[0].releases[0]).sort(), ["call", "freeSlots", "id", "name"]);
});

test("demo mode: advises moving one release to a free slot, and says so", async () => {
  const r = await createAi({ env: {} }).schedule(clash, NOW);
  assert.equal(r.mode, "demo");
  assert.equal(r.advice.length, 1);
  assert.ok(["a", "b"].includes(r.advice[0].move));
  assert.ok(buildScheduleFacts(clash, NOW).clashes[0].releases.find((x) => x.id === r.advice[0].move).freeSlots.includes(r.advice[0].to));
  assert.ok(r.advice[0].moveName);
});

test("no clashes: no advice and no AI call, even in live mode", async () => {
  let calls = 0;
  const ai = createAi({ env: { ANTHROPIC_API_KEY: "k" }, fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ content: [] }) }; } });
  assert.deepEqual(await ai.schedule(calm, NOW), { mode: "live", advice: [], total: 0 });
  assert.equal(calls, 0);
});

test("live mode: sends facts only, and keeps only advice that points at real releases and offered slots", async () => {
  const f = buildScheduleFacts(clash, NOW), c = f.clashes[0], slot = c.releases[1].freeSlots[1];
  const reply = JSON.stringify([
    { clashId: c.id, move: "b", to: slot, why: "Beta is less ready." },
    { clashId: c.id, move: "zzz", to: slot, why: "unknown release" },
    { clashId: "nope", move: "a", to: slot, why: "unknown clash" },
    { clashId: c.id, move: "a", to: "2030-01-01T00:00", why: "slot we never offered" },
  ]);
  const calls = [];
  const ai = createAi({ env: { ANTHROPIC_API_KEY: "k" }, fetchImpl: async (u, init) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: reply }] }) }; } });
  const r = await ai.schedule(clash, NOW);
  assert.equal(r.mode, "live");
  assert.deepEqual(r.advice.map((a) => [a.move, a.to, a.moveName]), [["b", slot, "Beta"]]);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].messages[0].content.includes("untrusted"));
  assert.ok(!calls[0].messages[0].content.includes("tickets"));
});

test("live mode: junk or failure from the AI does not break the page", async () => {
  const junk = createAi({ env: { ANTHROPIC_API_KEY: "k" }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "sorry" }] }) }) });
  assert.deepEqual((await junk.schedule(clash, NOW)).advice, []);
  const down = createAi({ env: { ANTHROPIC_API_KEY: "k" }, fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) });
  await assert.rejects(() => down.schedule(clash, NOW), /busy|limit/);
});

test("validate and demo helpers handle empty input", () => {
  assert.deepEqual(validateScheduleAdvice(null, { clashes: [] }), []);
  assert.deepEqual(demoSchedule({ clashes: [] }), []);
});

test("agent: a clash makes one chase draft for the release, once", async () => {
  const ai = createAi({ env: {} });
  const clashes = conflictsFor(buildSchedule(clash, { now: NOW }), "a");
  const first = await checkRelease({ plan: clash[0], ai, prev: null, existing: [], clashes, now: NOW });
  const drafts = first.drafts.filter((d) => d.dedupe.startsWith("clash|"));
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].kind, "chase");
  assert.equal(drafts[0].importance, "high");
  assert.match(drafts[0].title, /Schedule clash: Alpha and Beta/);
  const again = await checkRelease({ plan: clash[0], ai, prev: first.snapshot, existing: first.drafts.map((d, i) => ({ ...d, id: "i" + i, status: "open" })), clashes, now: NOW });
  assert.equal(again.drafts.filter((d) => d.dedupe.startsWith("clash|")).length, 0);
  const none = await checkRelease({ plan: clash[0], ai, prev: null, existing: [], now: NOW });
  assert.equal(none.drafts.filter((d) => d.dedupe.startsWith("clash|")).length, 0);
});
