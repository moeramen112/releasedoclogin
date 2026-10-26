import test from "node:test";
import assert from "node:assert/strict";
import { blankPlan, defaultPlan } from "../src/plan.js";
import { parseLocal } from "../src/risk.js";
import { buildSchedule, conflictsFor, otherSide, suggestSlots, clashesBetween, toItem, CHECKS, DEFAULT_RULES } from "../src/schedule.js";

const NOW = parseLocal("2026-10-20T12:00"); // a Tuesday

/** A release with the dates, people and repo you give it. Only what a test cares about is set. */
function rel(id, name, { deploy, freeze, meeting, hours = 2, repo = "", people = {}, outcome } = {}) {
  const p = blankPlan(NOW);
  p.id = id;
  p.release.name = name;
  p.when = { freezeAt: freeze ?? "", meetingAt: meeting ?? "", deployAt: deploy ?? "", windowHours: hours };
  p.where.repo = repo;
  Object.assign(p.people, people);
  if (outcome) p.outcome.status = outcome;
  return p;
}
const kinds = (s) => s.conflicts.map((c) => c.kind);

test("overlapping deploy windows are a high clash, and are not also reported as too close", () => {
  const s = buildSchedule([rel("a", "A", { deploy: "2026-10-27T02:00", hours: 3 }), rel("b", "B", { deploy: "2026-10-27T04:00" })], { now: NOW });
  assert.deepEqual(kinds(s), ["overlap"]);
  assert.equal(s.conflicts[0].severity, "high");
  assert.match(s.conflicts[0].text, /A and B are both deploying/);
});

test("deploys closer than the buffer are too close; further apart are fine", () => {
  const near = buildSchedule([rel("a", "A", { deploy: "2026-10-27T02:00" }), rel("b", "B", { deploy: "2026-10-27T10:00" })], { now: NOW });
  assert.deepEqual(kinds(near), ["tooClose"]);
  assert.match(near.conflicts[0].text, /6 hours apart/);
  const far = buildSchedule([rel("a", "A", { deploy: "2026-10-27T02:00" }), rel("b", "B", { deploy: "2026-10-28T02:00" })], { now: NOW });
  assert.deepEqual(kinds(far), []);
});

test("the same person on two close deploys is double-booked, even in different roles, and a different person is not", () => {
  const a = rel("a", "A", { deploy: "2026-10-27T02:00", people: { sre: "Hiro N." } });
  const same = rel("b", "B", { deploy: "2026-10-27T20:00", people: { sre: "hiro n." } });
  assert.deepEqual(kinds(buildSchedule([a, same], { now: NOW })), ["sharedPeople"]);
  const swapped = rel("c", "C", { deploy: "2026-10-27T20:00", people: { releaseManager: "Hiro N." } });
  assert.deepEqual(kinds(buildSchedule([a, swapped], { now: NOW })), ["sharedPeople"]);
  const other = rel("d", "D", { deploy: "2026-10-27T20:00", people: { sre: "Someone Else" } });
  assert.deepEqual(kinds(buildSchedule([a, other], { now: NOW })), []);
  const blank = rel("e", "E", { deploy: "2026-10-27T20:00" });
  assert.deepEqual(kinds(buildSchedule([rel("f", "F", { deploy: "2026-10-27T02:00" }), blank], { now: NOW })), [], "two empty names are not the same person");
});

test("a deploy inside another release's freeze on the same repo is a clash; another repo or no repo is not", () => {
  const frozen = rel("a", "Frozen", { repo: "acme/web", freeze: "2026-10-26T09:00", deploy: "2026-10-30T02:00" });
  const inside = rel("b", "Inside", { repo: "Acme/Web", deploy: "2026-10-28T02:00" });
  const s = buildSchedule([frozen, inside], { now: NOW });
  assert.deepEqual(kinds(s), ["freezeClash"]);
  assert.match(s.conflicts[0].text, /Inside deploys .* while Frozen is frozen/);
  assert.deepEqual(kinds(buildSchedule([frozen, rel("c", "Elsewhere", { repo: "acme/api", deploy: "2026-10-28T02:00" })], { now: NOW })), []);
  assert.deepEqual(kinds(buildSchedule([rel("d", "NoRepo1", { freeze: "2026-10-26T09:00", deploy: "2026-10-30T02:00" }), rel("e", "NoRepo2", { deploy: "2026-10-28T02:00" })], { now: NOW })), []);
});

