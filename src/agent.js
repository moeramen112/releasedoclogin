// The agent: compares a release with the last time it was checked, then prepares drafts for a person to approve.
// It never sends anything and never changes the plan. It only writes drafts into the Inbox.
//
// Pure functions where possible, so tests can run without a server or a clock.

import { evaluate } from "./engine.js";
import { computeRisk } from "./risk.js";
import { analyzeDependencies } from "./deps.js";
import { planToSnapshot, planConfig, planState, STATUSES } from "./plan.js";

const up = (s) => String(s ?? "").trim().toUpperCase();
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const MAX_TICKETS = 300;
const day = (s) => { const t = Date.parse(s); return Number.isNaN(t) ? "" : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" }); };
const handoffKey = (h) => `${clip(h.what, 80)}|${h.from}|${h.to}`;

/* ---------- what we remember about a release ---------- */

export function snapshotOf(plan, now = Date.now()) {
  const result = evaluate(planToSnapshot(plan, now), planConfig(plan), planState(plan));
  const risk = computeRisk(plan, now);
  const holding = {};
  for (const c of result.criteria) if (result.verdict.holding.includes(c.id)) holding[c.id] = { name: c.name, status: c.effective };
  const tickets = {};
  for (const t of (plan.tickets || []).slice(0, MAX_TICKETS)) {
    if (!up(t.key)) continue;
    tickets[up(t.key)] = { key: t.key, status: t.status, priority: t.priority, type: t.type, summary: clip(t.summary, 80), blockedBy: t.blockedBy || "" };
  }
  const handoffs = {};
  for (const h of plan.handoffs || []) {
    if (!String(h.what || "").trim()) continue;
    const due = Date.parse(h.due);
    handoffs[handoffKey(h)] = { what: clip(h.what, 80), from: h.from, to: h.to, owner: clip(h.owner, 60), status: h.status || "Not started", due: h.due || "", overdue: h.status !== "Done" && !Number.isNaN(due) && due < now };
  }
  return {
    at: now, call: result.verdict.call, reason: result.verdict.reason, risk: risk.score, riskLevel: risk.level,
    pctDone: risk.points.pctDone, holding, tickets, handoffs,
    dates: { freeze: plan.when?.freezeAt || "", meeting: plan.when?.meetingAt || "", deploy: plan.when?.deployAt || "" },
  };
}

/* ---------- what changed ---------- */

const ORDER = (s) => STATUSES.indexOf(s);

export function diffSnapshots(prev, cur) {
  const out = [];
  const add = (kind, text, importance = "low", extra = {}) => out.push({ kind, text, importance, ...extra });
  if (!prev) return out;

  if (prev.call !== cur.call) add("call", `The call changed from ${prev.call} to ${cur.call}.`, "high");
  const dr = cur.risk - prev.risk;
  if (Math.abs(dr) >= 5) add("risk", `Risk ${dr > 0 ? "rose" : "fell"} from ${prev.risk} to ${cur.risk} out of 100.`, Math.abs(dr) >= 10 && dr > 0 ? "high" : "medium");

  for (const k of Object.keys(cur.holding)) if (!prev.holding[k]) add("criterion", `Now holding the release: ${cur.holding[k].name}.`, "medium");
  for (const k of Object.keys(prev.holding)) if (!cur.holding[k]) add("criterion", `No longer holding the release: ${prev.holding[k].name}.`, "low");

  for (const [k, t] of Object.entries(cur.tickets)) {
    const p = prev.tickets[k];
    if (!p) { add("ticket-new", `New ticket ${t.key}${t.priority ? ` (${t.priority})` : ""}: ${t.summary}`, t.priority === "P0" && t.status !== "Done" ? "high" : "low"); continue; }
    if (p.status !== t.status) {
      const back = ORDER(t.status) >= 0 && ORDER(p.status) >= 0 && ORDER(t.status) < ORDER(p.status);
      add("ticket-move", `${t.key} moved from ${p.status} to ${t.status}: ${t.summary}`, back ? "high" : t.priority === "P0" || t.priority === "P1" ? "medium" : "low");
    } else if (p.priority !== t.priority && (t.priority === "P0" || t.priority === "P1")) {
      add("ticket-priority", `${t.key} is now ${t.priority} (was ${p.priority}): ${t.summary}`, t.priority === "P0" ? "high" : "medium");
    }
  }
  for (const [k, p] of Object.entries(prev.tickets)) if (!cur.tickets[k]) add("ticket-gone", `${p.key} is no longer in the release.`, "low");

  for (const [k, h] of Object.entries(cur.handoffs)) {
    const p = prev.handoffs[k];
    if (h.overdue && !(p && p.overdue)) add("handoff-overdue", `Handoff "${h.what}" (${h.from} to ${h.to}) is overdue${h.due ? `, due ${day(h.due)}` : ""}.`, "high", { handoff: h });
    else if (h.status === "Blocked" && (!p || p.status !== "Blocked")) add("handoff-blocked", `Handoff "${h.what}" (${h.from} to ${h.to}) is blocked.`, "high", { handoff: h });
    else if (h.status === "Done" && p && p.status !== "Done") add("handoff-done", `Handoff "${h.what}" (${h.from} to ${h.to}) is done.`, "low");
  }
  for (const [d, label] of [["freeze", "Code freeze"], ["deploy", "Deploy"], ["meeting", "Go/no-go meeting"]]) {
    if (prev.dates?.[d] && cur.dates[d] && prev.dates[d] !== cur.dates[d]) add("date", `${label} moved from ${day(prev.dates[d])} to ${day(cur.dates[d])}.`, d === "deploy" || d === "freeze" ? "high" : "medium");
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.importance] - rank[b.importance]);
}

