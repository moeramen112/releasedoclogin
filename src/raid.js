// RAID log: Risks, Assumptions, Issues, Dependencies. One list per release.
//
// Pure functions. No clock, no network, no disk. The same file runs on the server (AI check, agent) and in
// the browser (planner section, RAID page).
//
// How to change it
//  - The lists a person picks from (types, statuses, ratings) are the constants below.
//  - Where suggestions come from is the SOURCES array: each entry is { id, build(plan, ctx) } and returns
//    suggested items. Add one to teach the tool a new kind of suggestion; nothing else needs to change.
//  - A suggestion is only a suggestion. It becomes an item when a person accepts it, and a dismissed one
//    is remembered in plan.raidDismissed so it does not come back.

import { analyzeDependencies } from "./deps.js";
import { computeRisk, parseLocal, DONE } from "./risk.js";

export const RAID_TYPES = ["Risk", "Assumption", "Issue", "Dependency"];
export const RAID_STATUS = { Risk: ["Open", "Mitigating", "Closed"], Assumption: ["Unchecked", "Confirmed", "Wrong"], Issue: ["Open", "In progress", "Closed"], Dependency: ["Open", "In progress", "Closed"] };
export const RAID_RATINGS = ["High", "Medium", "Low"];
const CLOSED = new Set(["Closed", "Confirmed", "Wrong"]);
const RANK = { High: 0, Medium: 1, Low: 2 };

const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
/** A list from saved data: anything that is not an array becomes empty, and entries that are not objects are dropped. */
const objs = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
const asOf = (list, v, fallback) => (list.includes(v) ? v : fallback);

/** An empty item of one type. `source` is set on items that came from a suggestion. */
export function emptyRaid(type = "Risk", now = Date.now()) {
  const t = asOf(RAID_TYPES, type, "Risk");
  return { id: "x" + now.toString(36) + Math.random().toString(36).slice(2, 5), type: t, title: "", owner: "", due: "", status: RAID_STATUS[t][0], rating: "Medium", response: "", source: "" };
}

/** Make any saved value safe to use: unknown types and statuses fall back, text is trimmed, junk is dropped. */
export function cleanRaid(list) {
  const out = [];
  for (const r of Array.isArray(list) ? list : []) {
    if (!r || typeof r !== "object") continue;
    const type = asOf(RAID_TYPES, r.type, "Risk");
    out.push({
      id: clip(r.id, 40) || emptyRaid(type).id, type, title: clip(r.title, 200), owner: clip(r.owner, 80), due: clip(r.due, 20),
      status: asOf(RAID_STATUS[type], r.status, RAID_STATUS[type][0]), rating: asOf(RAID_RATINGS, r.rating, "Medium"),
      response: clip(r.response, 500), source: clip(r.source, 120),
    });
  }
  return out;
}

export const isClosedRaid = (r) => CLOSED.has(r.status);
export const isOverdue = (r, now = Date.now()) => !isClosedRaid(r) && parseLocal(r.due) !== null && parseLocal(r.due) < now;

/** Counts for the header line: open items by type, how many are high, how many are overdue, how many have no owner. */
export function summarizeRaid(list, now = Date.now()) {
  const open = (list || []).filter((r) => !isClosedRaid(r));
  return {
    open: open.length,
    byType: Object.fromEntries(RAID_TYPES.map((t) => [t, open.filter((r) => r.type === t).length])),
    high: open.filter((r) => r.rating === "High").length,
    overdue: open.filter((r) => isOverdue(r, now)).length,
    noOwner: open.filter((r) => !r.owner.trim()).length,
    closed: (list || []).length - open.length,
  };
}

/* ---------- suggestions ---------- */

const sug = (type, title, source, rating, response = "", owner = "", due = "") => ({ type, title: clip(title, 200), source, rating, response: clip(response, 500), owner: clip(owner, 80), due });

/**
 * Where suggestions come from. Each build() gets the plan and a context { now, clashes } and returns an
 * array of suggestions. `source` must be stable, because it is how a suggestion is recognised later.
 */
