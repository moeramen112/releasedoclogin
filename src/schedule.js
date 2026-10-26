// Release schedule: where releases sit on the calendar, and where they get in each other's way.
//
// Pure functions. No clock, no network, no disk: pass in the plans and `now`. The same file runs on the
// server (AI schedule check, agent drafts) and in the browser (calendar page, planner banner).
//
// How to change the rules
//  - Numbers (how close is too close, which roles count as the same person on call) live in DEFAULT_RULES.
//    Pass `rules` to any function to override a few of them; the rest keep their defaults.
//  - Each kind of clash is one entry in CHECKS: { id, severity, test(a, b, rules) }. Add one to teach the
//    calendar a new kind of clash. Nothing else needs to change; the page, banner and AI read the result.

import { parseLocal } from "./risk.js";
import { fmtLocal, isClosed } from "./plan.js";

export const HOUR = 3_600_000;
export const DAY = 86_400_000;
const MAX_WINDOW_HOURS = 168; // a deploy window longer than a week is a typo; use the 2-hour default instead of clashing with everything

export const DEFAULT_RULES = {
  bufferHours: 12,          // two deploys closer than this are "too close"
  peopleBufferHours: 24,    // the same person on two deploys closer than this is double-booked
  meetingOverlapMinutes: 60, // go/no-go meetings closer than this clash when they share a release manager
  peopleRoles: ["releaseManager", "sre", "qaLead"], // roles checked for double-booking
  avoidWeekends: true,      // suggested slots skip Saturday and Sunday
  suggestDaysAhead: 21,     // how far ahead suggested slots may look
  enabled: { overlap: true, tooClose: true, sharedPeople: true, freezeClash: true, meetingClash: true },
};

const rulesOf = (r) => ({ ...DEFAULT_RULES, ...(r || {}), enabled: { ...DEFAULT_RULES.enabled, ...(r?.enabled || {}) } });

const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const norm = (s) => String(s ?? "").trim().toLowerCase();

/** "Tue, Oct 27, 2:00 AM". Local time, like every other date in the planner. */
export const whenText = (ms) => new Date(ms).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** One release, reduced to the things the calendar cares about. Times are milliseconds, or null when unset. */
export function toItem(plan, id = plan?.id) {
  const when = plan?.when || {};
  const start = parseLocal(when.deployAt);
  const hours = Number(when.windowHours);
  const end = start === null ? null : start + (Number.isFinite(hours) && hours > 0 && hours <= MAX_WINDOW_HOURS ? hours : 2) * HOUR;
  return {
    id: String(id ?? ""),
    name: clip(plan?.release?.name, 80) || "Untitled release",
    version: clip(plan?.release?.version, 30),
    freeze: parseLocal(when.freezeAt), meeting: parseLocal(when.meetingAt), start, end,
    repo: norm(plan?.where?.repo),
    people: Object.fromEntries(Object.entries(plan?.people || {}).map(([k, v]) => [k, clip(v, 60)])),
    closed: isClosed(plan),
  };
}

/* ---------- the clash checks ---------- */

const overlaps = (a, b) => a.start !== null && b.start !== null && a.start < b.end && b.start < a.end;
const gapHours = (a, b) => (a.start === null || b.start === null ? Infinity : Math.max(a.start - b.end, b.start - a.end) / HOUR);
const pair = (a, b) => `${a.name} and ${b.name}`;

/** Each check looks at two releases and returns null (no clash) or { at, text }. */
export const CHECKS = [
  { id: "overlap", severity: "high", test: (a, b) => (overlaps(a, b)
    ? { at: Math.max(a.start, b.start), text: `${pair(a, b)} are both deploying around ${whenText(Math.max(a.start, b.start))}. The deploy windows overlap.` } : null) },

  { id: "tooClose", severity: "medium", test: (a, b, r) => {
    if (overlaps(a, b)) return null; // already reported as an overlap
    const g = gapHours(a, b);
    return g < r.bufferHours ? { at: Math.max(a.start, b.start), text: `${pair(a, b)} deploy only ${Math.max(1, Math.round(g))} hour${Math.round(g) === 1 ? "" : "s"} apart (${whenText(Math.min(a.start, b.start))} and ${whenText(Math.max(a.start, b.start))}). Keep at least ${r.bufferHours}.` } : null;
  } },

  { id: "sharedPeople", severity: "medium", test: (a, b, r) => {
    if (a.start === null || b.start === null || gapHours(a, b) >= r.peopleBufferHours) return null;
    const names = new Set();
    for (const role of r.peopleRoles) {
      const x = norm(a.people[role]), y = norm(b.people[role]);
      if (x && x === y) names.add(a.people[role]);
    }
    // The same person in different roles counts too: the SRE of one release is the release manager of the other.
    for (const ra of r.peopleRoles) for (const rb of r.peopleRoles) {
      const x = norm(a.people[ra]), y = norm(b.people[rb]);
      if (x && x === y) names.add(a.people[ra]);
    }
    return names.size ? { at: Math.max(a.start, b.start), text: `${[...names].join(" and ")} ${names.size === 1 ? "is" : "are"} on both ${pair(a, b)}, with deploys less than ${r.peopleBufferHours} hours apart.` } : null;
  } },

  // A deploy that lands inside another release's freeze, on the same repository, can change what that release tested.
  { id: "freezeClash", severity: "medium", test: (a, b) => {
    if (!a.repo || a.repo !== b.repo) return null;
    for (const [x, y] of [[a, b], [b, a]]) {
      if (x.start !== null && y.freeze !== null && y.start !== null && x.start > y.freeze && x.start < y.start) {
        return { at: x.start, text: `${x.name} deploys (${whenText(x.start)}) while ${y.name} is frozen on the same repository (frozen ${whenText(y.freeze)}, deploys ${whenText(y.start)}).` };
      }
    }
    return null;
  } },

  { id: "meetingClash", severity: "low", test: (a, b, r) => {
    if (a.meeting === null || b.meeting === null) return null;
    const same = norm(a.people.releaseManager) && norm(a.people.releaseManager) === norm(b.people.releaseManager);
    if (!same || Math.abs(a.meeting - b.meeting) >= r.meetingOverlapMinutes * 60_000) return null;
    return { at: Math.min(a.meeting, b.meeting), text: `The go/no-go meetings for ${pair(a, b)} are close together (${whenText(a.meeting)} and ${whenText(b.meeting)}) and share a release manager, ${a.people.releaseManager}.` };
  } },
];

