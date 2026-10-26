// The release plan: the form model, its defaults, the runbook generator, and the bridge to the
// readiness engine (planToSnapshot + planConfig). Pure functions. Runs in Node and in the browser.

import { num, parseLocal, summarizePoints, DONE } from "./risk.js";
import { analyzeDependencies } from "./deps.js";

export const TYPES = ["Major release", "Minor release", "Patch", "Hotfix"];
export const PRIORITIES = ["P0", "P1", "P2", "P3"];
export const TICKET_TYPES = ["Story", "Bug", "Task"];
export const STATUSES = ["To do", "In progress", "In review", "Done"];
export const AREAS = ["Payments", "Auth", "Data", "Core", "Mobile", "UI", "Infra", "Security"];
export const ENVIRONMENTS = ["staging", "prod-us", "prod-eu", "prod-apac"];
export const STRATEGIES = [
  { v: "canary", l: "Canary with staged percentages" },
  { v: "phased", l: "Region by region" },
  { v: "bluegreen", l: "Blue/green switch" },
  { v: "bigbang", l: "All at once" },
];
export const CHECK_STATES = [
  { v: "unset", l: "Not done" },
  { v: "pass", l: "Passed" },
  { v: "fail", l: "Failed" },
  { v: "na", l: "Not applicable" },
];
/** Lists and switches a project can change. Everything the forms offer comes from here, not from code. */
export const defaultSettings = () => ({
  areas: [...AREAS],
  sensitiveAreas: ["Payments", "Auth", "Data"],
  environments: [...ENVIRONMENTS],
  criteria: {}, // { [criterionId]: { on?: boolean, required?: boolean } } overrides to the built-in criteria
});

export const PHASES = ["Pre-release", "Go/no-go", "Deploy", "Verify", "After"];

/** How a release turned out. Empty until someone records it; once set, the release counts as closed. */
export const OUTCOMES = ["Shipped cleanly", "Shipped with issues", "Rolled back", "Cancelled"];
export const emptyOutcome = () => ({ status: "", at: "", note: "", snapshot: null });
export const isClosed = (plan) => Boolean(plan?.outcome?.status);
export const ROLE_KEYS = [
  ["releaseManager", "Release manager"], ["engOwner", "Engineering owner"], ["qaLead", "QA lead"],
  ["productOwner", "Product owner"], ["sre", "SRE on-call"], ["security", "Security approver"], ["comms", "Comms owner"],
];

/** Defaults a release type pre-fills. Dates are left alone. */
export const TEMPLATES = {
  "Major release": { strategy: "canary", flagsDefaultOff: true, rollbackMinutes: 30, windowHours: 4, roles: ["QA", "Product", "Security", "SRE on-call"] },
  "Minor release": { strategy: "canary", flagsDefaultOff: true, rollbackMinutes: 20, windowHours: 2, roles: ["QA", "Product", "SRE on-call"] },
  Patch: { strategy: "canary", flagsDefaultOff: false, rollbackMinutes: 15, windowHours: 1, roles: ["QA", "SRE on-call"] },
  Hotfix: { strategy: "canary", flagsDefaultOff: false, rollbackMinutes: 10, windowHours: 1, roles: ["QA", "SRE on-call"] },
};

const pad = (n) => String(n).padStart(2, "0");
/** ms -> "YYYY-MM-DDTHH:mm" in local time, the format datetime-local inputs use. */
export const fmtLocal = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const shift = (local, minutes) => { const t = parseLocal(local); return t === null ? "" : fmtLocal(t + minutes * 60000); };
const dayAt = (now, offsetDays, hour) => { const d = new Date(now); d.setDate(d.getDate() + offsetDays); d.setHours(hour, 0, 0, 0); return fmtLocal(d.getTime()); };

/** The first given weekday (0 = Sunday) at least minDays from now, at the given hour. */
const nextWeekday = (now, minDays, dow, hour) => {
  const d = new Date(now);
  d.setDate(d.getDate() + minDays);
  d.setHours(hour, 0, 0, 0);
  while (d.getDay() !== dow) d.setDate(d.getDate() + 1);
  return fmtLocal(d.getTime());
};

const t = (key, summary, type, priority, points, status, assignee, area, tags = {}) => ({
  key, summary, type, priority, points, status, assignee, area, team: "", blockedBy: "",
  tags: { migration: false, customerFacing: false, untested: false, ...tags },
});

