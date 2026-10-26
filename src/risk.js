// Release risk model. Pure functions, no I/O. Runs in Node and in the browser.
// Factor weights add up to 100, so the score reads as "points of risk out of 100".

import { analyzeDependencies } from "./deps.js";

export const DONE = "Done";
export const STATUS_ORDER = ["To do", "In progress", "In review", "Done"];
export const SENSITIVE_AREAS = ["Payments", "Auth", "Data"];

export const num = (v, fallback = 0) => (v === "" || v === null || v === undefined || !Number.isFinite(Number(v)) ? fallback : Number(v));
export const parseLocal = (s) => { const t = Date.parse(s); return Number.isNaN(t) ? null : t; };
const joinAreas = (a) => a.join(", ");
const round1 = (n) => Math.round(n * 10) / 10;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Whole business days between two instants, counting only days that fit completely. */
export function businessDays(fromMs, toMs) {
  if (!(toMs > fromMs)) return 0;
  const d = new Date(fromMs);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  let n = 0;
  for (; d.getTime() + 86400000 <= toMs; d.setDate(d.getDate() + 1)) {
    const g = d.getDay();
    if (g !== 0 && g !== 6) n++;
  }
  return n;
}

/** Story points by status and area, plus the open tickets that are large. */
export function summarizePoints(tickets = [], bigAt = 8) {
  const byStatus = { "To do": 0, "In progress": 0, "In review": 0, Done: 0 };
  const byArea = {};
  const bigOpen = [];
  let total = 0, unestimated = 0, doneTickets = 0;
  for (const t of tickets) {
    const pts = Math.max(0, num(t.points));
    const status = STATUS_ORDER.includes(t.status) ? t.status : "To do";
    const area = t.area || "Other";
    byStatus[status] += pts;
    total += pts;
    byArea[area] ||= { total: 0, done: 0, tickets: 0 };
    byArea[area].total += pts;
    byArea[area].tickets++;
    if (status === DONE) { byArea[area].done += pts; doneTickets++; }
    else {
      if (!pts && t.type !== "Bug") unestimated++;
      if (pts >= bigAt) bigOpen.push({ key: t.key, points: pts });
    }
  }
  const done = byStatus.Done;
  return {
    total, done, remaining: total - done,
    inFlight: byStatus["In progress"] + byStatus["In review"],
    todo: byStatus["To do"],
    pctDone: total ? Math.round((done / total) * 100) : 0,
    byStatus, byArea, bigOpen, unestimated,
    tickets: tickets.length, doneTickets, openTickets: tickets.length - doneTickets,
  };
}

/** Can the remaining points land before the freeze at the team's velocity? */
export function forecast(plan, pts, now) {
  const freeze = parseLocal(plan.when?.freezeAt);
  const deploy = parseLocal(plan.when?.deployAt);
  const velocity = num(plan.scope?.velocity);
  const freezePassed = freeze !== null && freeze <= now;
  const target = freeze !== null && !freezePassed ? freeze : deploy;
  const daysLeft = target ? businessDays(now, target) : 0;
  const capacity = round1(velocity * daysLeft);
  const remaining = pts.remaining;
  let state, detail;
  if (remaining === 0) { state = "complete"; detail = "All points are done."; }
  else if (freezePassed) { state = "after-freeze"; detail = `${remaining} points are still open after the code freeze.`; }
  else if (!velocity) { state = "unknown"; detail = "Enter team velocity to forecast the finish."; }
  else if (capacity >= remaining * 1.15) { state = "on-track"; detail = `Capacity of ${capacity} points covers the ${remaining} remaining.`; }
  else if (capacity >= remaining * 0.85) { state = "tight"; detail = `Capacity of ${capacity} points barely covers the ${remaining} remaining.`; }
  else { state = "behind"; detail = `Capacity of ${capacity} points is short of the ${remaining} remaining.`; }
  return { state, detail, velocity, daysLeft, capacity, remaining, needPerDay: daysLeft ? round1(remaining / daysLeft) : null, freezePassed };
}

