import test from "node:test";
import assert from "node:assert/strict";
import { buildSchedule } from "../src/schedule.js";
import { renderTimeline, renderConflicts, renderClashBanner, viewRange } from "../src/schedule-view.js";

const NOW = new Date(2026, 9, 26, 9, 0).getTime();
const plan = (id, name, deployAt, extra = {}) => ({ id, release: { name, version: "1" }, when: { deployAt, windowHours: 2 }, where: { repo: "" }, people: {}, tickets: [], ...extra });
const A = plan("a", "Alpha", "2026-10-28T02:00"), B = plan("b", "Beta <b>", "2026-10-28T03:00"), C = plan("c", "Gamma", "2026-11-10T02:00");
const sched = buildSchedule([A, B, C], { now: NOW });
const range = viewRange(NOW, { days: 28 });

test("viewRange starts at midnight two days back and spans the days asked", () => {
  assert.equal(new Date(range.from).getHours(), 0);
  assert.equal(new Date(range.from).getDate(), 24);
  assert.equal(Math.round((range.to - range.from) / 86_400_000), 28);
});

test("timeline: one row per release, clashing deploys are marked, names are escaped", () => {
  const html = renderTimeline(sched, range);
  assert.equal((html.match(/class="cal-row"/g) || []).length, 3);
  assert.equal((html.match(/cal-deploy clash/g) || []).length, 2);
  assert.ok(!html.includes("Beta <b>") && html.includes("Beta &lt;b&gt;"));
  assert.ok(html.includes('href="/plan.html?release=a"'));
});

test("timeline: no label repeats across the clock change on Nov 1", () => {
  const labels = [...renderTimeline(sched, range).matchAll(/class="cal-day[^"]*"[^>]*>(?:<small>[^<]*<\/small>)?(\d+)</g)].map((m) => m[1]);
  assert.equal(new Set(labels).size, labels.length);
});

test("timeline: says so when nothing falls in the range", () => {
  assert.match(renderTimeline(buildSchedule([], { now: NOW }), range), /No releases are scheduled/);
});

test("conflicts: cards with severity, free slots and links; calm message when none", () => {
  const html = renderConflicts(sched, { slotsFor: () => [{ text: "Fri, Oct 30, 2:00 AM" }] });
  assert.match(html, /clash-card sev-high/);
  assert.match(html, /Free slots for Alpha: Fri, Oct 30, 2:00 AM/);
  assert.match(renderConflicts(buildSchedule([A, C], { now: NOW })), /No clashes/);
});

test("banner: empty without clashes, names the other release with them", () => {
  assert.equal(renderClashBanner([], "a"), "");
  const html = renderClashBanner(sched.conflicts, "a", { calendarHref: "/calendar.html" });
  assert.match(html, /clash with Beta &lt;b&gt;/);
  assert.match(html, /href="\/calendar.html"/);
  assert.ok(!renderClashBanner(sched.conflicts, "a").includes("See the calendar"));
});
