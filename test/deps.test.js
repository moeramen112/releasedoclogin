import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDependencies, parseKeys, TEAMS } from "../src/deps.js";
import { evaluate } from "../src/engine.js";
import { computeRisk } from "../src/risk.js";
import { blankPlan, defaultPlan, nextPlan, planToSnapshot, planConfig, planState, briefMarkdown } from "../src/plan.js";

const NOW = Date.parse("2026-03-10T12:00:00");
const T = (key, status, blockedBy = "", extra = {}) => ({ key, summary: `${key} summary`, type: "Story", priority: "P2", points: 3, status, area: "Core", team: "", blockedBy, tags: {}, ...extra });
const run = (plan) => {
  const res = evaluate(planToSnapshot(plan, NOW), planConfig(plan), planState(plan));
  return { res, deps: res.criteria.find((c) => c.id === "deps"), risk: computeRisk(plan, NOW) };
};
const planWith = (tickets, handoffs = []) => ({ ...blankPlan(NOW), tickets, handoffs });

test("keys are split on commas, spaces and semicolons, upper-cased, and de-duplicated", () => {
  assert.deepEqual(parseKeys("rel-1, REL-2;rel-3  REL-1"), ["REL-1", "REL-2", "REL-3"]);
  assert.deepEqual(parseKeys(""), []);
  assert.deepEqual(parseKeys(undefined), []);
  assert.ok(TEAMS.includes("Frontend") && TEAMS.includes("QA") && TEAMS.includes("Design"));
});

test("backend before frontend before QA: each open ticket waits on the one before it", () => {
  const d = analyzeDependencies([T("BE-1", "In progress"), T("FE-1", "To do", "BE-1"), T("QA-1", "To do", "FE-1")], [], NOW);
  assert.deepEqual(d.waiting.map((w) => w.key), ["FE-1", "QA-1"]);
  assert.deepEqual(d.longestChain, { length: 3, keys: ["BE-1", "FE-1", "QA-1"] });
  assert.equal(d.finishFirst[0].key, "BE-1");
  assert.equal(d.finishFirst[0].unblocks, 2); // FE-1 directly, QA-1 through FE-1
});

test("a ticket stops waiting as soon as what it depends on is Done, and shows as ready", () => {
  const d = analyzeDependencies([T("BE-1", "Done"), T("FE-1", "To do", "BE-1")], [], NOW);
  assert.equal(d.waiting.length, 0);
  assert.deepEqual(d.ready.map((r) => r.key), ["FE-1"]);
});

test("work started before its input is done is flagged, even when finished early", () => {
  const d = analyzeDependencies([T("BE-1", "In progress"), T("FE-1", "In review", "BE-1"), T("FE-2", "Done", "BE-1")], [], NOW);
  assert.deepEqual(d.startedEarly.map((x) => x.key), ["FE-1", "FE-2"]);
  assert.deepEqual(d.waiting.map((x) => x.key), ["FE-1"]); // FE-2 is Done, so it is not waiting
});

test("circular dependencies are found once and never loop forever", () => {
  const d = analyzeDependencies([T("A-1", "To do", "A-2"), T("A-2", "To do", "A-3"), T("A-3", "To do", "A-1"), T("B-1", "To do", "B-1")], [], NOW);
  assert.equal(d.cycles.length, 1);
  assert.deepEqual(d.cycles[0], ["A-1", "A-2", "A-3"]);
  assert.equal(d.finishFirst.length, 0); // tickets stuck in a loop are not "finish this first"
  assert.equal(d.waiting.find((w) => w.key === "B-1"), undefined); // a ticket cannot block itself
});

test("a blocker that is not in this release is unresolved, not silently ignored", () => {
  const d = analyzeDependencies([T("FE-1", "To do", "OTHER-9")], [], NOW);
  assert.deepEqual(d.outside, ["OTHER-9"]);
  assert.equal(d.waiting[0].on[0].kind, "outside");
});

test("handoffs block the tickets they name until they are Done", () => {
  const h = (status, due = "2026-03-09T17:00") => [{ what: "Final designs", from: "Design", to: "Frontend", due, status, blocks: "fe-1" }];
  const open = analyzeDependencies([T("FE-1", "To do")], h("In progress"), NOW);
  assert.equal(open.waiting[0].on[0].kind, "handoff");
  assert.equal(open.handoffs.overdue.length, 1); // due yesterday, not done
  const done = analyzeDependencies([T("FE-1", "To do")], h("Done"), NOW);
  assert.equal(done.waiting.length, 0);
  assert.equal(done.handoffs.overdue.length, 0);
  assert.equal(analyzeDependencies([T("FE-1", "To do")], h("Blocked", "2026-03-20T09:00"), NOW).handoffs.blocked.length, 1);
});