/** A realistic example, so the page opens filled in. Every name and number is invented. */
export function defaultPlan(now = Date.now()) {
  const plan = {
    release: {
      name: "Release 4.12", version: "4.12.0", type: "Minor release", fixVersion: "4.12", autoSync: false, slackAlerts: true,
      summary: "Multi-currency invoices, push token refresh for Android, and a faster orders page. Includes migration 0412 on the orders table.",
      customerImpact: "Billing customers see invoices in their own currency. Android users on OS 14+ keep push notifications after token refresh.",
    },
    people: {
      releaseManager: "Sam Okafor", engOwner: "Dana Kowalski", qaLead: "Jo Mbeki", productOwner: "Rin Aoki",
      sre: "Hiro Nakamura", security: "Tomas Vega", comms: "Ana Ribeiro",
    },
    extraPeople: [], // custom { label, name } fields the user adds under "Who is involved"
    when: { freezeAt: dayAt(now, -4, 0), meetingAt: dayAt(now, 2, 14), deployAt: dayAt(now, 3, 2), windowHours: 2 },
    where: {
      repo: "acme/web", baseRef: "v4.11.0", headRef: "release/4.12",
      environments: ["staging", "prod-us", "prod-eu"], services: "orders-api, billing, web-app, push-gateway",
    },
    how: {
      strategy: "canary", flagsDefaultOff: true, rollbackMinutes: 20, channel: "#release-412",
      rollbackPlan: "Disable the multi-currency flag first. If errors persist, redeploy 4.11.0 from the previous artifact. Migration 0412 is additive, so no data rollback is needed.",
      dashboards: "grafana/release-412, sentry/web-prod, status page draft",
      verification: "Checkout with USD, EUR and GBP carts. Push token refresh on an Android 14 device. Orders page p95 under 800 ms.",
    },
    scope: { velocity: 9, bigAt: 8, maxFiles: 400, maxLines: 15000 },
    tickets: [
      t("REL-2841", "Checkout total wrong for multi-currency carts", "Bug", "P0", 3, "In review", "Dana K.", "Payments", { customerFacing: true }),
      t("REL-2790", "Migration 0412 holds a lock on orders for 38s", "Bug", "P1", 5, "In progress", "Marcus T.", "Data", { migration: true }),
      t("REL-2877", "Android push token refresh crashes on OS 14+", "Bug", "P1", 3, "In progress", "Priya S.", "Mobile", { customerFacing: true }),
      t("REL-2903", "Settings tooltip clipped in Safari 17", "Bug", "P2", 1, "To do", "Lee W.", "UI"),
      t("REL-2750", "Multi-currency invoices", "Story", "P1", 13, "In progress", "Ana R.", "Payments", { customerFacing: true, untested: true }),
      t("REL-2744", "Orders page query rewrite", "Story", "P2", 8, "In review", "Jo M.", "Core"),
      t("REL-2731", "Saved filters on orders page", "Story", "P2", 5, "Done", "Dana K.", "Core"),
      t("REL-2728", "Notification preferences screen", "Story", "P2", 5, "Done", "Priya S.", "Mobile", { customerFacing: true }),
      t("REL-2719", "Empty states for reports", "Story", "P2", 3, "Done", "Lee W.", "UI"),
      t("REL-2715", "Rotate staging credentials", "Task", "P3", 2, "Done", "Marcus T.", "Infra"),
      t("REL-2702", "Session timeout warning", "Story", "P1", 8, "Done", "Ana R.", "Auth", { customerFacing: true }),
      t("REL-2699", "CSV export for invoices", "Story", "P2", 5, "Done", "Jo M.", "Core"),
      t("REL-2688", "Dark mode for settings", "Story", "P3", 0, "To do", "Lee W.", "UI"),
      t("REL-2681", "Upgrade http-parse", "Task", "P3", 3, "Done", "Tomas V.", "Security"),
    ],
    signals: {
      ci: { total: 1546, realFailures: "", flaky: 6, pending: 0 },
      openPrs: 3, failingOpenPrs: 1, mergedTotal: 28, lateMerged: 3, mergedUnapproved: 2,
      filesChanged: 318, linesChanged: 12600, commits: 142, authors: 23,
      coverageDeltaPp: -0.3, coverageFloorPp: -1, p95DeltaPct: 4.2, p95BudgetPct: 5,
      securityCritical: 0, securityHigh: 1,
    },
    checks: { migration: "fail", rollback: "pass", notes: "unset", errorbudget: "pass" },
    handoffs: [], // { what, from, to, owner, due, status, blocks } work handed from one team to another
    signoffs: [
      { role: "QA", who: "Jo M.", approved: true },
      { role: "Product", who: "Rin A.", approved: true },
      { role: "Security", who: "Tomas V.", approved: false },
      { role: "SRE on-call", who: "Hiro N.", approved: false },
    ],
    runbook: [],
    waivers: {},
    settings: defaultSettings(),
    customChecks: [],
    outcome: emptyOutcome(),
  };
  // Example dependencies, so the page shows how they read.
  const set = (key, patch) => Object.assign(plan.tickets.find((x) => x.key === key), patch);
  set("REL-2841", { team: "Backend" });
  set("REL-2790", { team: "Backend" });
  set("REL-2750", { team: "Frontend", blockedBy: "REL-2841" });
  set("REL-2744", { team: "Frontend", blockedBy: "REL-2790" });
  set("REL-2877", { team: "Mobile" });
  set("REL-2903", { team: "Frontend" });
  plan.handoffs = [
    { what: "Final invoice designs", from: "Design", to: "Frontend", owner: "Rin Aoki", due: dayAt(now, -6, 17), status: "Done", blocks: "REL-2750" },
    { what: "Android 14 test devices for QA", from: "DevOps", to: "QA", owner: "Hiro Nakamura", due: dayAt(now, -1, 12), status: "In progress", blocks: "REL-2877" },
  ];
  plan.raid = [
    { id: "xe1", type: "Risk", title: "Android 14 test devices may not arrive before the freeze", owner: "Hiro Nakamura", due: dayAt(now, 1, 12), status: "Open", rating: "High", response: "Use the cloud device farm if the physical devices slip.", source: "" },
    { id: "xe2", type: "Assumption", title: "The orders table migration finishes inside the 30-minute window", owner: "Dana Kowalski", due: dayAt(now, 1, 17), status: "Unchecked", rating: "Medium", response: "Rerun the dry run on production-size data.", source: "" },
    { id: "xe3", type: "Dependency", title: "Billing team must publish the currency rates API", owner: "Sam Okafor", due: dayAt(now, 2, 17), status: "In progress", rating: "Medium", response: "", source: "" },
  ];
  plan.runbook = generateRunbook(plan);
  return plan;
}

