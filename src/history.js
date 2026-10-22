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