test("a handoff due after the freeze is reported", () => {
  const d = analyzeDependencies([T("FE-1", "To do")], [{ what: "Copy", from: "Product", to: "Frontend", due: "2026-03-14T09:00", status: "Not started", blocks: "FE-1" }], NOW, Date.parse("2026-03-12T00:00"));
  assert.equal(d.handoffs.afterFreeze.length, 1);
});

test("no dependencies entered reads as pass with an honest message, and costs no risk", () => {
  const { deps, risk } = run(planWith([T("A-1", "To do"), T("A-2", "Done")]));
  assert.equal(deps.status, "pass");
  assert.match(deps.detail, /No dependencies entered/);
  assert.equal(risk.factors.find((f) => f.id === "dependencies").points, 0);
});

test("the check warns for waiting work, fails for a circle, and passes once everything is done", () => {
  assert.equal(run(planWith([T("BE-1", "In progress"), T("FE-1", "To do", "BE-1")])).deps.status, "warn");
  assert.equal(run(planWith([T("A-1", "To do", "A-2"), T("A-2", "To do", "A-1")])).deps.status, "fail");
  const clear = run(planWith([T("BE-1", "Done"), T("FE-1", "Done", "BE-1")]));
  assert.equal(clear.deps.status, "pass");
  assert.match(clear.deps.detail, /Every dependency is done/);
});

test("the check is advisory by default, so waiting work alone does not block a release", () => {
  const { deps } = run(planWith([T("BE-1", "In progress"), T("FE-1", "To do", "BE-1")]));
  assert.equal(deps.required, false);
});

test("a person can make it required, and then a waiting ticket holds the release", () => {
  const plan = planWith([T("BE-1", "In progress"), T("FE-1", "To do", "BE-1")]);
  plan.settings.criteria = { deps: { required: true } };
  const { deps, res } = run(plan);
  assert.equal(deps.required, true);
  assert.ok(res.verdict.holding.includes("deps"));
});

test("risk rises with waiting work, started-early work, overdue handoffs and long chains, and is capped", () => {
  const none = run(planWith([T("A-1", "To do")])).risk.factors.find((f) => f.id === "dependencies");
  const some = run(planWith([T("A-1", "In progress"), T("A-2", "To do", "A-1")])).risk.factors.find((f) => f.id === "dependencies");
  const chain = run(planWith([T("A-1", "In progress"), T("A-2", "To do", "A-1"), T("A-3", "To do", "A-2"), T("A-4", "To do", "A-3")], [{ what: "X", from: "Design", to: "QA", due: "2026-03-01T10:00", status: "Blocked", blocks: "A-2" }])).risk.factors.find((f) => f.id === "dependencies");
  const loop = run(planWith([T("A-1", "To do", "A-2"), T("A-2", "To do", "A-1")])).risk.factors.find((f) => f.id === "dependencies");
  assert.equal(none.points, 0);
  assert.ok(some.points > none.points && chain.points > some.points);
  assert.equal(loop.points, loop.max); // a circle is the worst case
  assert.ok(chain.points <= chain.max);
  assert.match(some.advice, /Finish A-1 first/);
});

test("risk factor weights still add up to 100 with the new factor", () => {
  const r = computeRisk(defaultPlan(NOW), NOW);
  assert.equal(r.factors.reduce((n, f) => n + f.max, 0), 100);
  assert.ok(r.factors.some((f) => f.id === "dependencies" && f.max === 6));
});

test("older plans without the new fields still load and score", () => {
  const old = planWith([{ key: "OLD-1", summary: "x", type: "Story", priority: "P2", points: 2, status: "To do", area: "Core", tags: {} }]);
  delete old.handoffs;
  const { deps, risk } = run(old);
  assert.equal(deps.status, "pass");
  assert.ok(risk.score >= 0);
});

test("starting the next release keeps people but clears this release's handoffs and blockers", () => {
  const next = nextPlan(defaultPlan(NOW), NOW);
  assert.deepEqual(next.handoffs, []);
  assert.deepEqual(next.tickets, []);
});

test("the example release shows dependencies, and the brief lists them", () => {
  const plan = defaultPlan(NOW);
  const { res, risk } = run(plan);
  const md = briefMarkdown(plan, res, risk, NOW);
  assert.match(md, /## Dependencies/);
  assert.match(md, /Finish these first/);
  assert.match(md, /Handoffs between teams/);
  assert.match(md, /Final invoice designs/);
});

test("the brief leaves the section out when nothing is entered", () => {
  const plan = planWith([T("A-1", "To do")]);
  const { res, risk } = run(plan);
  assert.ok(!/## Dependencies/.test(briefMarkdown(plan, res, risk, NOW)));
});