/**
 * Bring a fresh list of tickets from Jira into the ones already in the plan, matched by key.
 * Status, points, priority and the rest come from Jira; the team a person chose, tags they ticked and
 * blockers they typed are kept when Jira has nothing to say. Tickets that are only in the plan stay.
 */
export function mergeTickets(current = [], remote = []) {
  const stable = (v) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
  const norm = (t) => ({ team: "", blockedBy: "", ...t, tags: { ...(t.tags || {}) } });
  const up = (k) => String(k).toUpperCase();
  const incoming = new Map((remote || []).map((r) => [up(r.key), r]));
  const seen = new Set();
  let updated = 0, kept = 0;
  const tickets = (current || []).map((t) => {
    const r = incoming.get(up(t.key));
    if (!r) { kept++; return t; }
    seen.add(up(t.key));
    const before = norm(t);
    const merged = { ...before, ...r, team: before.team || r.team || "", blockedBy: r.blockedBy || before.blockedBy || "", tags: { ...(r.tags || {}), ...before.tags } };
    if (stable(merged) === stable(before)) return t; // nothing changed, so keep the original object
    updated++;
    return merged;
  });
  const added = (remote || []).filter((r) => !seen.has(up(r.key))).map(norm);
  return { tickets: [...tickets, ...added], updated, added: added.length, kept };
}

/** Fill in the fields a release type normally has. Keeps people, dates and tickets. */
export function applyTemplate(plan, type) {
  const tpl = TEMPLATES[type];
  if (!tpl) return plan;
  plan.release.type = type;
  plan.how.strategy = tpl.strategy;
  plan.how.flagsDefaultOff = tpl.flagsDefaultOff;
  plan.how.rollbackMinutes = tpl.rollbackMinutes;
  plan.when.windowHours = tpl.windowHours;
  const prior = new Map(plan.signoffs.map((s) => [s.role, s]));
  const who = { QA: plan.people.qaLead, Product: plan.people.productOwner, Security: plan.people.security, "SRE on-call": plan.people.sre };
  plan.signoffs = tpl.roles.map((role) => prior.get(role) || { role, who: who[role] || "", approved: false });
  plan.runbook = generateRunbook(plan);
  return plan;
}

/** An empty release: only sensible defaults. Dates land on a Tuesday 2 AM deploy at least a week out. */
export function blankPlan(now = Date.now(), type = "Minor release") {
  const deployAt = nextWeekday(now, 8, 2, 2);
  const plan = {
    release: { name: "", version: "", type, fixVersion: "", autoSync: false, slackAlerts: true, summary: "", customerImpact: "" },
    people: Object.fromEntries(ROLE_KEYS.map(([k]) => [k, ""])),
    extraPeople: [],
    when: { freezeAt: shift(deployAt, -5 * 1440), meetingAt: shift(deployAt, -12 * 60), deployAt, windowHours: 2 },
    where: { repo: "", baseRef: "", headRef: "", environments: ["staging", "prod-us"], services: "" },
    how: { strategy: "canary", flagsDefaultOff: true, rollbackMinutes: 20, channel: "", rollbackPlan: "", dashboards: "", verification: "" },
    scope: { velocity: 0, bigAt: 8, maxFiles: 400, maxLines: 15000 },
    tickets: [],
    signals: {
      ci: { total: 0, realFailures: "", flaky: 0, pending: 0 },
      openPrs: 0, failingOpenPrs: 0, mergedTotal: 0, lateMerged: 0, mergedUnapproved: 0,
      filesChanged: 0, linesChanged: 0, commits: 0, authors: 0,
      coverageDeltaPp: 0, coverageFloorPp: -1, p95DeltaPct: 0, p95BudgetPct: 5, securityCritical: 0, securityHigh: 0,
    },
    checks: { migration: "unset", rollback: "unset", notes: "unset", errorbudget: "unset" },
    handoffs: [],
    raid: [], raidDismissed: [], // the RAID log (see raid.js) and the suggestions a person turned down
    signoffs: [], runbook: [], waivers: {},
    settings: defaultSettings(),
    customChecks: [], // { id, name, required, state } checks a person defines and confirms
    outcome: emptyOutcome(),
  };
  return applyTemplate(plan, type);
}

/**
 * The next release in a series: keeps what rarely changes (people, repository, environments, rollout and
 * rollback settings, budgets, which sign-offs are needed) and clears what belongs to one release
 * (name, dates, tickets, quality signals, checks, approvals, waivers).
 */
