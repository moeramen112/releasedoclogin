// Background work: pull fresh tickets from Jira and tell Slack when the go/no-go call changes.
// tick() is plain and takes the clock as an argument, so tests can run it without waiting.
import { evaluate } from "./engine.js";
import { planToSnapshot, planConfig, planState, mergeTickets } from "./plan.js";
import { buildChangeMessage, sendSlack as realSendSlack } from "./notify.js";
import { jiraConfigured, fetchJiraRelease as realFetchJira } from "./sources/jira.js";

export function createJobs({ relDb, jobsDb, config, env = process.env, deps = {}, log = () => {} }) {
  const syncMs = Math.max(1, Number(env.SYNC_MINUTES) || 5) * 60_000;
  const settleMs = Math.max(0, env.ALERT_SETTLE_MINUTES === undefined || env.ALERT_SETTLE_MINUTES === "" ? 2 : Number(env.ALERT_SETTLE_MINUTES)) * 60_000;
  const fetchJira = deps.fetchJiraRelease || realFetchJira;
  const sendSlack = deps.sendSlack || realSendSlack;
  const note = (id, patch) => jobsDb.mutate((s) => { s.releases[id] = { ...(s.releases[id] || {}), ...patch }; });
  const callOf = (plan, now) => evaluate(planToSnapshot(plan, now), planConfig(plan), planState(plan));

  async function syncOne(rec, now) {
    const id = rec.id, version = String(rec.plan.release.fixVersion || "").trim();
    try {
      const issues = await fetchJira({ version, config, env });
      const m = mergeTickets(rec.plan.tickets, issues);
      if (m.updated || m.added) {
        await relDb.mutate((s) => {
          const cur = s.releases[id];
          if (!cur) return;
          // Merge into the latest copy, so a save made while Jira was loading is not lost.
          const again = mergeTickets(cur.plan.tickets, issues);
          cur.plan = { ...cur.plan, tickets: again.tickets };
          cur.version += 1;
          cur.updatedAt = new Date(now).toISOString();
          cur.updatedBy = "Jira auto-refresh";
        });
      }
      await note(id, { lastSync: now, lastError: "", lastChange: m.updated || m.added ? { at: now, updated: m.updated, added: m.added } : undefined });
    } catch (e) {
      await note(id, { lastSync: now, lastError: String(e.message || e).slice(0, 200) });
      log(`Auto-refresh failed for ${id}: ${e.message}`);
    }
  }

  async function alertOne(rec, now) {
    const id = rec.id;
    const st = jobsDb.get().releases[id] || {};
    const call = callOf(rec.plan, now).verdict.call;
    if (!st.lastCall) { await note(id, { lastCall: call, pendingCall: "", pendingSince: 0 }); return; }
    if (call === st.lastCall) { if (st.pendingCall) await note(id, { pendingCall: "", pendingSince: 0 }); return; }
    if (st.pendingCall !== call) { await note(id, { pendingCall: call, pendingSince: now }); if (settleMs > 0) return; }
    else if (now - st.pendingSince < settleMs) return;
    if (!env.SLACK_WEBHOOK_URL) { await note(id, { lastCall: call, pendingCall: "", pendingSince: 0 }); return; }
    try {
      const result = callOf(rec.plan, now);
      await sendSlack(env.SLACK_WEBHOOK_URL, buildChangeMessage({ release: { ...rec.plan.release, name: rec.plan.release.name || "Untitled release" }, from: st.lastCall, result, dashboardUrl: env.PUBLIC_URL ? `${env.PUBLIC_URL.replace(/\/+$/, "")}/plan.html?release=${id}` : undefined }));
      await note(id, { lastCall: call, pendingCall: "", pendingSince: 0, lastAlert: { at: now, from: st.lastCall, to: call }, alertError: "" });
    } catch (e) {
      await note(id, { alertError: String(e.message || e).slice(0, 200) }); // lastCall is kept, so the next tick tries again
      log(`Slack alert failed for ${id}: ${e.message}`);
    }
  }

  let running = false;
  async function tick(now = Date.now()) {
    if (running) return;
    running = true;
    try {
      for (const rec of Object.values(relDb.get().releases)) {
        const r = rec.plan.release || {};
        if (r.autoSync && String(r.fixVersion || "").trim() && jiraConfigured(env)) {
          const last = jobsDb.get().releases[rec.id]?.lastSync;
          if (last === undefined || now - last >= syncMs) await syncOne(rec, now);
        }
      }
      for (const rec of Object.values(relDb.get().releases)) { // read again: sync may have changed tickets
        if (rec.plan.release?.slackAlerts !== false && env.SLACK_WEBHOOK_URL) await alertOne(rec, now);
      }
    } finally { running = false; }
  }

  return { tick, status: () => jobsDb.get().releases, start: (everyMs = 60_000) => { const h = setInterval(() => tick().catch((e) => log(e.message)), everyMs); h.unref?.(); return () => clearInterval(h); } };
}