test("go/no-go meetings close together clash only when they share a release manager", () => {
  const m = (id, who, at) => rel(id, id.toUpperCase(), { deploy: id === "a" ? "2026-11-03T02:00" : "2026-11-10T02:00", meeting: at, people: { releaseManager: who } });
  assert.deepEqual(kinds(buildSchedule([m("a", "Maya", "2026-10-30T14:00"), m("b", "Maya", "2026-10-30T14:30")], { now: NOW })), ["meetingClash"]);
  assert.deepEqual(kinds(buildSchedule([m("a", "Maya", "2026-10-30T14:00"), m("b", "Sam", "2026-10-30T14:30")], { now: NOW })), []);
  assert.deepEqual(kinds(buildSchedule([m("a", "Maya", "2026-10-30T14:00"), m("b", "Maya", "2026-10-30T16:00")], { now: NOW })), []);
});

test("conflicts are sorted most serious first, then by time", () => {
  const plans = [
    rel("a", "A", { deploy: "2026-10-27T02:00", people: { sre: "Hiro" } }),
    rel("b", "B", { deploy: "2026-10-27T03:00" }),
    rel("c", "C", { deploy: "2026-10-27T20:00", people: { sre: "Hiro" } }),
  ];
  const s = buildSchedule(plans, { now: NOW });
  assert.equal(s.conflicts[0].severity, "high");
  const sev = s.conflicts.map((c) => c.severity);
  assert.deepEqual(sev, [...sev].sort((x, y) => ({ high: 0, medium: 1, low: 2 }[x] - { high: 0, medium: 1, low: 2 }[y])));
});

test("closed releases and releases with no deploy date never clash; unscheduled ones are listed", () => {
  const s = buildSchedule([rel("a", "A", { deploy: "2026-10-27T02:00" }), rel("b", "B", { deploy: "2026-10-27T02:00", outcome: "Shipped cleanly" }), rel("c", "C", {})], { now: NOW });
  assert.deepEqual(kinds(s), []);
  assert.deepEqual(s.rows.map((r) => r.id), ["a"]);
  assert.deepEqual(s.unscheduled.map((r) => r.id), ["c"]);
  assert.deepEqual(buildSchedule([rel("a", "A", { deploy: "2026-10-27T02:00" }), rel("b", "B", { deploy: "2026-10-27T02:00", outcome: "Rolled back" })], { now: NOW, includeClosed: true }).rows.map((r) => r.id).sort(), ["a", "b"]);
});

test("rules can be changed or switched off without touching the checks", () => {
  const plans = [rel("a", "A", { deploy: "2026-10-27T02:00" }), rel("b", "B", { deploy: "2026-10-27T10:00" })];
  assert.deepEqual(kinds(buildSchedule(plans, { now: NOW })), ["tooClose"]);
  assert.deepEqual(kinds(buildSchedule(plans, { now: NOW, rules: { bufferHours: 4 } })), []);
  assert.deepEqual(kinds(buildSchedule(plans, { now: NOW, rules: { enabled: { tooClose: false } } })), []);
  assert.equal(DEFAULT_RULES.bufferHours, 12, "defaults are not changed by overrides");
  assert.deepEqual(CHECKS.map((c) => c.id), ["overlap", "tooClose", "sharedPeople", "freezeClash", "meetingClash"]);
});

test("a new kind of clash can be taught by adding one entry to CHECKS", () => {
  CHECKS.push({ id: "sameName", severity: "low", test: (a, b) => (a.name === b.name ? { at: a.start, text: "Same name." } : null) });
  try {
    const s = buildSchedule([rel("a", "Twin", { deploy: "2026-10-27T02:00" }), rel("b", "Twin", { deploy: "2026-11-27T02:00" })], { now: NOW });
    assert.deepEqual(kinds(s), ["sameName"]);
  } finally { CHECKS.pop(); }
});