export function nextPlan(prev, now = Date.now()) {
  const keep = JSON.parse(JSON.stringify(prev));
  const fresh = blankPlan(now, keep.release.type);
  const next = {
    ...fresh,
    people: keep.people,
    extraPeople: keep.extraPeople || [],
    where: { ...keep.where, baseRef: "", headRef: "" },
    how: { ...keep.how },
    scope: keep.scope,
    signals: { ...fresh.signals, coverageFloorPp: keep.signals.coverageFloorPp, p95BudgetPct: keep.signals.p95BudgetPct },
    signoffs: keep.signoffs.map((x) => ({ ...x, approved: false })),
    settings: keep.settings || defaultSettings(),
    customChecks: (keep.customChecks || []).map((c) => ({ ...c, state: "unset" })),
    // Open risks and assumptions carry over to the next release; issues and dependencies belong to the one they were found in.
    raid: (Array.isArray(keep.raid) ? keep.raid : []).filter((r) => r && (r.type === "Risk" || r.type === "Assumption") && !["Closed", "Confirmed", "Wrong"].includes(r.status)).map((r) => ({ ...r, id: "x" + now.toString(36) + Math.random().toString(36).slice(2, 5), source: "" })),
  };
  next.runbook = generateRunbook(next);
  return next;
}

const hasMigration = (plan) => plan.tickets.some((x) => x.tags?.migration) || (plan.checks.migration && plan.checks.migration !== "na");

/** The step-by-step runbook, with owners and times worked out from the plan's dates. */
export function generateRunbook(plan) {
  const { when, people, how, where } = plan;
  const D = when.deployAt, F = when.freezeAt, M = when.meetingAt;
  const rows = [];
  let n = 0;
  const row = (phase, step, owner, at) => rows.push({ id: `s${++n}`, phase, step, owner: owner || "", at: at || "", status: "todo" });

  row("Pre-release", "Cut the release branch and freeze scope", people.releaseManager, F);
  row("Pre-release", "Draft release notes", people.comms, shift(D, -3 * 1440));
  if (hasMigration(plan)) row("Pre-release", "Dry-run the migration on production-size data", people.sre, shift(D, -3 * 1440));
  row("Pre-release", "Rehearse the rollback on staging", people.sre, shift(D, -2 * 1440));
  row("Pre-release", "QA regression sign-off", people.qaLead, shift(D, -2 * 1440));
  if (plan.signoffs.some((s) => s.role === "Security")) row("Pre-release", "Security scan and sign-off", people.security, shift(D, -2 * 1440));
  row("Go/no-go", "Go/no-go meeting", people.releaseManager, M);
  row("Deploy", `Announce the deploy window in ${how.channel || "the release channel"}`, people.comms, shift(D, -60));
  if (hasMigration(plan)) row("Deploy", "Run the database migration", people.sre, D);

  const prod = where.environments.filter((e) => e.startsWith("prod"));
  if (how.strategy === "canary") {
    [5, 25, 50, 100].forEach((pct, i) => {
      row("Deploy", `Roll out to ${pct}% of traffic${pct === 100 ? "" : ", watch for 30 minutes"}`, i === 0 ? people.releaseManager : people.sre, shift(D, 10 + i * 40));
    });
  } else if (how.strategy === "phased") {
    (prod.length ? prod : ["production"]).forEach((env, i) => row("Deploy", `Deploy to ${env}${i < prod.length - 1 ? ", watch for 30 minutes" : ""}`, people.sre, shift(D, 10 + i * 45)));
  } else if (how.strategy === "bluegreen") {
    row("Deploy", "Deploy to the idle (green) environment", people.sre, shift(D, 10));
    row("Deploy", "Run smoke tests against green", people.qaLead, shift(D, 30));
    row("Deploy", "Switch traffic to green", people.releaseManager, shift(D, 45));
  } else {
    row("Deploy", "Deploy to all production environments", people.sre, shift(D, 10));
  }

  row("Verify", "Run the verification checklist", people.qaLead, shift(D, 30 + (how.strategy === "canary" ? 120 : 30)));
  row("Verify", "Check error rate and latency dashboards", people.sre, shift(D, 45 + (how.strategy === "canary" ? 120 : 30)));
  row("Verify", "Rollback decision point", people.releaseManager, shift(D, num(how.rollbackMinutes, 20) + 60));
  row("After", "Publish release notes", people.comms, shift(D, 240));
  row("After", `Close the Jira fix version ${plan.release.fixVersion || ""}`.trim(), people.releaseManager, shift(D, 1440));
  row("After", "Schedule the post-release review", people.releaseManager, shift(D, 1440));
  return rows;
}

const HANDOFF_RUN = { "Not started": "todo", "In progress": "doing", Done: "done", Blocked: "blocked" };
const handoffId = (h) => `${String(h.what || "").trim()}|${h.from || ""}|${h.to || ""}`;

/**
 * Keep the runbook in step with the handoffs. A handoff that is not Done gets a Pre-release step (owner and time
 * come from the handoff). A step made earlier follows its handoff's status. Nothing is removed, and steps a person
 * made by hand are never touched. Returns how many steps were added and how many changed status.
 */
export function syncHandoffSteps(plan) {
  const rows = (plan.runbook ||= []);
  let n = rows.reduce((m, r) => Math.max(m, Number(String(r.id).replace(/\D/g, "")) || 0), 0);
  const made = new Map(rows.filter((r) => r.handoff).map((r) => [r.handoff, r]));
  const fresh = [];
  let updated = 0;
  for (const h of plan.handoffs || []) {
    if (!String(h.what || "").trim()) continue;
    const id = handoffId(h), status = HANDOFF_RUN[h.status] || "todo", have = made.get(id);
    if (have) { if (have.status !== status) { have.status = status; updated++; } continue; }
    if (h.status === "Done") continue; // already handed over, so there is nothing left to do
    fresh.push({ h, row: { id: `s${++n}`, phase: "Pre-release", step: `Handoff: ${String(h.what).trim()} (${h.from || "?"} to ${h.to || "?"})`, owner: h.owner || plan.people?.releaseManager || "", at: h.due || plan.when?.freezeAt || "", status, handoff: id } });
  }
  fresh.sort((a, b) => String(a.row.at).localeCompare(String(b.row.at)));
  const at = rows.findIndex((r) => r.phase !== "Pre-release"); // keep them with the other pre-release steps
  rows.splice(at < 0 ? rows.length : at, 0, ...fresh.map((f) => f.row));
  return { added: fresh.length, updated };
}

