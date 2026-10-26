// Runs the agent on stored releases and keeps the Inbox. The routes and the timer both call this one thing.
import { checkRelease, newItem, trimInbox } from "./agent.js";
import { buildSchedule, conflictsFor } from "./schedule.js";
import { sendSlack as realSendSlack } from "./notify.js";
import { isClosed } from "./plan.js";

const HOURS = [1, 4, 12, 24];
const strip = (run) => (run ? { at: run.at, by: run.by, source: run.source, first: run.first, quiet: run.quiet, changes: run.changes, created: run.items } : null);

export class AgentError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createAgentService({ relDb, agentDb, ai, env = process.env, deps = {}, log = () => {} }) {
  const sendSlack = deps.sendSlack || realSendSlack;
  const perDay = Math.max(1, Number(env.AGENT_PER_DAY) || 12);
  const running = new Set();

  async function run(id, source, by, now = Date.now()) {
    const rec = relDb.get().releases[id];
    if (!rec) throw new AgentError(404, "No such release.");
    if (running.has(id)) throw new AgentError(409, "A check is already running for this release.");
    running.add(id);
    try {
      const st = agentDb.get();
      const prev = st.runs[id]?.snapshot || null;
      const existing = st.inbox.filter((i) => i.releaseId === id);
      const plans = Object.values(relDb.get().releases).map((x) => ({ ...x.plan, id: x.id }));
      const clashes = conflictsFor(buildSchedule(plans, { now }), id);
      const r = await checkRelease({ plan: rec.plan, ai, prev, existing, clashes, now });
      await agentDb.mutate((s) => {
        s.runs[id] = { at: now, by, source, snapshot: r.snapshot, changes: r.changes.slice(0, 40), first: r.first, quiet: r.quiet, items: r.drafts.length };
        for (const i of s.inbox) if (r.expire.includes(i.id)) { i.status = "expired"; i.decidedAt = now; i.decidedBy = "agent"; i.outcome = "No longer applies"; }
        if (r.drafts.some((d) => d.kind === "slack")) { // a newer update replaces an older one nobody has sent
          for (const i of s.inbox) if (i.releaseId === id && i.kind === "slack" && i.status === "open") { i.status = "expired"; i.decidedAt = now; i.decidedBy = "agent"; i.outcome = "Replaced by a newer update"; }
        }
        for (const d of r.drafts) s.inbox.push(newItem(id, rec.plan.release?.name, d, source, now));
        s.inbox = trimInbox(s.inbox);
        if (source === "auto") { const day = new Date(now).toISOString().slice(0, 10); const c = s.auto[id] || (s.auto[id] = { on: true, hours: 4 }); c.count = c.day === day ? (c.count || 0) + 1 : 1; c.day = day; }
      });
      return view(id);
    } finally { running.delete(id); }
  }

  function view(id) {
    const s = agentDb.get();
    const mine = s.inbox.filter((i) => i.releaseId === id);
    const open = mine.filter((i) => i.status === "open").sort((a, b) => (a.importance === "high" ? 0 : 1) - (b.importance === "high" ? 0 : 1) || b.createdAt - a.createdAt);
    const recent = mine.filter((i) => i.status !== "open").sort((a, b) => b.decidedAt - a.decidedAt).slice(0, 5);
    const a = s.auto[id] || { on: false, hours: 4 };
    return { run: strip(s.runs[id]), auto: { on: Boolean(a.on), hours: a.hours || 4 }, items: [...open, ...recent], openCount: open.length, mode: ai.mode, slack: Boolean(env.SLACK_WEBHOOK_URL) };
  }

  function inbox() {
    const s = agentDb.get();
    const names = (id) => relDb.get().releases[id]?.plan.release?.name || null;
    const live = s.inbox.filter((i) => relDb.get().releases[i.releaseId]);
    const open = live.filter((i) => i.status === "open").sort((a, b) => (a.importance === "high" ? 0 : 1) - (b.importance === "high" ? 0 : 1) || b.createdAt - a.createdAt);
    const recent = live.filter((i) => i.status !== "open").sort((a, b) => b.decidedAt - a.decidedAt).slice(0, 40);
    const byRelease = {};
    for (const i of open) byRelease[i.releaseId] = (byRelease[i.releaseId] || 0) + 1;
    return { openCount: open.length, byRelease, items: [...open, ...recent].map((i) => ({ ...i, releaseName: names(i.releaseId) || i.releaseName })), slack: Boolean(env.SLACK_WEBHOOK_URL), mode: ai.mode };
  }

  /** One decision on one item: edit, send, done, dismiss or applied. */
  async function act(itemId, action, text, by, now = Date.now()) {
    const it = agentDb.get().inbox.find((i) => i.id === itemId);
    if (!it) throw new AgentError(404, "No such item.");
    if (it.status !== "open") throw new AgentError(409, "That item was already handled.");
    const writable = it.kind !== "suggestion";
    if (action === "edit") {
      if (!writable) throw new AgentError(400, "Suggestions cannot be edited.");
      const t = String(text ?? "").trim().slice(0, 3000);
      if (!t) throw new AgentError(400, "The message cannot be empty.");
      await agentDb.mutate(() => { it.text = t; });
      return it;
    }
    if (action === "send") {
      if (it.kind !== "slack") throw new AgentError(400, "Only Slack drafts can be posted from here.");
      if (!env.SLACK_WEBHOOK_URL) throw new AgentError(400, "Slack is not configured. Set SLACK_WEBHOOK_URL.");
      const body = String(text ?? it.text).trim().slice(0, 3000);
      if (!body) throw new AgentError(400, "The message cannot be empty.");
      try { await sendSlack(env.SLACK_WEBHOOK_URL, { text: body }); } catch (e) { throw new AgentError(502, e.message); }
      await agentDb.mutate(() => { Object.assign(it, { text: body, status: "sent", decidedAt: now, decidedBy: by, outcome: "Posted to Slack" }); });
      return it;
    }
    const outcomes = { done: "Marked done", dismiss: "Dismissed", applied: "Applied to the plan" };
    const status = { done: "done", dismiss: "dismissed", applied: "applied" }[action];
    if (!status) throw new AgentError(400, "Unknown action.");
    if (action === "applied" && it.kind !== "suggestion") throw new AgentError(400, "Only suggestions can be applied.");
    await agentDb.mutate(() => { Object.assign(it, { status, decidedAt: now, decidedBy: by, outcome: outcomes[action] }); });
    return it;
  }

  async function setAuto(id, on, hours) {
    if (!relDb.get().releases[id]) throw new AgentError(404, "No such release.");
    const h = HOURS.includes(Number(hours)) ? Number(hours) : 4;
    await agentDb.mutate((s) => { s.auto[id] = { ...(s.auto[id] || {}), on: Boolean(on), hours: h }; });
    return view(id);
  }

  /** Called every minute by the timer. Only releases with Auto switched on, and never more than AGENT_PER_DAY runs each. */
  async function autoTick(now = Date.now()) {
    const s = agentDb.get();
    for (const [id, a] of Object.entries(s.auto)) {
      if (!a.on) continue;
      if (!relDb.get().releases[id] || isClosed(relDb.get().releases[id].plan)) continue;
      const last = s.runs[id]?.at;
      if (last !== undefined && now - last < (a.hours || 4) * 3_600_000) continue;
      const day = new Date(now).toISOString().slice(0, 10);
      if (a.day === day && (a.count || 0) >= perDay) continue;
      try { await run(id, "auto", "Auto", now); } catch (e) { log(`Agent auto-check failed for ${id}: ${e.message}`); }
    }
  }

  return { run, view, inbox, act, setAuto, autoTick };
}
