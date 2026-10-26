import test from "node:test";
import assert from "node:assert/strict";
import { RAID_TYPES, RAID_STATUS, SOURCES, emptyRaid, cleanRaid, isOverdue, summarizeRaid, suggestRaid, acceptSuggestion, validateRaidSuggestions, buildRaidView } from "../src/raid.js";
import { defaultPlan, blankPlan } from "../src/plan.js";

const NOW = new Date(2026, 9, 22, 12, 0).getTime();
const item = (o = {}) => ({ ...emptyRaid("Risk", NOW), title: "T", ...o });

test("emptyRaid: each type starts with its first status; unknown type becomes Risk", () => {
  for (const t of RAID_TYPES) assert.equal(emptyRaid(t, NOW).status, RAID_STATUS[t][0]);
  assert.equal(emptyRaid("Nonsense", NOW).type, "Risk");
  assert.notEqual(emptyRaid("Risk", NOW).id, emptyRaid("Risk", NOW).id);
});

test("cleanRaid: drops junk, trims, and falls back on bad values", () => {
  const out = cleanRaid([null, "x", { type: "Issue", title: "  a   b ", status: "Confirmed", rating: "Huge", owner: 5 }, { type: "Assumption", status: "Wrong" }]);
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].title, out[0].status, out[0].rating, out[0].owner], ["a b", "Open", "Medium", "5"]); // "Confirmed" is not an Issue status
  assert.equal(out[1].status, "Wrong");
  assert.deepEqual(cleanRaid(undefined), []);
});

test("overdue: only open items with a past due date", () => {
  assert.equal(isOverdue(item({ due: "2026-10-20T09:00" }), NOW), true);
  assert.equal(isOverdue(item({ due: "2026-10-20T09:00", status: "Closed" }), NOW), false);
  assert.equal(isOverdue(item({ due: "2026-10-25T09:00" }), NOW), false);
  assert.equal(isOverdue(item({ due: "" }), NOW), false);
});

test("summary counts open items by type, high, overdue, no owner and closed", () => {
  const s = summarizeRaid([item({ rating: "High", owner: "A", due: "2026-10-01T00:00" }), item({ type: "Issue", status: "Open" }), item({ status: "Closed" })], NOW);
  assert.deepEqual([s.open, s.byType.Risk, s.byType.Issue, s.high, s.overdue, s.noOwner, s.closed], [2, 1, 1, 1, 1, 1, 1]);
});

test("suggestions from the example release: bugs, handoffs, risks, all with stable sources, high first", () => {
  const p = defaultPlan(NOW);
  const s = suggestRaid(p, { now: NOW });
  assert.ok(s.length >= 4);
  assert.ok(s.some((x) => x.type === "Issue" && x.source.startsWith("bug|")));
  assert.ok(s.some((x) => x.type === "Dependency"));
  assert.ok(s.every((x) => RAID_TYPES.includes(x.type) && x.source && x.title));
  assert.equal(new Set(s.map((x) => x.source)).size, s.length, "no duplicates");
  assert.ok(s.every((x) => !x.title.includes("[object")), "titles are readable text");
  assert.ok(suggestRaid(p, { now: NOW, max: 100 }).some((x) => /^REL-\d+ waits on /.test(x.title)));
  const ranks = s.map((x) => ["High", "Medium", "Low"].indexOf(x.rating));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});

test("accepting or dismissing removes a suggestion for good", () => {
  const p = defaultPlan(NOW);
  const first = suggestRaid(p, { now: NOW, max: 100 });
  p.raid = [acceptSuggestion(first[0], NOW)];
  p.raidDismissed = [first[1].source];
  const next = suggestRaid(p, { now: NOW, max: 100 });
  assert.ok(!next.some((x) => x.source === first[0].source || x.source === first[1].source));
  assert.equal(next.length, first.length - 2);
  assert.equal(p.raid[0].status, RAID_STATUS[first[0].type][0]);
});

test("schedule clashes become risk suggestions; low ones do not", () => {
  const p = blankPlan(NOW);
  const s = suggestRaid(p, { now: NOW, clashes: [{ id: "overlap|a|b", severity: "high", text: "A and B overlap." }, { id: "meetingClash|a|b", severity: "low", text: "Meetings." }] });
  assert.deepEqual(s.filter((x) => x.source.startsWith("clash|")).map((x) => x.source), ["clash|overlap|a|b"]);
});

test("a broken source does not stop the others, and a new source can be added", () => {
  const p = blankPlan(NOW);
  SOURCES.push({ id: "boom", build() { throw new Error("x"); } }, { id: "mine", build: () => [{ type: "Risk", title: "Mine", source: "mine|1", rating: "Low", response: "", owner: "", due: "" }] });
  try { assert.ok(suggestRaid(p, { now: NOW }).some((x) => x.source === "mine|1")); } finally { SOURCES.length -= 2; }
});

test("AI suggestions: only valid types, real text, no repeats, capped", () => {
  const p = blankPlan(NOW);
  const raw = [{ type: "Risk", title: "Vendor API may rate-limit us", rating: "High" }, { type: "Risk", title: "vendor api may rate-limit us" }, { type: "Whatever", title: "x" }, { type: "Issue", title: "" }, null, { type: "Assumption", title: "QA has a device lab", rating: "Huge" }];
  const out = validateRaidSuggestions(raw, p);
  assert.deepEqual(out.map((x) => [x.type, x.rating]), [["Risk", "High"], ["Assumption", "Medium"]]);
  assert.equal(validateRaidSuggestions(Array.from({ length: 20 }, (_, i) => ({ type: "Risk", title: "r" + i })), p).length, 8);
  assert.deepEqual(validateRaidSuggestions("nope", p), []);
});

test("across releases: overdue first, then rating; closed items and closed releases hidden by default", () => {
  const a = { ...blankPlan(NOW), id: "a", release: { name: "Alpha" }, raid: [item({ title: "low", rating: "Low" }), item({ title: "late", rating: "Low", due: "2026-10-01T00:00", owner: "Zed" }), item({ title: "done", status: "Closed" })] };
  const b = { ...blankPlan(NOW), id: "b", release: { name: "Beta" }, raid: [item({ title: "hi", rating: "High", owner: "Amy" })] };
  const c = { ...blankPlan(NOW), id: "c", release: { name: "Gamma" }, outcome: { status: "Rolled back" }, raid: [item({ title: "old" })] };
  const v = buildRaidView([a, b, c], { now: NOW });
  assert.deepEqual(v.rows.map((r) => r.title), ["late", "hi", "low"]);
  assert.deepEqual(v.owners, ["Amy", "Zed"]);
  assert.equal(v.rows[0].releaseName, "Alpha");
  assert.equal(buildRaidView([a, b, c], { now: NOW, includeClosed: true }).rows.length, 5);
});
