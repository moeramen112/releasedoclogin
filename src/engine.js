// Readiness engine. Pure functions only: no network, no disk, no clock except where passed in.
// Input: a normalized snapshot (from any mix of sources), the config, and persisted state
// (waivers and manual checks). Output: per-criterion results and one verdict.

export const SEVERITY = { pass: 0, pending: 1, warn: 2, fail: 3 };

/** Read one slice of the snapshot, or report why it is missing. */
function need(snapshot, key) {
  const err = snapshot.errors?.[key];
  if (err) return { error: err };
  const value = snapshot.data?.[key];
  if (value === undefined || value === null) return { error: "no data from source" };
  return { value };
}

const unavailable = (what, error) => ({
  status: "pending",
  detail: `Could not load ${what} (${error}). Treated as unresolved, never as passing.`,
});

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const EVALUATORS = {
  // Open defects at a severity. P0 usually fails the release, P1 usually warns.
  blockers_none(params, snapshot) {
    const r = need(snapshot, "blockers");
    if (r.error) return unavailable("blockers", r.error);
    const sev = params.severity || "P0";
    const hits = r.value.filter((b) => b.sev === sev);
    if (!hits.length) return { status: "pass", detail: `No open ${sev} defects.` };
    const keys = hits.slice(0, 4).map((b) => b.key).join(", ");
    const more = hits.length > 4 ? ` and ${hits.length - 4} more` : "";
    return { status: params.failAs || "fail", detail: `${hits.length} open: ${keys}${more}.` };
  },

  // Checks on the release branch head. Known-flaky runs warn; real failures fail.
  ci_green(params, snapshot, _state, config) {
    const r = need(snapshot, "ci");
    if (r.error) return unavailable("CI status", r.error);
    const ci = r.value;
    if (!ci.total) return { status: "pending", detail: "No checks reported on the release branch head." };
    const quarantine = (config.ci?.quarantine || []).map((s) => s.toLowerCase());
    const isQuarantined = (name) => quarantine.some((q) => name.toLowerCase().includes(q));
    const real = ci.failed.filter((n) => !isQuarantined(n));
    const flaky = ci.failed.filter(isQuarantined);
    if (real.length) return { status: "fail", detail: `${plural(real.length, "check", "checks")} failing: ${real.slice(0, 3).join(", ")}${real.length > 3 ? "…" : ""}.` };
    if (flaky.length) return { status: "warn", detail: `No real failures. ${plural(flaky.length, "quarantined check", "quarantined checks")} failed.` };
    if (ci.pending.length) return { status: "pending", detail: `${plural(ci.pending.length, "check", "checks")} still running.` };
    return { status: "pass", detail: `${ci.passed} of ${ci.total} checks passing.` };
  },

  // PRs that target the release branch and are not merged yet.
  open_prs(params, snapshot) {
    const r = need(snapshot, "openPrs");
    if (r.error) return unavailable("open pull requests", r.error);
    if (!r.value.length) return { status: "pass", detail: "Every scoped PR is merged." };
    const failing = r.value.filter((p) => p.checks === "failing").length;
    return { status: params.failAs || "warn", detail: `${r.value.length} still open, ${failing} with failing checks.` };
  },

  // Merged PRs that nobody approved. A process control, not a quality score.
  review_coverage(params, snapshot) {
    const r = need(snapshot, "mergedPrs");
    if (r.error) return unavailable("merged pull requests", r.error);
    const unreviewed = r.value.filter((p) => !p.approved);
    const max = params.max ?? 0;
    if (unreviewed.length <= max) return { status: "pass", detail: `${r.value.length} of ${r.value.length} merged PRs had an approval.` };
    const nums = unreviewed.slice(0, 4).map((p) => `#${p.number}`).join(", ");
    return { status: params.failAs || "warn", detail: `${plural(unreviewed.length, "merged PR", "merged PRs")} without an approval: ${nums}.` };
  },

  // Anything merged after the freeze date.
  late_changes(params, snapshot) {
    const r = need(snapshot, "mergedPrs");
    if (r.error) return unavailable("merged pull requests", r.error);
    const freeze = snapshot.release?.freezeDate ? Date.parse(snapshot.release.freezeDate) : NaN;
    if (Number.isNaN(freeze)) return { status: "pending", detail: "No freeze date configured." };
    const late = r.value.filter((p) => p.mergedAt && Date.parse(p.mergedAt) > freeze);
    const max = params.max ?? 0;
    if (late.length <= max) return { status: "pass", detail: "Nothing merged after the freeze." };
    return { status: params.failAs || "warn", detail: `${plural(late.length, "PR", "PRs")} merged after the freeze: ${late.slice(0, 4).map((p) => "#" + p.number).join(", ")}.` };
  },

  // Size of the release against a budget. Larger releases get more scrutiny.
  change_size(params, snapshot) {
    const r = need(snapshot, "compare");
    if (r.error) return unavailable("branch comparison", r.error);
    const c = r.value;
    const lines = c.additions + c.deletions;
    const maxFiles = params.maxFiles ?? 400;
    const maxLines = params.maxLines ?? 15000;
    const detail = `${c.commits} commits, ${c.filesChanged}${c.truncated ? "+" : ""} files, ${lines.toLocaleString("en-US")} lines changed.`;
    if (c.filesChanged > maxFiles || lines > maxLines) return { status: params.failAs || "warn", detail: `${detail} Budget is ${maxFiles} files and ${maxLines.toLocaleString("en-US")} lines.` };
    return { status: "pass", detail };
  },

  // A draft GitHub release exists for this tag.
  draft_release(_params, snapshot) {
    const r = need(snapshot, "draftRelease");
    if (r.error) return unavailable("releases", r.error);
    return r.value.exists
      ? { status: "pass", detail: "Draft release notes exist." }
      : { status: "warn", detail: "No draft release for this tag yet." };
  },

  // Sign-offs from named roles, read from labels on a tracking issue.
  signoffs(_params, snapshot) {
    const r = need(snapshot, "signoffs");
    if (r.error) return { status: "pending", detail: "No sign-off tracking issue configured." };
    if (!r.value.length) return { status: "pass", detail: "No sign-offs are required for this release." };
    const waiting = r.value.filter((s) => !s.approved).map((s) => s.role);
    if (!waiting.length) return { status: "pass", detail: `All ${r.value.length} sign-offs collected.` };
    return { status: "pending", detail: `${r.value.length - waiting.length} of ${r.value.length} signed. Waiting: ${waiting.join(", ")}.` };
  },

  // A human confirms something no integration can see (rollback rehearsal, for example).
  manual(params, snapshot, state) {
    const m = state.manual?.[params.checkId];
    if (!m || !m.state || m.state === "unset") return { status: "pending", detail: "Not yet confirmed by a person." };
    const sentence = (s) => (/[.!?]$/.test(s) ? s : s + ".");
    const head = `${m.state === "pass" ? "Confirmed" : "Marked failing"}${m.by ? ` by ${m.by}` : ""}`;
    const detail = m.note ? `${sentence(head)} ${sentence(m.note)}` : sentence(head);
    return { status: m.state === "pass" ? "pass" : "fail", detail };
  },

  // Tickets and handoffs that wait on other work: backend before frontend, merge before QA, designs before tickets.
  dependencies_clear(params, snapshot) {
    const r = need(snapshot, "deps");
    if (r.error) return unavailable("dependencies", r.error);
    const d = r.value;
    if (!d.any) return { status: "pass", detail: "No dependencies entered." };
    const names = (arr, n = 3) => arr.slice(0, n).map((x) => x.key || x.what).join(", ") + (arr.length > n ? "…" : "");
    const problems = [];
    let status = "pass";
    const raise = (s) => { if (SEVERITY[s] > SEVERITY[status]) status = s; };
    if (d.cycles.length) { problems.push(`circular: ${d.cycles[0].join(" → ")} → ${d.cycles[0][0]}, so none of them can start`); raise("fail"); }
    const begun = d.startedEarly.filter((x) => x.status !== "Done").length; // waiting, yet already being worked on
    const doneEarly = d.startedEarly.filter((x) => x.status === "Done");
    if (d.waiting.length) { problems.push(`${plural(d.waiting.length, "ticket is", "tickets are")} waiting on other work (${names(d.waiting)})${begun ? `, ${begun === d.waiting.length ? "all" : begun} already started` : ""}`); raise(params.waitingAs || "warn"); }
    if (doneEarly.length) { problems.push(`${plural(doneEarly.length, "ticket is", "tickets are")} marked Done while what they depend on is not (${names(doneEarly)})`); raise("warn"); }
    if (d.handoffs.overdue.length) { problems.push(`${plural(d.handoffs.overdue.length, "handoff is", "handoffs are")} overdue (${names(d.handoffs.overdue)})`); raise("warn"); }
    if (d.handoffs.blocked.length) { problems.push(`${plural(d.handoffs.blocked.length, "handoff is", "handoffs are")} blocked (${names(d.handoffs.blocked)})`); raise("warn"); }
    if (d.outside.length) { problems.push(`waiting on ${d.outside.slice(0, 3).join(", ")}, which ${d.outside.length === 1 ? "is" : "are"} not in this release's ticket list`); raise("warn"); }
    if (!problems.length) return { status: "pass", detail: "Every dependency is done." };
    return { status, detail: problems.join("; ").replace(/^./, (c) => c.toUpperCase()) + "." };
  },

  // Story points done against the target share, from Jira or the planning form.
  points_complete(params, snapshot) {
    const r = need(snapshot, "points");
    if (r.error) return unavailable("story points", r.error);
    const p = r.value;
    if (!p.total) return { status: "pending", detail: "No story points on the release tickets." };
    const pct = Math.round((p.done / p.total) * 100);
    const target = params.minDonePct ?? 100;
    const detail = `${p.done} of ${p.total} points done (${pct}%), ${p.remaining} remaining.`;
    if (pct >= target) return { status: "pass", detail };
    return { status: pct < (params.failBelowPct ?? 70) ? "fail" : "warn", detail: `${detail} Target is ${target}%.` };
  },

  // Large tickets that are not finished.
  large_open(params, snapshot) {
    const r = need(snapshot, "points");
    if (r.error) return unavailable("story points", r.error);
    const big = r.value.bigOpen || [];
    if (!big.length) return { status: "pass", detail: "No large ticket is still open." };
    return { status: params.failAs || "warn", detail: `${plural(big.length, "large ticket", "large tickets")} still open: ${big.slice(0, 4).map((b) => `${b.key} (${b.points})`).join(", ")}.` };
  },

  // Vulnerability counts from a scanner.
  security_clear(params, snapshot) {
    const r = need(snapshot, "security");
    if (r.error) return unavailable("the security scan", r.error);
    const { critical = 0, high = 0 } = r.value;
    if (critical > 0) return { status: "fail", detail: `${plural(critical, "critical vulnerability", "critical vulnerabilities")} and ${high} high.` };
    if (high > 0) return { status: params.failAs || "warn", detail: `${plural(high, "high vulnerability", "high vulnerabilities")}, none critical.` };
    return { status: "pass", detail: "No critical or high vulnerabilities." };
  },

  // A measured number against a budget: max for "must not exceed", min for "must not fall below".
  metric_budget(params, snapshot) {
    const r = need(snapshot, params.key);
    if (r.error) return unavailable(params.label || params.key, r.error);
    const v = Number(r.value);
    const unit = params.unit || "";
    const fmt = (n) => `${n > 0 && params.signed ? "+" : ""}${n}${unit}`;
    if (params.max !== undefined && v > params.max) return { status: params.failAs || "fail", detail: `${fmt(v)} is over the budget of ${fmt(params.max)}.` };
    if (params.min !== undefined && v < params.min) return { status: params.failAs || "warn", detail: `${fmt(v)} is under the floor of ${fmt(params.min)}.` };
    return { status: "pass", detail: `${fmt(v)} is within budget.` };
  },

  // Pre-release runbook steps that are late or blocked.
  runbook_ready(params, snapshot) {
    const r = need(snapshot, "runbook");
    if (r.error) return unavailable("the runbook", r.error);
    const { total, done, overdue = [], blocked = [] } = r.value;
    if (!total) return { status: "pending", detail: "The runbook has no steps." };
    if (blocked.length) return { status: params.failAs || "warn", detail: `${plural(blocked.length, "step is", "steps are")} blocked: ${blocked.slice(0, 3).join(", ")}.` };
    if (overdue.length) return { status: params.failAs || "warn", detail: `${plural(overdue.length, "pre-release step is", "pre-release steps are")} overdue: ${overdue.slice(0, 3).join(", ")}.` };
    return { status: "pass", detail: `${done} of ${total} steps done and none overdue.` };
  },
};