/* ---------- drafts ---------- */

const demoUpdate = (name, cur, changes, first) => {
  const top = changes.slice(0, 6).map((c) => `- ${c.text}`);
  const holding = Object.values(cur.holding).slice(0, 4).map((h) => h.name);
  return [
    `${name}: ${cur.call}. Risk ${cur.risk}/100 (${cur.riskLevel}), ${cur.pctDone}% of points done.`,
    first ? "" : top.length ? `Since the last check:\n${top.join("\n")}` : "",
    holding.length ? `Holding the release: ${holding.join("; ")}.` : "Nothing is holding the release.",
    "(Rules-based draft, not AI.)",
  ].filter(Boolean).join("\n\n");
};

const chaseText = (h, name, deploy) => {
  const who = h.owner || "there";
  const when = h.due ? ` It was due ${day(h.due)}.` : "";
  const tail = deploy ? ` The release deploys ${day(deploy)}.` : "";
  return h.status === "Blocked"
    ? `Hi ${who}, the handoff "${h.what}" (${h.from} to ${h.to}) for ${name} is marked blocked.${tail} What is blocking it, and who can help?`
    : `Hi ${who}, the handoff "${h.what}" (${h.from} to ${h.to}) for ${name} is overdue.${when}${tail} Can you update the status or give us the new date?`;
};

const sugId = (s) => `${s.kind}|${up(s.key)}|${typeof s.value === "object" ? JSON.stringify(s.value) : up(s.value)}`;

/**
 * Check one release. Returns the new snapshot, what changed, and drafts for the Inbox.
 *  prev      the snapshot from the last check, or null the first time
 *  existing  Inbox items already made for this release (open or decided), so nothing is made twice
 */
