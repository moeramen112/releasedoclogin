// Release history: what the call and risk were when a release was closed, and how it turned out.
// Pure functions, shared by the planner page and the tests.

import { evaluate } from "./engine.js";
import { computeRisk } from "./risk.js";
import { planToSnapshot, planConfig, planState, emptyOutcome, fmtLocal, OUTCOMES } from "./plan.js";

const TROUBLE = ["Shipped with issues", "Rolled back"];
const SHIPPED = ["Shipped cleanly", "Shipped with issues", "Rolled back"];

/** What the tool said at the moment the release was closed. Kept so history shows the call that was actually in front of people. */
export function takeSnapshot(plan, now = Date.now()) {
  const result = evaluate(planToSnapshot(plan, now), planConfig(plan), planState(plan));
  const risk = computeRisk(plan, now);
  const v = result.verdict;
  return {
    takenAt: now, call: v.call, reason: v.reason, risk: risk.score, riskLevel: risk.level, pctDone: risk.points.pctDone,
    open: v.counts.fail + v.counts.warn + v.counts.pending, waived: v.counts.waived || 0,
    tickets: (plan.tickets || []).length, points: risk.points.total,
  };
}

/**
 * Call after the outcome fields change. Setting an outcome records the snapshot (and the time, if empty);
 * clearing it reopens the release and drops the snapshot. Returns true when something changed.
 */
export function applyOutcomeChange(plan, now = Date.now()) {
  const o = (plan.outcome ||= emptyOutcome());
  if (o.status && !OUTCOMES.includes(o.status)) { o.status = ""; }
  if (!o.status) { const had = Boolean(o.snapshot); o.snapshot = null; return had; }
  let changed = false;
  if (!o.snapshot) { o.snapshot = takeSnapshot(plan, now); changed = true; }
  if (!o.at) { o.at = fmtLocal(now); changed = true; }
  return changed;
}

/** Closed releases, newest first. `plans` is a list of release plans (each with an id). */
export function historyRows(plans) {
  return (plans || [])
    .filter((p) => p && p.outcome?.status)
    .map((p) => {
      const o = p.outcome, s = o.snapshot || null;
      return {
        id: p.id, name: p.release?.name || "Untitled release", version: p.release?.version || "",
        at: o.at || "", status: o.status, note: o.note || "",
        call: s?.call || "", risk: s ? s.risk : null, riskLevel: s?.riskLevel || "", waived: s?.waived || 0,
        trouble: TROUBLE.includes(o.status), shipped: SHIPPED.includes(o.status),
      };
    })
    .sort((a, b) => String(b.at).localeCompare(String(a.at)) || a.name.localeCompare(b.name));
}

/** Counts for the top of the history panel, and how each call held up against what happened. */
export function historySummary(rows) {
  const count = (st) => rows.filter((r) => r.status === st).length;
  const shipped = rows.filter((r) => r.shipped);
  const byCall = {};
  for (const r of shipped) {
    if (!r.call) continue;
    const c = (byCall[r.call] ||= { shipped: 0, trouble: 0 });
    c.shipped++;
    if (r.trouble) c.trouble++;
  }
  return {
    total: rows.length, clean: count("Shipped cleanly"), issues: count("Shipped with issues"), rolledBack: count("Rolled back"), cancelled: count("Cancelled"),
    shippedAgainstCall: shipped.filter((r) => r.call && r.call !== "GO").length,
    byCall,
  };
}

export const TREND_MIN = 3; // fewer shipped releases than this and the percentages are only anecdotes

const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);
const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/**
 * Delivery measures from closed releases. Needs no new data.
 *  changeFailureRate  share of shipped releases that had issues or were rolled back (null with nothing shipped)
 *  callRight          how often the call at close matched what happened, among shipped releases that kept a call:
 *                     GO + shipped cleanly, or HOLD / NO-GO + trouble, counts as right. HOLD / NO-GO + clean is "cautious".
 *  riskByOutcome      average risk score at close for each outcome (only releases that kept a snapshot)
 *  months             shipped and troubled releases per month, oldest first
 *  enough             false when fewer than TREND_MIN releases shipped: show the numbers, but say they are thin
 */
export function historyTrends(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const shipped = list.filter((r) => r.shipped);
  const trouble = shipped.filter((r) => r.trouble).length;
  const judged = shipped.filter((r) => r.call);
  const right = judged.filter((r) => (r.call === "GO") !== r.trouble).length;
  const cautious = judged.filter((r) => r.call !== "GO" && !r.trouble).length;
  const missed = judged.filter((r) => r.call === "GO" && r.trouble).length;
  const riskByOutcome = {};
  for (const st of OUTCOMES) {
    const scores = list.filter((r) => r.status === st && Number.isFinite(r.risk)).map((r) => r.risk);
    if (scores.length) riskByOutcome[st] = { avg: avg(scores), n: scores.length };
  }
  const byMonth = new Map();
  for (const r of shipped) {
    const t = Date.parse(r.at);
    if (Number.isNaN(t)) continue;
    const d = new Date(t), key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const m = byMonth.get(key) || { month: key, shipped: 0, trouble: 0 };
    m.shipped++; if (r.trouble) m.trouble++;
    byMonth.set(key, m);
  }
  return {
    shipped: shipped.length, trouble, changeFailureRate: pct(trouble, shipped.length),
    judged: judged.length, right, callRight: pct(right, judged.length), cautious, missed,
    riskByOutcome, months: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)),
    enough: shipped.length >= TREND_MIN,
  };
}