/** Waivers are accepted risk. They need a named approver and a reason, and they expire if things get worse. */
function applyWaiver(result, waiver) {
  if (!waiver || result.status === "pass") return { effective: result.status, waiver: null };
  const valid = Boolean(waiver.approver?.trim() && waiver.reason?.trim());
  const waivedAt = waiver.statusAtWaive ?? result.status;
  const stale = SEVERITY[result.status] > SEVERITY[waivedAt];
  return {
    effective: valid && !stale ? "waived" : result.status,
    waiver: { approver: waiver.approver, reason: waiver.reason, at: waiver.at, statusAtWaive: waivedAt, valid, stale },
  };
}

export function evaluate(snapshot, config, state = {}) {
  const criteria = [];
  for (const def of config.criteria || []) {
    const source = def.source || "github";
    if (source !== "manual" && snapshot.sources?.[source] === "off") continue;

    const evaluator = EVALUATORS[def.type];
    let r;
    if (!evaluator) r = { status: "pending", detail: `Unknown criterion type "${def.type}".` };
    else {
      try { r = evaluator(def.params || {}, snapshot, state, config); }
      catch (e) { r = { status: "pending", detail: `Evaluator error: ${e.message}` }; }
    }
    const { effective, waiver } = applyWaiver(r, state.waivers?.[def.id]);
    criteria.push({
      id: def.id,
      name: def.name,
      required: def.required !== false,
      source,
      type: def.type,
      status: r.status,
      effective,
      detail: r.detail,
      waiver,
      checkId: def.type === "manual" ? def.params?.checkId : undefined,
    });
  }

  const counts = { pass: 0, warn: 0, fail: 0, pending: 0, waived: 0 };
  criteria.forEach((c) => { counts[c.effective]++; });
  const required = criteria.filter((c) => c.required);
  const failing = required.filter((c) => c.effective === "fail");
  const open = required.filter((c) => c.effective === "warn" || c.effective === "pending");

  let call, reason;
  if (!criteria.length) { call = "HOLD"; reason = "No criteria are configured."; }
  else if (failing.length) { call = "NO-GO"; reason = `${plural(failing.length, "required criterion is", "required criteria are")} failing.`; }
  else if (open.length) { call = "HOLD"; reason = `Nothing is failing, but ${plural(open.length, "required criterion is", "required criteria are")} not yet clear.`; }
  else { call = "GO"; reason = counts.waived ? `All required criteria are met, with ${counts.waived} waived.` : "All required criteria are met."; }

  return {
    criteria,
    verdict: {
      call,
      reason,
      counts,
      holding: failing.concat(open).map((c) => c.id),
    },
  };
}

export function openBlockerCount(snapshot) {
  return Array.isArray(snapshot.data?.blockers) ? snapshot.data.blockers.length : null;
}
