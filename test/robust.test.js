import test from "node:test";
import assert from "node:assert/strict";
import { buildSchedule, suggestSlots } from "../src/schedule.js";
import { suggestRaid, cleanRaid, buildRaidView, validateRaidSuggestions } from "../src/raid.js";
import { renderTimeline, renderConflicts, renderClashBanner, viewRange } from "../src/schedule-view.js";
import { renderRaidTable, renderRaidSummary } from "../src/raid-view.js";
import { createAi } from "../src/ai.js";
import { blankPlan, defaultPlan, nextPlan } from "../src/plan.js";

const NOW = new Date(2026, 9, 26, 12, 0).getTime();
// Half-saved or hand-edited plans. Nothing built on saved data may throw on these.
const JUNK = [null, undefined, 0, "", "x", [], {}, [null], { release: null }, { when: "x" }, { when: { deployAt: "garbage", windowHours: "abc" } }, { when: { deployAt: "2026-13-45T99:99" } },
  { release: { name: { a: 1 } }, people: "str", raid: "no" }, { tickets: "no", handoffs: {}, raid: [null, 5, { type: 1 }], raidDismissed: "no" },
  { id: 5, when: { deployAt: "2026-10-30T02:00", windowHours: -5 } }, { when: { deployAt: "2026-10-30T02:00", windowHours: 1e12 } },
  { id: "q", when: { deployAt: "2026-10-30T02:00", freezeAt: "2026-10-30T03:00", meetingAt: "2026-10-30T02:00" } }];
const OK = { ...blankPlan(NOW), id: "ok", when: { ...blankPlan(NOW).when, deployAt: "2026-10-30T02:30" } };
const obj = (j) => (j && typeof j === "object" ? j : {});

test("calendar code survives every kind of junk plan", () => {
  for (const j of JUNK) {
    const s = buildSchedule([j, OK, j], { now: NOW, includeClosed: true });
    assert.doesNotThrow(() => { renderTimeline(s, viewRange(NOW)); renderConflicts(s, { slotsFor: (id) => suggestSlots([j, OK], id, { now: NOW }) }); renderClashBanner(s.conflicts, "ok"); }, JSON.stringify(j));
  }
});

test("RAID code survives every kind of junk plan", () => {
  for (const j of JUNK) {
    assert.doesNotThrow(() => { suggestRaid(obj(j), { now: NOW }); cleanRaid(obj(j).raid); validateRaidSuggestions(j, obj(j)); const v = buildRaidView([j, OK], { now: NOW }); renderRaidTable(v.rows); renderRaidSummary(v.rows); }, JSON.stringify(j));
  }
});

test("AI demo checks survive junk plans, and one bad plan does not stop the schedule check", async () => {
  const ai = createAi({ env: {} });
  for (const j of JUNK) { await ai.schedule([j, OK], NOW); await ai.raid(obj(j)); }
  const half = { id: "half", release: { name: "Half saved" }, tickets: [], when: { deployAt: "2026-10-30T02:00", windowHours: 2 } }; // no scope, people, signals ...
  const r = await ai.schedule([half, { ...OK, release: { name: "OK" } }], NOW);
  assert.equal(r.advice.length, 1);
});

test("nextPlan ignores junk in the RAID list and keeps only open risks and assumptions", () => {
  const p = { ...defaultPlan(NOW), raid: [null, 5, { type: "Risk", status: "Open", title: "keep" }, { type: "Issue", status: "Open", title: "drop" }, { type: "Risk", status: "Closed", title: "drop" }] };
  assert.deepEqual(nextPlan(p, NOW).raid.map((r) => r.title), ["keep"]);
  assert.deepEqual(nextPlan({ ...defaultPlan(NOW), raid: "nope" }, NOW).raid, []);
});