export async function checkRelease({ plan, ai, prev, existing = [], now = Date.now() }) {
  const cur = snapshotOf(plan, now);
  const name = clip(plan.release?.name, 80) || "Untitled release";
  const first = !prev;
  const changes = diffSnapshots(prev, cur);
  const drafts = [];
  const seen = new Set(existing.filter((i) => i.status !== "expired").map((i) => i.dedupe)); // an expired suggestion may come back
  const push = (d) => { if (!seen.has(d.dedupe)) { seen.add(d.dedupe); drafts.push(d); } };

  // 1. A Slack-ready update, when something important changed (or the first time).
  const important = changes.filter((c) => c.importance === "high");
  if (first || important.length) {
    const text = ai.live ? await ai.update(plan, changes, now, first).then((r) => r.text).catch(() => demoUpdate(name, cur, changes, first)) : demoUpdate(name, cur, changes, first);
    // A new update replaces an older one that nobody has handled yet.
    push({ kind: "slack", title: first ? `First update for ${name}` : `Update for ${name}: ${important.length ? important[0].text : "baseline"}`.slice(0, 140), text, why: first ? "First check of this release." : `${important.length} important change${important.length === 1 ? "" : "s"} since the last check.`, importance: "high", dedupe: `slack|${cur.at}` });
  }

  // 2. A chase note for each handoff that just became overdue or blocked (or already is, on the first check).
  const pool = first ? Object.values(cur.handoffs).filter((h) => h.overdue || h.status === "Blocked").map((h) => ({ handoff: h })) : changes.filter((c) => c.handoff);
  for (const c of pool) {
    const h = c.handoff;
    push({ kind: "chase", title: `Chase: ${h.what}`, text: chaseText(h, name, plan.when?.deployAt), why: h.status === "Blocked" ? "Handoff is blocked." : "Handoff is overdue.", importance: "high", dedupe: `chase|${handoffKey(h)}|${h.status}|${h.due}` });
  }

  // 3. Suggestions from the risk spotter and dependency finder that nobody has seen yet.
  const risks = (await ai.risks(plan)).suggestions, deps = (await ai.dependencies(plan)).suggestions;
  const current = [...risks, ...deps].filter((s) => s.confidence !== "low" || s.kind !== "team");
  const currentIds = new Set(current.map(sugId));
  const expire = existing.filter((i) => i.kind === "suggestion" && i.status === "open" && !currentIds.has(i.dedupe)).map((i) => i.id);
  for (const s of current.slice(0, 12)) {
    const id = sugId(s);
    if (seen.has(id)) continue;
    push({ kind: "suggestion", title: suggestionTitle(s), suggestion: s, why: s.why, importance: s.confidence === "high" ? "high" : "medium", dedupe: id });
  }

  const quiet = !drafts.length && !changes.length;
  return { snapshot: cur, changes, drafts, expire, first, quiet };
}

export function suggestionTitle(s) {
  return ({
    tag: `${s.key}: mark as a migration`,
    area: `${s.key}: change area to ${s.value}`,
    team: `${s.key}: set team to ${s.value}`,
    blockedBy: `${s.key} waits on ${s.value}`,
    handoff: `New handoff: ${s.value?.from} to ${s.value?.to}${s.value?.blocks ? ` (blocks ${s.value.blocks})` : ""}`,
  }[s.kind]) || "Suggestion";
}

/* ---------- the Inbox list ---------- */

const MAX_ITEMS = 300;
const KINDS = ["slack", "chase", "suggestion"];

export const newItem = (releaseId, releaseName, d, source, now) => ({
  id: Math.random().toString(36).slice(2, 10) + now.toString(36),
  releaseId, releaseName: clip(releaseName, 80) || "Untitled release",
  kind: KINDS.includes(d.kind) ? d.kind : "chase",
  title: clip(d.title, 160), text: d.text ? String(d.text).slice(0, 3000) : "", suggestion: d.suggestion || null,
  why: clip(d.why, 240), importance: d.importance || "medium", dedupe: d.dedupe,
  source, status: "open", createdAt: now, decidedAt: 0, decidedBy: "", outcome: "",
});

/** Keep the list bounded: drop the oldest decided items first. */
export function trimInbox(items) {
  if (items.length <= MAX_ITEMS) return items;
  const decided = items.filter((i) => i.status !== "open").sort((a, b) => a.decidedAt - b.decidedAt);
  const drop = new Set(decided.slice(0, items.length - MAX_ITEMS).map((i) => i.id));
  return items.filter((i) => !drop.has(i.id));
}