export const SOURCES = [
  { id: "handoffs", build(plan, { now }) {
    const dep = analyzeDependencies(objs(plan.tickets), objs(plan.handoffs), now, parseLocal(plan.when?.freezeAt));
    return dep.overdue.map((h) => sug("Dependency", `${h.what} (${h.from || "?"} to ${h.to || "?"}) is overdue`, `handoff|${clip(h.what, 60)}|${h.from}|${h.to}`, "High", "Ask the owner for a new date.", (objs(plan.handoffs).find((x) => x.what === h.what) || {}).owner, h.due));
  } },
  { id: "waiting", build(plan, { now }) {
    const dep = analyzeDependencies(objs(plan.tickets), objs(plan.handoffs), now, parseLocal(plan.when?.freezeAt));
    return dep.waiting.slice(0, 5).map((w) => sug("Dependency", `${w.key} waits on ${w.on.map((x) => (x.kind === "handoff" ? x.what : x.key)).join(", ")}`, `waiting|${w.key}`, w.status === "In progress" || w.status === "In review" ? "High" : "Medium", "Finish the blocking work first, or agree a way to work in parallel."));
  } },
  { id: "bugs", build(plan) {
    return objs(plan.tickets).filter((t) => t.type === "Bug" && t.status !== DONE && ["P0", "P1"].includes(t.priority))
      .map((t) => sug("Issue", `${t.key}: ${clip(t.summary, 90) || "open bug"} (${t.priority})`, `bug|${t.key}`, "High", "Fix before the freeze, or agree a waiver.", t.assignee));
  } },
  { id: "checks", build(plan) {
    const c = plan.checks || {};
    return [["migration", "The migration dry run failed"], ["rollback", "The rollback has not been rehearsed or it failed"]].filter(([k]) => c[k] === "fail")
      .map(([k, text]) => sug("Issue", text, `check|${k}`, "High", "Re-run it and record the result.", plan.people?.engineeringOwner));
  } },
  { id: "risk", build(plan, { now }) {
    let r; try { r = computeRisk(plan, now); } catch { return []; }
    return r.factors.filter((f) => f.max > 0 && f.points / f.max >= 0.6 && !["dependencies", "blockers"].includes(f.id))
      .map((f) => sug("Risk", `${f.label}: ${clip(f.detail, 120)}`, `risk|${f.id}`, f.points / f.max >= 0.85 ? "High" : "Medium", f.advice));
  } },
  { id: "schedule", build(plan, { clashes = [] }) {
    return clashes.filter((c) => c.severity !== "low").slice(0, 3).map((c) => sug("Risk", c.text, `clash|${c.id}`, c.severity === "high" ? "High" : "Medium", "Agree which release moves, or add a safeguard."));
  } },
];

/**
 * Suggested items for one release, minus anything already in the log or dismissed.
 *  ctx { now, clashes, max }  clashes come from schedule.js conflictsFor(); max caps the list (default 8), most serious first
 */
export function suggestRaid(plan, ctx = {}) {
  const c = { now: Date.now(), clashes: [], max: 8, ...ctx };
  const have = new Set([...objs(plan.raid).map((r) => r.source).filter(Boolean), ...(Array.isArray(plan.raidDismissed) ? plan.raidDismissed : [])]);
  const out = [];
  for (const s of SOURCES) {
    let list = [];
    try { list = s.build(plan, c); } catch { list = []; }
    for (const x of list) if (x.source && !have.has(x.source)) { have.add(x.source); out.push(x); }
  }
  return out.sort((a, b) => RANK[a.rating] - RANK[b.rating]).slice(0, c.max);
}

/** Turn a suggestion into a real item, ready to push onto plan.raid. */
export function acceptSuggestion(s, now = Date.now()) {
  return { ...emptyRaid(s.type, now), title: s.title, owner: s.owner || "", due: s.due || "", rating: asOf(RAID_RATINGS, s.rating, "Medium"), response: s.response || "", source: s.source };
}

/** Check AI-written suggestions before they reach the screen. Anything that does not fit the lists is dropped. */
export function validateRaidSuggestions(raw, plan, max = 8) {
  const have = new Set([...objs(plan.raid).map((r) => r.source).filter(Boolean), ...(Array.isArray(plan.raidDismissed) ? plan.raidDismissed : [])]);
  const out = [];
  for (const x of Array.isArray(raw) ? raw : []) {
    if (!x || !RAID_TYPES.includes(x.type)) continue;
    const title = clip(x.title, 200);
    if (!title) continue;
    const source = `ai|${x.type}|${title.toLowerCase().slice(0, 60)}`;
    if (have.has(source)) continue;
    have.add(source);
    out.push(sug(x.type, title, source, asOf(RAID_RATINGS, x.rating, "Medium"), x.response));
    if (out.length >= max) break;
  }
  return out;
}

/* ---------- across releases ---------- */

/**
 * Every item from every release, for the RAID page.
 *  plans    release plans with an `id`
 *  options  { now, includeClosed, closedReleases }  closed releases are left out unless includeClosed
 * Items sorted: overdue first, then by rating, then by due date.
 */
export function buildRaidView(plans, { now = Date.now(), includeClosed = false } = {}) {
  const rows = [];
  for (const p of (plans || []).filter(Boolean)) {
    const releaseClosed = Boolean(p.outcome?.status);
    for (const r of cleanRaid(p.raid)) {
      if (!includeClosed && (isClosedRaid(r) || releaseClosed)) continue;
      rows.push({ ...r, releaseId: String(p.id ?? ""), releaseName: clip(p.release?.name, 80) || "Untitled release", overdue: isOverdue(r, now), dueMs: parseLocal(r.due) });
    }
  }
  rows.sort((a, b) => Number(b.overdue) - Number(a.overdue) || RANK[a.rating] - RANK[b.rating] || (a.dueMs ?? Infinity) - (b.dueMs ?? Infinity));
  const owners = [...new Set(rows.map((r) => r.owner).filter(Boolean))].sort();
  return { rows, owners, summary: summarizeRaid(rows, now) };
}

/** Narrow the rows of buildRaidView(). Any filter left out (or "") lets everything through. */
export function filterRaid(rows, { type = "", owner = "", releaseId = "", rating = "" } = {}) {
  return rows.filter((r) => (!type || r.type === type) && (!owner || (owner === "(none)" ? !r.owner : r.owner === owner)) && (!releaseId || r.releaseId === releaseId) && (!rating || r.rating === rating));
}
