// Dependencies between pieces of work: "the frontend ticket cannot start until the backend one is merged",
// "QA waits for the merge", "tickets cannot be written until the design is handed over".
// Pure functions, no I/O. Runs in Node and in the browser.
//
// Two kinds of dependency are tracked:
//  - a ticket is blocked by other tickets in this release (ticket.blockedBy, a list of keys)
//  - a handoff between teams (design to frontend, devops to QA) that blocks named tickets

export const TEAMS = ["Design", "Product", "Backend", "Frontend", "Mobile", "QA", "Security", "DevOps", "Docs and support", "Other"];
export const HANDOFF_STATUS = ["Not started", "In progress", "Done", "Blocked"];

const DONE = "Done";
const STARTED = ["In progress", "In review", DONE];
const up = (s) => String(s ?? "").trim().toUpperCase();

/** "rel-1, REL-2; REL-3" becomes ["REL-1","REL-2","REL-3"]. */
export const parseKeys = (v) => [...new Set(String(v ?? "").toUpperCase().split(/[\s,;]+/).filter(Boolean))];

const parseTime = (s) => { const t = Date.parse(s); return Number.isNaN(t) ? null : t; };

/**
 * Work out what is waiting on what. Returns:
 *  any            true if any dependency was entered
 *  waiting        open tickets that cannot finish yet, with what they wait on
 *  startedEarly   tickets that are in progress, in review or done while something they depend on is not done
 *  ready          tickets that were waiting and can start now
 *  finishFirst    open tickets that hold up the most other tickets
 *  longestChain   the longest line of open tickets that must happen one after another
 *  cycles         tickets that depend on each other in a circle, so none can start
 *  outside        keys named as blockers that are not tickets in this release (counted as unresolved)
 *  handoffs       open, overdue, blocked, and due-after-freeze handoffs
 */
