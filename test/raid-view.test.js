import test from "node:test";
import assert from "node:assert/strict";
import { buildRaidView, filterRaid, emptyRaid } from "../src/raid.js";
import { renderRaidSummary, renderRaidTable } from "../src/raid-view.js";
import { blankPlan } from "../src/plan.js";

const NOW = new Date(2026, 9, 22, 12, 0).getTime();
const it = (o) => ({ ...emptyRaid("Risk", NOW), ...o });
const plans = [
  { ...blankPlan(NOW), id: "a", release: { name: "Alpha <b>" }, raid: [it({ title: "Late <i>one", owner: "Amy", rating: "High", due: "2026-10-01T00:00" }), it({ title: "Plain", type: "Issue", status: "Open", rating: "Low" })] },
  { ...blankPlan(NOW), id: "b", release: { name: "Beta" }, raid: [it({ title: "Dep", type: "Dependency", owner: "Bo", status: "Open" })] },
];
const view = buildRaidView(plans, { now: NOW });

test("filterRaid: by type, rating, owner, release, and 'no owner'", () => {
  assert.equal(filterRaid(view.rows, {}).length, 3);
  assert.deepEqual(filterRaid(view.rows, { type: "Issue" }).map((r) => r.title), ["Plain"]);
  assert.deepEqual(filterRaid(view.rows, { rating: "High" }).map((r) => r.title), ["Late <i>one"]);
  assert.deepEqual(filterRaid(view.rows, { owner: "Bo" }).map((r) => r.releaseId), ["b"]);
  assert.deepEqual(filterRaid(view.rows, { owner: "(none)" }).map((r) => r.title), ["Plain"]);
  assert.deepEqual(filterRaid(view.rows, { releaseId: "a" }).length, 2);
});

test("table: links to the release, escapes text, flags overdue, handles empty", () => {
  const html = renderRaidTable(view.rows);
  assert.ok(html.includes('href="/plan.html?release=a"'));
  assert.ok(!html.includes("<b>") && html.includes("Alpha &lt;b&gt;") && html.includes("Late &lt;i&gt;one"));
  assert.match(html, /overdue/);
  assert.match(html, /no owner/);
  assert.match(renderRaidTable([]), /Nothing matches/);
});

test("summary: counts by type and shows high, overdue and no-owner chips", () => {
  const html = renderRaidSummary(view.rows);
  assert.match(html, /1 risk</); assert.match(html, /0 assumptions/); assert.match(html, /1 high/); assert.match(html, /1 overdue/); assert.match(html, /1 without an owner/);
});