test("bad or missing dates do not throw", () => {
  const junk = rel("a", "A", { deploy: "not a date", freeze: "x", meeting: "y" });
  const s = buildSchedule([junk, null, undefined, rel("b", "B", { deploy: "2026-10-27T02:00" })], { now: NOW });
  assert.deepEqual(s.rows.map((r) => r.id), ["b"]);
  assert.equal(s.unscheduled.length, 1);
  assert.deepEqual(buildSchedule([], { now: NOW }), { rows: [], unscheduled: [], conflicts: [], range: null, now: NOW });
  assert.deepEqual(buildSchedule(null, { now: NOW }).rows, []);
  assert.equal(toItem({}).name, "Untitled release");
});

test("range covers every date shown; window length falls back to 2 hours", () => {
  const s = buildSchedule([rel("a", "A", { freeze: "2026-10-22T09:00", meeting: "2026-10-26T14:00", deploy: "2026-10-27T02:00", hours: 0 })], { now: NOW });
  assert.equal(s.range.from, parseLocal("2026-10-22T09:00"));
  assert.equal(s.range.to, parseLocal("2026-10-27T04:00"));
});

test("conflictsFor and otherSide pick out one release's clashes", () => {
  const s = buildSchedule([rel("a", "A", { deploy: "2026-10-27T02:00" }), rel("b", "B", { deploy: "2026-10-27T03:00" }), rel("c", "C", { deploy: "2026-12-01T02:00" })], { now: NOW });
  assert.equal(conflictsFor(s, "a").length, 1);
  assert.equal(conflictsFor(s, "c").length, 0);
  assert.equal(otherSide(conflictsFor(s, "a")[0], "a").name, "B");
  assert.equal(conflictsFor(s, "a").length, conflictsFor(s, 'a').length, "ids may be given as strings or numbers");
});

test("suggested slots keep the time of day, skip weekends and anything that would clash", () => {
  const a = rel("a", "A", { deploy: "2026-10-23T02:00", freeze: "2026-10-20T09:00", meeting: "2026-10-22T14:00" }); // Friday 2 AM
  const b = rel("b", "B", { deploy: "2026-10-27T02:00" }); // Tuesday 2 AM
  const slots = suggestSlots([a, b], "a", { now: NOW, count: 3 });
  assert.equal(slots.length, 3);
  for (const s of slots) {
    const d = new Date(s.at);
    assert.equal(d.getHours(), 2); assert.equal(d.getMinutes(), 0);
    assert.ok(![0, 6].includes(d.getDay()), "no weekends");
    assert.ok(s.at > NOW);
  }
  assert.ok(!slots.some((s) => s.local === "2026-10-27T02:00"), "Tuesday 2 AM is taken by B");
  assert.deepEqual(slots.map((x) => x.local), ["2026-10-26T02:00", "2026-10-28T02:00", "2026-10-29T02:00"], "Saturday and Sunday are skipped, Tuesday is taken");
});

test("suggested slots: unknown release, no date, or nothing free", () => {
  assert.deepEqual(suggestSlots([rel("a", "A", { deploy: "2026-10-27T02:00" })], "zzz", { now: NOW }), []);
  assert.deepEqual(suggestSlots([rel("a", "A", {})], "a", { now: NOW }), []);
  const jam = Array.from({ length: 40 }, (_, i) => rel("x" + i, "X" + i, { deploy: `2026-10-${String(21 + (i % 10)).padStart(2, "0")}T0${i % 3}:00` }));
  const free = suggestSlots([rel("a", "A", { deploy: "2026-10-27T02:00" }), ...jam], "a", { now: NOW, rules: { suggestDaysAhead: 2 } });
  assert.ok(free.length <= 2);
});

test("clashesBetween works on two items directly and the example release alone has no clashes", () => {
  const a = toItem(rel("a", "A", { deploy: "2026-10-27T02:00" })), b = toItem(rel("b", "B", { deploy: "2026-10-27T02:30" }));
  assert.equal(clashesBetween(a, b)[0].kind, "overlap");
  const ex = defaultPlan(NOW); ex.id = "ex";
  assert.deepEqual(buildSchedule([ex], { now: NOW }).conflicts, []);
});