export function analyzeDependencies(tickets = [], handoffs = [], now = Date.now(), freezeMs = null) {
  const list = (tickets || []).filter((t) => t && up(t.key));
  const byKey = new Map(list.map((t) => [up(t.key), t]));
  const isOpen = (t) => t.status !== DONE;
  const hs = (handoffs || []).filter((h) => h && (String(h.what || "").trim() || parseKeys(h.blocks).length));

  // Edges: ticket key -> things it waits on.
  const blockersOf = new Map();
  const outside = new Set();
  for (const t of list) {
    const k = up(t.key);
    const on = [];
    for (const b of parseKeys(t.blockedBy)) {
      if (b === k) continue; // a ticket cannot block itself; ignore the typo
      const bt = byKey.get(b);
      if (bt) on.push({ kind: "ticket", key: bt.key, status: bt.status, team: bt.team || "", open: isOpen(bt) });
      else { outside.add(b); on.push({ kind: "outside", key: b, status: "Not in this release", team: "", open: true }); }
    }
    blockersOf.set(k, on);
  }
  for (const h of hs) {
    for (const k of parseKeys(h.blocks)) {
      if (!byKey.has(k)) { outside.add(k); continue; }
      blockersOf.get(k).push({ kind: "handoff", key: "", what: h.what || "Handoff", status: h.status || "Not started", team: h.from || "", open: h.status !== DONE });
    }
  }

  const waiting = [], startedEarly = [], ready = [];
  for (const t of list) {
    const k = up(t.key);
    const open = blockersOf.get(k).filter((x) => x.open);
    const all = blockersOf.get(k);
    if (isOpen(t) && open.length) waiting.push({ key: t.key, summary: t.summary, team: t.team || "", status: t.status, points: Number(t.points) || 0, on: open });
    if (STARTED.includes(t.status) && open.length) startedEarly.push({ key: t.key, summary: t.summary, team: t.team || "", status: t.status, on: open });
    if (isOpen(t) && t.status === "To do" && all.length && !open.length) ready.push({ key: t.key, summary: t.summary, team: t.team || "" });
  }

  // Circular dependencies: depth-first search over ticket-to-ticket edges.
  const cycles = [];
  const state = new Map(); // 1 = on the current path, 2 = finished
  const path = [];
  const visit = (k) => {
    state.set(k, 1); path.push(k);
    for (const b of blockersOf.get(k)) {
      if (b.kind !== "ticket") continue;
      const bk = up(b.key);
      if (state.get(bk) === 1) {
        const loop = path.slice(path.indexOf(bk));
        const at = loop.indexOf([...loop].sort()[0]); // start at the smallest key so the same loop is reported once
        const norm = [...loop.slice(at), ...loop.slice(0, at)];
        if (!cycles.some((c) => c.join() === norm.join())) cycles.push(norm);
      } else if (!state.has(bk)) visit(bk);
    }
    path.pop(); state.set(k, 2);
  };
  for (const k of byKey.keys()) if (!state.has(k)) visit(k);
  const inCycle = new Set(cycles.flat());

  // Longest chain of open tickets, one blocked by the next (loops are skipped).
  const memo = new Map();
  const depth = (k, seen = new Set()) => {
    if (memo.has(k)) return memo.get(k);
    if (seen.has(k) || inCycle.has(k)) return { len: 0, keys: [] };
    seen.add(k);
    let best = { len: 0, keys: [] };
    for (const b of blockersOf.get(k)) {
      if (b.kind !== "ticket" || !b.open) continue;
      const d = depth(up(b.key), seen);
      if (d.len > best.len) best = d;
    }
    seen.delete(k);
    const t = byKey.get(k);
    const res = isOpen(t) ? { len: best.len + 1, keys: [...best.keys, t.key] } : { len: 0, keys: [] };
    memo.set(k, res);
    return res;
  };
  let longest = { len: 0, keys: [] };
  for (const k of byKey.keys()) { const d = depth(k); if (d.len > longest.len) longest = d; }

  // Which open ticket unblocks the most others, directly or through a chain.
  const blocks = new Map(); // key -> keys that wait on it
  for (const [k, on] of blockersOf) for (const b of on) if (b.kind === "ticket") (blocks.get(up(b.key)) || blocks.set(up(b.key), []).get(up(b.key))).push(k);
  const downstream = (k) => {
    const seen = new Set(), stack = [...(blocks.get(k) || [])];
    while (stack.length) { const n = stack.pop(); if (seen.has(n) || n === k) continue; seen.add(n); stack.push(...(blocks.get(n) || [])); }
    return [...seen].filter((n) => isOpen(byKey.get(n)));
  };
  const finishFirst = [...byKey.entries()]
    .filter(([k, t]) => isOpen(t) && !inCycle.has(k))
    .map(([k, t]) => ({ key: t.key, summary: t.summary, team: t.team || "", status: t.status, unblocks: downstream(k).length }))
    .filter((x) => x.unblocks > 0)
    .sort((a, b) => b.unblocks - a.unblocks)
    .slice(0, 3);

  const open = hs.filter((h) => h.status !== DONE);
  const dueOf = (h) => parseTime(h.due);
  const handoffInfo = {
    total: hs.length,
    open: open.map((h) => ({ what: h.what || "Handoff", from: h.from, to: h.to, status: h.status || "Not started", due: h.due })),
    overdue: open.filter((h) => dueOf(h) !== null && dueOf(h) < now).map((h) => ({ what: h.what || "Handoff", from: h.from, to: h.to, due: h.due })),
    blocked: open.filter((h) => h.status === "Blocked").map((h) => ({ what: h.what || "Handoff", from: h.from, to: h.to })),
    afterFreeze: freezeMs === null ? [] : open.filter((h) => dueOf(h) !== null && dueOf(h) > freezeMs).map((h) => ({ what: h.what || "Handoff", from: h.from, to: h.to, due: h.due })),
  };

  const any = hs.length > 0 || [...blockersOf.values()].some((on) => on.length > 0);
  return {
    any, waiting, startedEarly, ready, finishFirst, cycles,
    longestChain: { length: longest.len, keys: longest.keys },
    outside: [...outside],
    handoffs: handoffInfo,
  };
}
