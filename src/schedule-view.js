// HTML for the release calendar. Pure: give it a schedule from schedule.js, get a string back.
// The calendar page and the planner's clash banner both use it, and it can be tested without a browser.
//
// Styling lives in public/styles.css under the "release calendar" heading. Class names used here:
// .cal .cal-head .cal-day .cal-row .cal-name .cal-lane .cal-freeze .cal-meet .cal-deploy .cal-now .clash
// .clash-card .sev-high .sev-medium .sev-low

import { esc } from "./html.js";
import { whenText, otherSide } from "./schedule.js";

const DAY = 86_400_000;
const startOfDay = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const SEV = { high: "s-fail", medium: "s-warn", low: "s-pending" };
const SEV_TEXT = { high: "Clash", medium: "Close", low: "Heads up" };

/** The time span the calendar shows: from `daysBack` days before today for `days` days, aligned to midnight. */
export function viewRange(now, { days = 28, daysBack = 2 } = {}) {
  const from = startOfDay(now) - daysBack * DAY;
  return { from, to: from + days * DAY };
}

const pct = (t, from, to) => ((t - from) / (to - from)) * 100;
const clampBar = (a, b, from, to) => { const l = Math.max(0, pct(a, from, to)), r = Math.min(100, pct(b, from, to)); return r > l ? { left: l, width: r - l } : null; };

/**
 * The timeline: one row per release, a column per day.
 *  schedule  from buildSchedule()
 *  options   { from, to, extras }  extras is { [releaseId]: { call, risk } } for the chips next to the names
 */
export function renderTimeline(schedule, { from, to, extras = {}, href = (id) => `/plan.html?release=${encodeURIComponent(id)}` } = {}) {
  const inClash = new Set(schedule.conflicts.flatMap((c) => c.releases.map((r) => r.id)));
  const rows = schedule.rows.filter((r) => [r.freeze, r.meeting, r.start, r.end].some((t) => t !== null && t >= from && t <= to) || (r.start <= to && r.end >= from));
  const hidden = schedule.rows.length - rows.length;
  if (!rows.length) return `<div class="msg">No releases are scheduled in this range.${hidden ? ` ${hidden} more ${hidden === 1 ? "is" : "are"} outside it.` : ""}</div>`;

  const days = Math.round((to - from) / DAY);
  const head = Array.from({ length: days }, (_, i) => {
    const f = new Date(from), d = new Date(f.getFullYear(), f.getMonth(), f.getDate() + i), dow = d.getDay(); // calendar days, so a 25-hour day does not repeat a label
    const month = d.getDate() === 1 || i === 0 ? `<small>${esc(d.toLocaleDateString("en-US", { month: "short" }))}</small>` : "";
    return `<span class="cal-day${dow === 0 || dow === 6 ? " weekend" : ""}" title="${esc(d.toDateString())}">${month}${d.getDate()}</span>`;
  }).join("");
  const now = schedule.now >= from && schedule.now <= to ? `<i class="cal-now" style="left:${pct(schedule.now, from, to).toFixed(3)}%" title="Now"></i>` : "";

  const body = rows.map((r) => {
    const x = extras[r.id] || {};
    const bars = [];
    const frozen = r.freeze !== null ? clampBar(r.freeze, r.start, from, to) : null;
    if (frozen) bars.push(`<i class="cal-freeze" style="left:${frozen.left.toFixed(3)}%;width:${frozen.width.toFixed(3)}%" title="${esc(`Frozen ${whenText(r.freeze)} until deploy`)}"></i>`);
    if (r.meeting !== null && r.meeting >= from && r.meeting <= to) bars.push(`<i class="cal-meet" style="left:${pct(r.meeting, from, to).toFixed(3)}%" title="${esc(`Go/no-go ${whenText(r.meeting)}`)}"></i>`);
    const dep = clampBar(r.start, r.end, from, to);
    if (dep) bars.push(`<i class="cal-deploy${inClash.has(r.id) ? " clash" : ""}" style="left:${dep.left.toFixed(3)}%;width:${Math.max(dep.width, 0.6).toFixed(3)}%" title="${esc(`Deploy ${whenText(r.start)} to ${whenText(r.end)}`)}"></i>`);
    const call = x.call ? ` <span class="chip s-${{ GO: "pass", HOLD: "warn", "NO-GO": "fail" }[x.call] || "pending"}"><i></i>${esc(x.call)}</span>` : "";
    return `<div class="cal-row"><div class="cal-name"><a href="${esc(href(r.id))}">${esc(r.name)}</a>${r.version ? ` <span class="mono">${esc(r.version)}</span>` : ""}${call}${x.risk === undefined ? "" : `<span class="msg"> risk ${esc(x.risk)}</span>`}</div><div class="cal-lane">${bars.join("")}${now}</div></div>`;
  }).join("");

  return `<div class="cal" role="group" aria-label="Release timeline"><div class="cal-row cal-head"><div class="cal-name"></div><div class="cal-lane cal-days" style="--days:${days}">${head}</div></div>${body}</div>${hidden ? `<div class="msg">${hidden} more ${hidden === 1 ? "release is" : "releases are"} outside this range.</div>` : ""}<div class="legend cal-legend"><span><i class="cal-key freeze"></i>Frozen until deploy</span><span><i class="cal-key meet"></i>Go/no-go meeting</span><span><i class="cal-key deploy"></i>Deploy window</span><span><i class="cal-key deploy clash"></i>Deploy window in a clash</span></div>`;
}

/**
 * One card per clash, with the releases it involves and, if given, free slots for moving one of them.
 *  slotsFor(releaseId) -> [{ at, text }]  optional
 */
export function renderConflicts(schedule, { href = (id) => `/plan.html?release=${encodeURIComponent(id)}`, slotsFor } = {}) {
  if (!schedule.conflicts.length) return `<p class="msg ok">No clashes between the releases on the calendar.</p>`;
  return schedule.conflicts.map((c) => {
    const links = c.releases.map((r) => `<a class="btn small" href="${esc(href(r.id))}">Open ${esc(r.name)}</a>`).join("");
    const slots = slotsFor ? c.releases.map((r) => ({ r, s: slotsFor(r.id) })).filter((x) => x.s.length).map(({ r, s }) => `<div class="msg">Free slots for ${esc(r.name)}: ${s.map((x) => esc(x.text)).join("; ")}</div>`).join("") : "";
    return `<div class="clash-card sev-${c.severity}"><span class="chip ${SEV[c.severity]}">${SEV_TEXT[c.severity]}</span><div><div>${esc(c.text)}</div>${slots}<div class="row-actions">${links}</div></div></div>`;
  }).join("");
}

/** The note shown in the planner when the open release clashes with another one. Empty string when it does not. */
export function renderClashBanner(conflicts, releaseId, { calendarHref = "" } = {}) {
  if (!conflicts.length) return "";
  const top = conflicts[0], other = otherSide(top, releaseId);
  const more = conflicts.length > 1 ? ` and ${conflicts.length - 1} more` : "";
  const cls = conflicts.some((c) => c.severity === "high") ? "bad" : "";
  return `<div class="banner ${cls}" role="status"><strong>Schedule: ${esc(top.severity === "high" ? "clash with" : "close to")} ${esc(other.name)}${more}.</strong><span>${esc(top.text)}${calendarHref ? ` <a href="${esc(calendarHref)}">See the calendar</a>` : ""}</span></div>`;
}