export const LEVELS = [
  { name: "Low", below: 25 },
  { name: "Moderate", below: 50 },
  { name: "High", below: 75 },
  { name: "Critical", below: 101 },
];
export const levelFor = (score) => (LEVELS.find((l) => score < l.below) || LEVELS[LEVELS.length - 1]).name; // a score that is not a number reads as the worst level, never as a crash

/** Staged rollout suggestion, tighter as risk goes up. */
export function rolloutLadder(level) {
  const ladders = {
    Low: { steps: [10, 50, 100], bake: 15, note: "Standard three-stage rollout." },
    Moderate: { steps: [5, 25, 50, 100], bake: 30, note: "Four stages with a 30 minute bake between them." },
    High: { steps: [1, 5, 25, 50, 100], bake: 60, note: "Start at 1% and bake for an hour at each stage. Keep the release manager and SRE on call." },
    Critical: { steps: [1], bake: 1440, note: "Not recommended to ship. If it must go, release to 1% for a full day and review before widening." },
  };
  return ladders[level];
}

export function computeRisk(plan, now = Date.now()) {
  const tickets = plan.tickets || [];
  const pts = summarizePoints(tickets, num(plan.scope?.bigAt, 8));
  const fc = forecast(plan, pts, now);
  const s = plan.signals || {};
  const ci = s.ci || {};
  const checks = plan.checks || {};
  const how = plan.how || {};
  const factors = [];
  const add = (id, label, max, points, detail, advice) =>
    factors.push({ id, label, max, points: Math.max(0, Math.min(max, Math.round(points))), detail, advice });

  // 1. Unfinished scope (14)
  const remPct = pts.total ? pts.remaining / pts.total : 0.5;
  const shortfall = fc.state === "behind" ? 6 : fc.state === "tight" ? 3 : fc.state === "after-freeze" ? 6 : 0;
  add("scope", "Unfinished scope", 14, remPct * 10 + shortfall,
    pts.total ? `${pts.remaining} of ${pts.total} points not done (${100 - pts.pctDone}%). ${fc.detail}` : "No story points entered, so scope cannot be measured.",
    "Cut or defer unfinished tickets before the go/no-go meeting. Anything still open after the freeze needs a named owner and a feature flag.");

  // 2. Open defects (16)
  const openBugs = tickets.filter((t) => t.status !== DONE && t.type === "Bug");
  const bugs = (p) => openBugs.filter((t) => t.priority === p).length;
  add("blockers", "Open defects", 16, bugs("P0") * 10 + bugs("P1") * 4 + bugs("P2"),
    `${bugs("P0")} P0, ${bugs("P1")} P1 and ${bugs("P2")} P2 bugs are open.`,
    "Resolve every P0 before release. For each open P1, agree a fix date or record a waiver with a named approver.");

  // 3. Large unfinished tickets (5)
  add("big", "Large tickets still open", 5, pts.bigOpen.length * 3,
    pts.bigOpen.length ? `${pts.bigOpen.map((b) => `${b.key} (${b.points})`).join(", ")} not done.` : `No unfinished ticket of ${num(plan.scope?.bigAt, 8)}+ points.`,
    "Large tickets finish late and break late. Split them, ship the finished part behind a flag, or move them to the next train.");

  // 4. Unestimated work (3)
  add("estimate", "Unestimated tickets", 3, pts.unestimated,
    pts.unestimated ? `${plural(pts.unestimated, "open ticket has", "open tickets have")} no story points.` : "Open tickets are all estimated.",
    "Estimate the remaining tickets so the forecast means something.");

  // 5. Sensitive areas (6)
  const sensitive = plan.settings?.sensitiveAreas ?? SENSITIVE_AREAS;
  const touched = tickets.filter((t) => sensitive.includes(t.area));
  const openTouched = touched.filter((t) => t.status !== DONE).length;
  const untestedTouched = touched.filter((t) => t.tags?.untested).length;
  // Open work in these areas is the concern; finished work counts for less; missing tests count extra.
  add("sensitive", "Changes in sensitive areas", 6, openTouched * 2 + (touched.length - openTouched) * 0.5 + untestedTouched * 2,
    touched.length ? `${plural(touched.length, "ticket touches", "tickets touch")} ${joinAreas(sensitive)} (${openTouched} still open)${untestedTouched ? `; ${untestedTouched} flagged as lacking tests` : ""}.` : (sensitive.length ? `No ticket touches ${joinAreas(sensitive)}.` : "No sensitive areas are configured for this project."),
    "Ask for a second reviewer and an explicit test plan on every change in these areas, and watch their dashboards first after deploy.");

  // 6. Change size (7)
  const files = num(s.filesChanged), lines = num(s.linesChanged);
  const maxFiles = num(plan.scope?.maxFiles, 400), maxLines = num(plan.scope?.maxLines, 15000);
  const ratio = Math.max(files / maxFiles, lines / maxLines);
  add("size", "Size of the change", 7, ratio * 5,
    `${files.toLocaleString("en-US")} files and ${lines.toLocaleString("en-US")} lines changed. Budget is ${maxFiles.toLocaleString("en-US")} files and ${maxLines.toLocaleString("en-US")} lines.`,
    "Big releases hide regressions. Release more often, or split this one by service.");

  // 7. Late and unreviewed changes (7)
  const late = num(s.lateMerged), unapproved = num(s.mergedUnapproved);
  add("late", "Late and unreviewed changes", 7, late * 2 + unapproved,
    `${plural(late, "PR", "PRs")} merged after the freeze, ${plural(unapproved, "merged PR", "merged PRs")} without an approval.`,
    "Review every post-freeze change by hand. Revert anything that does not have a clear reason to be in this release.");

  // 8. Data migration (9)
  const hasMigration = tickets.some((t) => t.tags?.migration) || (checks.migration && checks.migration !== "na");
  let migPts = 0, migDetail = "No migration in this release.";
  if (hasMigration) {
    const m = checks.migration;
    migPts = m === "pass" ? 1 : m === "fail" ? 10 : 7;
    migDetail = m === "pass" ? "Migration dry run passed." : m === "fail" ? "Migration dry run failed." : "Migration is in scope and has not been dry-run on production-size data.";
  }
  add("migration", "Data migration", 9, migPts, migDetail,
    "Dry-run the migration on production-size data and measure lock time. Decide in advance whether it can be rolled back.");

  // 9. Rollback readiness (7)
  const rb = checks.rollback;
  const planText = String(how.rollbackPlan || "").trim();
  const rbMin = num(how.rollbackMinutes);
  add("rollback", "Rollback readiness", 7,
    (rb === "pass" ? 0 : rb === "fail" ? 8 : 6) + (planText.length < 20 ? 2 : 0) + (rbMin > 30 ? 2 : 0),
    `Rehearsal ${rb === "pass" ? "passed" : rb === "fail" ? "failed" : "not done"}; ${planText.length < 20 ? "no written rollback plan" : "rollback plan written"}; target ${rbMin || "?"} minutes.`,
    "Rehearse the rollback on staging, write the steps down, and keep the target under 30 minutes.");

  // 10. Deploy timing (7)
  const deploy = parseLocal(plan.when?.deployAt);
  let timing = 0, timingDetail = "No deploy time set.";
  if (deploy !== null) {
    const d = new Date(deploy);
    const day = d.getDay(), hour = d.getHours();
    const dayName = d.toLocaleDateString("en-US", { weekday: "long" });
    timing = (day === 5 ? 5 : day === 0 || day === 6 ? 7 : 0) + (hour >= 8 && hour < 18 ? 3 : 0) + (num(plan.when?.windowHours) > 4 ? 1 : 0);
    timingDetail = `Deploy on ${dayName} at ${String(hour).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}${day === 5 ? ", the day before the weekend" : ""}${hour >= 8 && hour < 18 ? ", during business hours" : ""}.`;
  }
  add("timing", "Deploy timing", 7, timing, timingDetail,
    "Avoid Fridays, weekends and peak hours. Deploy when the people who can fix it are awake and in the office.");

  // 11. Test and security health (8)
  const realFailures = String(ci.realFailures || "").split("\n").map((x) => x.trim()).filter(Boolean).length;
  const flaky = num(ci.flaky);
  const secCrit = num(s.securityCritical), secHigh = num(s.securityHigh);
  const covBad = num(s.coverageDeltaPp) < num(s.coverageFloorPp, -1);
  const perfBad = num(s.p95DeltaPct) > num(s.p95BudgetPct, 5);
  add("quality", "Test and security health", 8,
    realFailures * 3 + (flaky > 5 ? 2 : flaky > 0 ? 1 : 0) + (covBad ? 2 : 0) + (perfBad ? 2 : 0) + secCrit * 6 + secHigh * 2,
    `${plural(realFailures, "real failing check", "real failing checks")}, ${flaky} quarantined failures, ${secCrit} critical and ${secHigh} high vulnerabilities${covBad ? ", coverage below the floor" : ""}${perfBad ? ", p95 latency over budget" : ""}.`,
    "Fix real failures and known vulnerabilities first. Do not hide failures by quarantining new tests.");

  // 12. Rollout strategy (5)
  const strat = how.strategy;
  const base = { bigbang: 5, phased: 2, bluegreen: 2, canary: 0 }[strat] ?? 3;
  add("rollout", "Rollout strategy", 5, base + (how.flagsDefaultOff ? 0 : 2),
    `${{ bigbang: "All at once", phased: "Region by region", bluegreen: "Blue/green switch", canary: "Canary with staged percentages" }[strat] || "No strategy chosen"}; new features ${how.flagsDefaultOff ? "ship behind flags that default off" : "are not behind flags"}.`,
    "Use a staged rollout and put new behavior behind flags that default off, so rollback is a toggle instead of a deploy.");

  // 13. Dependencies (6): work that waits on other work, and handoffs between teams
  const dep = analyzeDependencies(tickets, plan.handoffs, now, parseLocal(plan.when?.freezeAt));
  const chainLen = dep.longestChain.length;
  const first = dep.finishFirst[0];
  add("dependencies", "Dependencies between work", 6,
    (dep.cycles.length ? 6 : 0) + Math.min(3, dep.waiting.length * 0.75) + Math.min(2, dep.startedEarly.length * 0.75) + Math.min(2, dep.handoffs.overdue.length + dep.handoffs.blocked.length) + (chainLen >= 3 ? 1 : 0) + Math.min(1, dep.outside.length * 0.5),
    !dep.any ? "No dependencies entered."
      : [
        dep.cycles.length ? `${plural(dep.cycles.length, "circular dependency", "circular dependencies")}` : "",
        dep.waiting.length ? `${plural(dep.waiting.length, "ticket", "tickets")} waiting on other work${dep.startedEarly.some((x) => x.status !== DONE) ? `, ${dep.startedEarly.filter((x) => x.status !== DONE).length} already started` : ""}` : "",
        dep.startedEarly.some((x) => x.status === DONE) ? `${plural(dep.startedEarly.filter((x) => x.status === DONE).length, "ticket", "tickets")} marked Done before what they depend on` : "",
        dep.handoffs.overdue.length ? `${plural(dep.handoffs.overdue.length, "handoff", "handoffs")} overdue` : "",
        chainLen >= 2 ? `longest chain: ${dep.longestChain.keys.join(" → ")}` : "",
      ].filter(Boolean).join("; ") + ".",
    `${first ? `Finish ${first.key} first: it holds up ${plural(first.unblocks, "other ticket", "other tickets")}. ` : ""}Confirm each handoff with its owner, and do not let dependent work start from guesses. Work that waits on something unfinished is the usual cause of late scope.`);

  const score = Math.max(0, Math.min(100, factors.reduce((n, f) => n + f.points, 0)));
  const level = levelFor(score);
  const recommendations = factors
    .filter((f) => f.points >= 2 && f.points / f.max >= 0.5)
    .sort((a, b) => b.points - a.points)
    .slice(0, 5)
    .map((f) => ({ id: f.id, label: f.label, advice: f.advice }));

  return { score, level, factors, points: pts, forecast: fc, recommendations, ladder: rolloutLadder(level) };
}