/** Summary the engine's runbook_ready criterion reads. Only pre-release and go/no-go steps can be overdue. */
export function runbookStatus(plan, now) {
  const rows = plan.runbook || [];
  const overdue = rows.filter((r) => ["Pre-release", "Go/no-go"].includes(r.phase) && r.status !== "done" && r.at && parseLocal(r.at) < now).map((r) => r.step);
  return { total: rows.length, done: rows.filter((r) => r.status === "done").length, blocked: rows.filter((r) => r.status === "blocked").map((r) => r.step), overdue };
}

const toIso = (local) => { const ms = parseLocal(local); return ms === null ? undefined : new Date(ms).toISOString(); };

/** Turn the form into the snapshot shape the engine reads, so one engine serves both pages. */
export function planToSnapshot(plan, now = Date.now()) {
  const s = plan.signals;
  const freezeMs = parseLocal(plan.when.freezeAt) ?? now;
  const pts = summarizePoints(plan.tickets, num(plan.scope.bigAt, 8));

  const blockers = plan.tickets
    .filter((x) => x.type === "Bug" && x.status !== DONE && ["P0", "P1", "P2"].includes(x.priority))
    .map((x) => ({ key: x.key, sev: x.priority, title: x.summary, owner: x.assignee || "Unassigned", ageDays: 0, status: x.status, source: "jira" }));

  const real = String(s.ci.realFailures || "").split("\n").map((x) => x.trim()).filter(Boolean);
  const flaky = Array.from({ length: Math.max(0, num(s.ci.flaky)) }, (_, i) => `flaky check ${i + 1} (quarantine)`);
  const pending = Array.from({ length: Math.max(0, num(s.ci.pending)) }, (_, i) => `pending check ${i + 1}`);
  const total = Math.max(num(s.ci.total), real.length + flaky.length + pending.length);

  const mergedTotal = Math.max(0, num(s.mergedTotal));
  const late = Math.min(mergedTotal, Math.max(0, num(s.lateMerged)));
  const unapproved = Math.min(mergedTotal, Math.max(0, num(s.mergedUnapproved)));
  const mergedPrs = Array.from({ length: mergedTotal }, (_, i) => ({
    number: i + 1,
    mergedAt: new Date(i < late ? freezeMs + (i + 1) * 3600000 : freezeMs - (i + 1) * 3600000).toISOString(),
    approved: i >= unapproved,
  }));

  const openPrs = Array.from({ length: Math.max(0, num(s.openPrs)) }, (_, i) => ({
    number: i + 1, checks: i < num(s.failingOpenPrs) ? "failing" : "passing",
  }));

  return {
    release: { name: plan.release.name || "Untitled release", repo: plan.where.repo, freezeDate: toIso(plan.when.freezeAt) },
    sources: { github: "ok", jira: "ok" },
    errors: {},
    data: {
      blockers,
      ci: { total, passed: Math.max(0, total - real.length - flaky.length - pending.length), failed: [...real, ...flaky], pending },
      openPrs, mergedPrs,
      compare: { commits: num(s.commits), filesChanged: num(s.filesChanged), truncated: false, additions: num(s.linesChanged), deletions: 0, authors: num(s.authors) },
      draftRelease: { exists: plan.checks.notes === "pass" },
      signoffs: plan.signoffs.map((x) => ({ role: x.role, approved: Boolean(x.approved) })),
      points: { total: pts.total, done: pts.done, remaining: pts.remaining, bigOpen: pts.bigOpen },
      security: { critical: num(s.securityCritical), high: num(s.securityHigh) },
      p95DeltaPct: num(s.p95DeltaPct), coverageDeltaPp: num(s.coverageDeltaPp),
      runbook: runbookStatus(plan, now),
      deps: analyzeDependencies(plan.tickets, plan.handoffs, now, freezeMs),
    },
  };
}

/** Manual checks and waivers in the shape the engine's state argument uses. */
export function planState(plan) {
  const notes = { na: "Not applicable to this release." };
  const manual = {};
  for (const id of ["migration", "rollback", "errorbudget"]) {
    const v = plan.checks[id];
    if (!v || v === "unset") continue;
    manual[id] = { state: v === "na" ? "pass" : v, by: plan.people.releaseManager, note: notes[v] || "" };
  }
  for (const c of plan.customChecks || []) {
    if (!c.state || c.state === "unset") continue;
    manual[`custom-${c.id}`] = { state: c.state === "na" ? "pass" : c.state, by: plan.people.releaseManager, note: c.state === "na" ? notes.na : "" };
  }
  return { manual, waivers: plan.waivers || {} };
}