/** All clashes between two items, strongest first. */
export function clashesBetween(a, b, rules) {
  const r = rulesOf(rules);
  const out = [];
  for (const c of CHECKS) {
    if (r.enabled[c.id] === false) continue;
    const hit = c.test(a, b, r);
    if (hit) out.push({ id: `${c.id}|${[a.id, b.id].sort().join("|")}`, kind: c.id, severity: c.severity, releases: [{ id: a.id, name: a.name }, { id: b.id, name: b.name }], at: hit.at, text: hit.text });
  }
  return out;
}

const RANK = { high: 0, medium: 1, low: 2 };

/**
 * The schedule for a set of releases.
 *  plans   release plans, each with an `id`
 *  options { now, rules, includeClosed }
 * Returns { rows, unscheduled, conflicts, range }:
 *  rows         releases with a deploy date, earliest first (closed ones only if includeClosed)
 *  unscheduled  open releases with no valid deploy date
 *  conflicts    clashes between open releases, most serious first
 *  range        { from, to } in ms, covering every date shown (null when there is nothing to show)
 */
export function buildSchedule(plans, { now = Date.now(), rules, includeClosed = false } = {}) {
  const all = (plans || []).filter(Boolean).map((p) => toItem(p));
  const open = all.filter((i) => !i.closed);
  const rows = (includeClosed ? all : open).filter((i) => i.start !== null).sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
  const unscheduled = open.filter((i) => i.start === null);

  const conflicts = [];
  const live = open.filter((i) => i.start !== null);
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) conflicts.push(...clashesBetween(live[i], live[j], rules));
  conflicts.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.at - b.at);

  const marks = rows.flatMap((r) => [r.freeze, r.meeting, r.start, r.end]).filter((t) => t !== null);
  const range = marks.length ? { from: Math.min(...marks), to: Math.max(...marks) } : null;
  return { rows, unscheduled, conflicts, range, now };
}

/** The clashes that involve one release. */
export const conflictsFor = (schedule, releaseId) => schedule.conflicts.filter((c) => c.releases.some((r) => r.id === String(releaseId)));

/** The release on the other side of a clash. */
export const otherSide = (conflict, releaseId) => conflict.releases.find((r) => r.id !== String(releaseId)) || conflict.releases[0];

/**
 * Free slots for moving one release: the same time of day as its current deploy, on later days, that
 * clash with no other open release. Plain rules, no AI. Returns up to `count` slots as { at, local }.
 */
export function suggestSlots(plans, releaseId, { now = Date.now(), rules, count = 3 } = {}) {
  const r = rulesOf(rules);
  const items = (plans || []).filter(Boolean).map((p) => toItem(p));
  const mine = items.find((i) => i.id === String(releaseId));
  if (!mine || mine.start === null) return [];
  const others = items.filter((i) => !i.closed && i.id !== mine.id && i.start !== null);
  const length = mine.end - mine.start;
  const gapToMeeting = mine.meeting === null ? null : mine.start - mine.meeting;
  const gapToFreeze = mine.freeze === null ? null : mine.start - mine.freeze;
  const out = [];
  const first = new Date(Math.max(now, mine.start));
  for (let d = 1; d <= r.suggestDaysAhead && out.length < count; d++) {
    const t = new Date(first.getFullYear(), first.getMonth(), first.getDate() + d, new Date(mine.start).getHours(), new Date(mine.start).getMinutes()).getTime();
    const dow = new Date(t).getDay();
    if (r.avoidWeekends && (dow === 0 || dow === 6)) continue;
    if (t <= now) continue;
    const moved = { ...mine, start: t, end: t + length, meeting: gapToMeeting === null ? null : t - gapToMeeting, freeze: gapToFreeze === null ? null : t - gapToFreeze };
    if (others.some((o) => clashesBetween(moved, o, r).length)) continue;
    out.push({ at: t, local: fmtLocal(t), text: whenText(t) });
  }
  return out;
}