/** Which criteria apply, and how strict they are. */
export function planConfig(plan) {
  const sig = plan.signals;
  const overrides = plan.settings?.criteria || {};
  const builtIn = [
      { id: "p0", name: "No open P0 defects", type: "blockers_none", params: { severity: "P0" } },
      { id: "p1", name: "No open P1 defects", type: "blockers_none", params: { severity: "P1", failAs: "warn" } },
      { id: "points", name: "Story points complete", type: "points_complete", params: { minDonePct: 100, failBelowPct: 70 } },
      { id: "big", name: "No large ticket left open", type: "large_open", required: false },
      { id: "deps", name: "Dependencies clear", type: "dependencies_clear", required: false, params: { waitingAs: "warn" } },
      { id: "ci", name: "Release branch checks green", type: "ci_green" },
      { id: "migration", name: "Migration dry run on production-size data", type: "manual", source: "manual", params: { checkId: "migration" } },
      { id: "prs", name: "All scoped PRs merged", type: "open_prs", params: { failAs: "warn" } },
      { id: "signoffs", name: "Sign-offs collected", type: "signoffs" },
      { id: "rollback", name: "Rollback rehearsed", type: "manual", source: "manual", params: { checkId: "rollback" } },
      { id: "security", name: "No critical or high vulnerabilities", type: "security_clear" },
      { id: "perf", name: "p95 latency within budget", type: "metric_budget", params: { key: "p95DeltaPct", max: num(sig.p95BudgetPct, 5), unit: "%", signed: true, label: "p95 latency" } },
      { id: "coverage", name: "Coverage within budget", type: "metric_budget", required: false, params: { key: "coverageDeltaPp", min: num(sig.coverageFloorPp, -1), unit: " pp", label: "coverage" } },
      { id: "reviews", name: "Every merged PR had an approval", type: "review_coverage", required: false, params: { max: 0, failAs: "warn" } },
      { id: "late", name: "Nothing merged after the freeze", type: "late_changes", required: false, params: { max: 0 } },
      { id: "size", name: "Release size within budget", type: "change_size", required: false, params: { maxFiles: num(plan.scope.maxFiles, 400), maxLines: num(plan.scope.maxLines, 15000) } },
      { id: "notes", name: "Release notes drafted", type: "draft_release", required: false },
      { id: "errorbudget", name: "Error budget above floor", type: "manual", source: "manual", required: false, params: { checkId: "errorbudget" } },
      { id: "runbook", name: "Pre-release steps on schedule", type: "runbook_ready", required: false },
  ];
  const chosen = builtIn
    .filter((c) => overrides[c.id]?.on !== false)
    .map((c) => (overrides[c.id]?.required === undefined ? c : { ...c, required: overrides[c.id].required }));
  const custom = (plan.customChecks || []).map((c) => ({
    id: `custom-${c.id}`, name: c.name || "Untitled check", type: "manual", source: "manual", required: c.required !== false, params: { checkId: `custom-${c.id}` },
  }));
  return { ci: { quarantine: ["quarantine"] }, criteria: [...chosen, ...custom] };
}

/** The built-in criteria, for the settings screen to list. */

const fmtWhen = (local) => { const ms = parseLocal(local); return ms === null ? "not set" : new Date(ms).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
const joinList = (a) => (a.length <= 1 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a.at(-1)}`);

/**
 * The report as data: sections made of paragraphs, lists, tables and checklists.
 * Markdown and HTML are both rendered from this, so they always say the same thing.
 */
export function reportModel(plan, result, risk, now = Date.now()) {
  const P = plan, { verdict, criteria } = result, pts = risk.points, fc = risk.forecast;
  const name = P.release.name || "Untitled release";
  const required = criteria.filter((c) => c.required);
  const clear = required.filter((c) => c.effective === "pass" || c.effective === "waived").length;
  const drivers = [...risk.factors].filter((f) => f.points > 0).sort((a, b) => b.points - a.points).slice(0, 3).map((f) => f.label.toLowerCase());
  const holding = criteria.filter((c) => verdict.holding.includes(c.id));
  const order = { fail: 0, warn: 1, pending: 2, waived: 3, pass: 4 };
  const sections = [];
  const sec = (title, ...blocks) => sections.push({ title, blocks });
  const ul = (items) => ({ t: "ul", items });
  const p = (text) => ({ t: "p", text });
  const table = (head, rows) => ({ t: "table", head, rows });

  sec("Summary",
    p(`${name} is ${verdict.call}. ${verdict.reason} Risk is ${risk.score} out of 100 (${risk.level})${drivers.length ? `, driven mostly by ${joinList(drivers)}` : ""}. ` +
      `${pts.total ? `${pts.done} of ${pts.total} story points are done (${pts.pctDone}%). ${fc.detail}` : "No story points have been entered."} ${clear} of ${required.length} required criteria are clear.`),
    ...(holding.length ? [{ t: "h3", text: "What is holding the release" }, ul(holding.map((c) => `${c.name} (${c.effective}): ${c.detail}`))] : []));

  sec("What", ul([
    `Release: ${name}${P.release.version ? ` (${P.release.version})` : ""}, ${P.release.type}`,
    `Jira fix version: ${P.release.fixVersion || "not set"}`,
    `Changes: ${P.release.summary || "not set"}`,
    `Customer impact: ${P.release.customerImpact || "not set"}`,
  ]));

  sec("Who", ul([
    ...ROLE_KEYS.map(([k, label]) => `${label}: ${P.people[k] || "not set"}`),
    ...(P.extraPeople || []).map((x) => `${x.label}: ${x.name || "not set"}`),
    ...((P.signoffs || []).length ? [`Sign-offs: ${P.signoffs.map((s) => `${s.role} (${s.who || "unassigned"}, ${s.approved ? "approved" : "pending"})`).join("; ")}`] : []),
  ]));

  sec("When", ul([
    `Code freeze: ${fmtWhen(P.when.freezeAt)}`,
    `Go/no-go meeting: ${fmtWhen(P.when.meetingAt)}`,
    `Deploy: ${fmtWhen(P.when.deployAt)} for ${P.when.windowHours} hours`,
  ]));

  sec("Where", ul([
    `Repository: ${P.where.repo || "not set"}${P.where.headRef ? `, ${P.where.headRef} compared with ${P.where.baseRef || "not set"}` : ""}`,
    `Environments: ${P.where.environments.join(", ") || "none selected"}`,
    `Services: ${P.where.services || "not set"}`,
  ]));

  sec("How", ul([
    `Rollout: ${risk.ladder.steps.join("% → ")}%, ${risk.ladder.bake} minute bake. ${risk.ladder.note}`,
    `Feature flags default off: ${P.how.flagsDefaultOff ? "yes" : "no"}`,
    `Rollback (${P.how.rollbackMinutes} minutes): ${P.how.rollbackPlan || "not written"}`,
    `Communication: ${P.how.channel || "not set"}. Dashboards: ${P.how.dashboards || "not set"}`,
    `Verification: ${P.how.verification || "not set"}`,
  ]));

  sec("Scope and story points",
    p(pts.total ? `${pts.done} of ${pts.total} points done (${pts.pctDone}%). ${pts.inFlight} in flight, ${pts.todo} not started. ${fc.detail}` : "No story points have been entered."),
    table(["Status", "Points"], STATUSES.map((st) => [st, String(pts.byStatus[st])])),
    ...(Object.keys(pts.byArea).length ? [table(["Area", "Done", "Total"], Object.entries(pts.byArea).sort((a, b) => b[1].total - a[1].total).map(([a, v]) => [a, String(v.done), String(v.total)]))] : []));

  const dep = analyzeDependencies(P.tickets, P.handoffs, now, parseLocal(P.when.freezeAt));
  if (dep.any) {
    const on = (w) => w.on.map((x) => x.kind === "handoff" ? `${x.what} (${x.team || "handoff"}, ${x.status})` : `${x.key} (${x.status})`).join(", ");
    sec("Dependencies",
      p(dep.cycles.length ? `Circular dependency: ${dep.cycles.map((c) => c.join(" → ") + " → " + c[0]).join("; ")}. None of those tickets can start.`
        : dep.waiting.length ? `${dep.waiting.length} open ${dep.waiting.length === 1 ? "ticket is" : "tickets are"} waiting on other work.` : "Every dependency is done."),
      ...(dep.finishFirst.length ? [{ t: "h3", text: "Finish these first" }, ul(dep.finishFirst.map((x) => `${x.key}${x.team ? ` (${x.team})` : ""} ${x.summary}: holds up ${x.unblocks} ${x.unblocks === 1 ? "ticket" : "tickets"}`))] : []),
      ...(dep.waiting.length ? [{ t: "h3", text: "Waiting" }, table(["Ticket", "Team", "Status", "Waiting on"], dep.waiting.map((w) => [`${w.key} ${w.summary}`, w.team || "", w.status, on(w)]))] : []),
      ...(dep.startedEarly.length ? [{ t: "h3", text: "Started before the input was done" }, ul(dep.startedEarly.map((w) => `${w.key} (${w.status}) is waiting on ${on(w)}`))] : []),
      ...(dep.ready.length ? [{ t: "h3", text: "Ready to start now" }, ul(dep.ready.map((x) => `${x.key} ${x.summary}`))] : []),
      ...((P.handoffs || []).length ? [{ t: "h3", text: "Handoffs between teams" }, table(["Handoff", "From", "To", "Owner", "Due", "Status", "Blocks"], P.handoffs.map((h2) => [h2.what, h2.from, h2.to, h2.owner || "", h2.due ? fmtWhen(h2.due) : "", h2.status, h2.blocks || ""]))] : []));
  }

  sec("Risk analysis",
    table(["Factor", "Points", "Detail"], [...risk.factors].sort((a, b) => b.points - a.points).map((f) => [f.label, `${f.points}/${f.max}`, f.detail])),
    ...(risk.recommendations.length ? [{ t: "h3", text: "What to do about it" }, { t: "ol", items: risk.recommendations.map((r) => ({ bold: r.label, text: r.advice })) }] : []));

  sec("Go/no-go criteria", {
    t: "checks",
    items: [...criteria].sort((a, b) => order[a.effective] - order[b.effective]).map((c) => ({
      done: c.effective === "pass" || c.effective === "waived", name: c.name, status: c.effective, advisory: !c.required, detail: c.detail,
      sub: c.waiver && c.effective === "waived" ? `Waived by ${c.waiver.approver}: ${c.waiver.reason}` : "",
    })),
  });

  const waived = criteria.filter((c) => c.effective === "waived" && c.waiver);
  if (waived.length) {
    sec("Accepted risks", table(["Criterion", "Was", "Approved by", "Reason", "When"], waived.map((c) => [c.name, c.waiver.statusAtWaive || "", c.waiver.approver, c.waiver.reason, c.waiver.at ? new Date(c.waiver.at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""])));
  }

  sec("Runbook", table(["When", "Phase", "Step", "Owner", "Status"], P.runbook.map((r) => [fmtWhen(r.at), r.phase, r.step, r.owner || "unassigned", r.status])));

  return { title: `${name} release report`, name, call: verdict.call, reason: verdict.reason, riskScore: risk.score, riskLevel: risk.level, generated: fmtWhen(fmtLocal(now)), sections };
}

const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

export function reportMarkdown(m) {
  const out = [`# ${m.title}`, "", `**Call: ${m.call}.** ${m.reason}  `, `**Risk: ${m.riskScore}/100 (${m.riskLevel}).** Generated ${m.generated}.`, ""];
  for (const s of m.sections) {
    out.push(`## ${s.title}`, "");
    for (const b of s.blocks) {
      if (b.t === "p") out.push(b.text, "");
      else if (b.t === "h3") out.push(`### ${b.text}`, "");
      else if (b.t === "ul") out.push(...b.items.map((x) => `- ${x}`), "");
      else if (b.t === "ol") out.push(...b.items.map((x, i) => `${i + 1}. **${x.bold}.** ${x.text}`), "");
      else if (b.t === "table") out.push(`| ${b.head.join(" | ")} |`, `|${b.head.map(() => "---").join("|")}|`, ...b.rows.map((r) => `| ${r.map(cell).join(" | ")} |`), "");
      else if (b.t === "checks") {
        for (const c of b.items) {
          out.push(`- [${c.done ? "x" : " "}] **${c.name}** (${c.status}${c.advisory ? ", advisory" : ""}): ${c.detail}`);
          if (c.sub) out.push(`  - ${c.sub}`);
        }
        out.push("");
      }
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

const h = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** HTML for the report body. Plain semantic tags so it pastes cleanly into Docs, Word, Confluence or Slack. */
export function reportHtml(m) {
  const out = [`<h1>${h(m.title)}</h1>`, `<p class="call call-${m.call.toLowerCase().replace(/[^a-z]/g, "")}"><strong>Call: ${h(m.call)}.</strong> ${h(m.reason)}<br><strong>Risk: ${m.riskScore}/100 (${h(m.riskLevel)}).</strong> Generated ${h(m.generated)}.</p>`];
  for (const s of m.sections) {
    out.push(`<h2>${h(s.title)}</h2>`);
    for (const b of s.blocks) {
      if (b.t === "p") out.push(`<p>${h(b.text)}</p>`);
      else if (b.t === "h3") out.push(`<h3>${h(b.text)}</h3>`);
      else if (b.t === "ul") out.push(`<ul>${b.items.map((x) => `<li>${h(x)}</li>`).join("")}</ul>`);
      else if (b.t === "ol") out.push(`<ol>${b.items.map((x) => `<li><strong>${h(x.bold)}.</strong> ${h(x.text)}</li>`).join("")}</ol>`);
      else if (b.t === "table") out.push(`<table><thead><tr>${b.head.map((x) => `<th>${h(x)}</th>`).join("")}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((x) => `<td>${h(x)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      else if (b.t === "checks") out.push(`<ul class="checks">${b.items.map((c) => `<li>${c.done ? "☑" : "☐"} <strong>${h(c.name)}</strong> <em>(${h(c.status)}${c.advisory ? ", advisory" : ""})</em>: ${h(c.detail)}${c.sub ? `<br><small>${h(c.sub)}</small>` : ""}</li>`).join("")}</ul>`);
    }
  }
  return out.join("\n");
}

/** A complete, printable HTML file: open it and use the browser's Print, then Save as PDF. */
export function reportDocument(m) {
  const css = `body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#15201c;max-width:860px;margin:32px auto;padding:0 20px}h1{font-size:26px;margin:0 0 8px}h2{font-size:17px;margin:28px 0 8px;padding-bottom:4px;border-bottom:1px solid #d8e0dc}h3{font-size:14px;margin:16px 0 6px}table{border-collapse:collapse;width:100%;margin:8px 0;font-size:13px}th,td{border:1px solid #d8e0dc;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f1f4f3}ul,ol{padding-left:22px}ul.checks{list-style:none;padding-left:0}ul.checks li{margin:6px 0}.call{padding:10px 14px;border-radius:8px;border:1px solid #d8e0dc;background:#f6f8f7}.call-nogo{background:#fbe2df;border-color:#b3261e}.call-hold{background:#fbefd2;border-color:#8f5a00}.call-go{background:#e0f2e8;border-color:#1b7a49}small{color:#5a6a64}@media print{body{margin:0;max-width:none}h2{break-after:avoid}table,li{break-inside:avoid}}`;
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${h(m.title)}</title>\n<style>${css}</style>\n</head>\n<body>\n${reportHtml(m)}\n</body>\n</html>\n`;
}

/** Word opens this as a normal document. It is HTML with Word's page settings, saved as .doc. */
export function reportWord(m) {
  return reportDocument(m).replace("<html lang=\"en\">", '<html lang="en" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">')
    .replace("</head>", "<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->\n</head>");
}

/** A one-page update for people who will not read the whole report: the call, why, the dates and the risks. */
export function statusModel(m) {
  const keep = ["Summary", "When", "Risk analysis", "Accepted risks"];
  return { ...m, title: `${m.name} status update`, sections: m.sections.filter((x) => keep.includes(x.title)) };
}

/** The report as Markdown. Kept under its original name for existing callers. */
export const briefMarkdown = (plan, result, risk, now = Date.now()) => reportMarkdown(reportModel(plan, result, risk, now));
