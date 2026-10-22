// AI helpers and the agent panel. They suggest and draft; a person approves everything.
// createAssist(c) gets what it needs from the planner page (c.P, c.lib, c.remote and c.integrations are read fresh each time).
import { parseKeys } from "/deps.js";
import { esc } from "/uikit.js";

export function createAssist(c) {
  const { readOnly, toLogin, saveLib, renderResults, renderTickets, renderHandoffs, changed, RH, READONLY } = c;

  function agentBarBtn() {
    if (!c.integrations.server || !c.integrations.ai || READONLY) return "";
    const n = AG.data?.openCount || 0;
    return `<button class="btn small primary" type="button" data-act="agent-check"${AG.busy || readOnly() ? " disabled" : ""} title="Compare with the last check and prepare drafts for your OK">${AG.busy ? "Checking…" : "Check this release"}</button>${n ? `<a class="chip s-warn" href="#agent-panel" title="Drafts waiting for your OK">${n} to review</a>` : ""}`;
  }

  /* ---------- AI helpers: they suggest, a person approves ---------- */

  const AI = { busy: "", audience: "leadership", briefing: null, kind: "", sugg: [], error: "", note: "" };

  const aiLabel = (s) => ({
    tag: `${s.key}: mark as a migration`,
    area: `${s.key}: change area to ${s.value}`,
    team: `${s.key}: set team to ${s.value}`,
    blockedBy: `${s.key} waits on ${s.value}`,
    handoff: `New handoff: ${s.value?.from} to ${s.value?.to}${s.value?.blocks ? ` (blocks ${s.value.blocks})` : ""}`,
  }[s.kind] || "Suggestion");

  function renderQuickHelpers() {
    const live = c.integrations.ai === "live";
    const off = readOnly() || AI.busy;
    const btn = (act, label, tip) => `<button class="btn small" type="button" data-act="${act}" title="${esc(tip)}"${off ? " disabled" : ""}>${label}</button>`;
    const chips = { high: "s-pass", medium: "s-warn", low: "s-pending" };
    const list = AI.sugg.length
      ? `<div class="ai-list">${AI.sugg.map((s) => `<div class="ai-item"><div><strong>${esc(aiLabel(s))}</strong> <span class="chip ${chips[s.confidence] || "s-pending"}">${esc(s.confidence)}</span><div class="note">${esc(s.why)}</div></div><div class="row-actions"><button class="btn small primary" type="button" data-act="ai-accept" data-id="${esc(s.id)}">Apply</button><button class="btn small" type="button" data-act="ai-dismiss" data-id="${esc(s.id)}">Dismiss</button></div></div>`).join("")}${AI.sugg.length > 1 ? `<div class="row-actions"><button class="btn small" type="button" data-act="ai-accept-all">Apply all</button><button class="btn small" type="button" data-act="ai-dismiss-all">Dismiss all</button></div>` : ""}</div>`
      : AI.kind ? `<p class="note">${AI.kind === "risks" ? "Nothing new spotted." : "Nothing new suggested."}</p>` : "";
    const brief = AI.briefing ? `<div class="ai-brief"><div class="panel-head"><h3>${AI.briefing.audience === "leadership" ? "Leadership update" : "Team update"} <span class="chip s-waived">${live ? "AI draft: check before sending" : "Rules-based draft"}</span></h3><button class="btn small" type="button" data-act="ai-copy">Copy</button></div><pre class="brief" id="ai-brief-text">${esc(AI.briefing.text)}</pre></div>` : "";
    return `<div class="ai-quick"><p class="note">Quick helpers give an answer on screen only. Nothing is saved to the Inbox.</p>
    <div class="row-actions"><select id="ai-audience" aria-label="Who is the update for"${off ? " disabled" : ""}><option value="leadership"${AI.audience === "leadership" ? " selected" : ""}>For leadership</option><option value="engineering"${AI.audience === "engineering" ? " selected" : ""}>For the team</option></select>
    ${btn("ai-briefing", "Write status update", "A short update in plain words")}${btn("ai-risks", "Spot risks", "Finds migrations and sensitive work that are not marked")}${btn("ai-deps", "Find dependencies", "Finds work that probably waits on other work")}<span class="msg ${AI.error ? "bad" : ""}" id="ai-msg">${esc(AI.busy ? "Working…" : AI.error || AI.note)}</span></div>
    ${brief}${list}</div>`;
  }

  /* ---------- the agent: Check this release, the Auto switch and the Inbox ---------- */

  const AG = { forId: "", data: null, busy: false, msg: "", bad: false, total: 0, quickOpen: false };
  // The page redraws often, so remember whether Quick helpers is open.
  document.addEventListener("toggle", (e) => { if (e.target.classList?.contains("quick")) AG.quickOpen = e.target.open; }, true);
  const agoText = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

  async function agentLoad() {
    if (!c.remote || !c.lib.current) return;
    const id = c.lib.current;
    AG.forId = id;
    try {
      const res = await fetch("/api/agent?releaseId=" + encodeURIComponent(id));
      if (res.status === 401) { toLogin(); return; }
      AG.data = res.ok ? await res.json() : null; // 404 until the release has been saved once
      const t = await fetch("/api/agent");
      if (t.ok) { AG.total = (await t.json()).openCount; document.querySelectorAll("[data-inbox]").forEach((a) => { a.textContent = AG.total ? `Inbox (${AG.total})` : "Inbox"; }); }
    } catch { /* shows the last known state */ }
    if (c.lib.current === id) renderResults();
  }

  async function agentPost(path, body) {
    const res = await fetch(path, { method: "POST", headers: RH, body: JSON.stringify(body) });
    if (res.status === 401) { toLogin(); throw new Error("Sign in required."); }
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `Request failed (${res.status}).`);
    return d;
  }

  async function agentCheck() {
    if (AG.busy || readOnly()) return;
    AG.busy = true; AG.msg = "Saving, then checking…"; AG.bad = false; renderResults();
    try {
      saveLib();
      await c.remote.chain; // the server checks the saved copy, so make sure your latest edits are saved first
      if (c.remote.conflict === c.lib.current) throw new Error("Resolve the save conflict first, then check again.");
      AG.data = await agentPost("/api/agent/check", { releaseId: c.lib.current });
      AG.forId = c.lib.current;
      const r = AG.data.run;
      AG.msg = r.first ? "Starting point saved." : r.quiet ? "Nothing new since the last check." : r.created ? `${r.created} new item${r.created === 1 ? "" : "s"} for your OK.` : "Checked. Nothing needs your OK.";
      agentLoad();
    } catch (e) { AG.msg = e.message; AG.bad = true; }
    AG.busy = false; renderResults();
  }

  async function agentItem(id, action) {
    const it = AG.data?.items.find((x) => x.id === id);
    if (!it) return;
    try {
      if (action === "applied") {
        if (!aiApply(it.suggestion)) { AG.msg = "That no longer applies, so nothing was changed."; AG.bad = true; }
        else { renderTickets(); renderHandoffs(); changed(); AG.msg = "Applied. Check the tickets and handoffs on the left."; AG.bad = false; }
      }
      if (action === "copy") { await navigator.clipboard.writeText(it.text); AG.msg = "Copied."; AG.bad = false; renderResults(); return; }
      await agentPost("/api/agent/item", { id, action: action === "copy" ? "done" : action });
      AG.msg = action === "send" ? "Posted to Slack." : AG.msg; if (action === "send") AG.bad = false;
    } catch (e) { AG.msg = e.message; AG.bad = true; }
    await agentLoad();
  }

  function renderAgent() {
    if (!c.integrations.server || !c.integrations.ai || READONLY) return "";
    const d = AG.data, ro = readOnly();
    const live = c.integrations.ai === "live";
    const off = ro || AG.busy ? " disabled" : "";
    const run = d?.run;
    const items = (d?.items || []).filter((i) => i.status === "open");
    const autoOn = Boolean(d?.auto.on), hours = d?.auto.hours || 4;
    const last = run ? `Last checked ${agoText(run.at)} (${run.source === "auto" ? "auto" : run.by})` : "Not checked yet";
    const changes = run?.changes?.length ? `<ul class="ag-changes">${run.changes.slice(0, 8).map((c) => `<li class="${c.importance === "high" ? "hi" : ""}">${esc(c.text)}</li>`).join("")}${run.changes.length > 8 ? `<li class="note">and ${run.changes.length - 8} more</li>` : ""}</ul>` : "";
    const state = !d ? `<p class="note">Save the release first (it saves on its own after a moment), then press Check this release.</p>`
      : !run ? `<p class="note">Press <strong>Check this release</strong> to save a starting point. After that, each check tells you what changed.</p>`
      : run.first ? `<p class="note">Starting point saved. The next check will show what changed.</p>`
      : run.changes.length ? `<h3 class="ag-h">What changed since the check before</h3>${changes}` : `<p class="note">Nothing changed since the check before.</p>`;
    const card = (i) => {
      const acts = i.kind === "suggestion"
        ? `<button class="btn small primary" type="button" data-act="agent-item" data-id="${esc(i.id)}" data-do="applied"${off}>Apply</button><button class="btn small" type="button" data-act="agent-item" data-id="${esc(i.id)}" data-do="dismiss"${off}>Dismiss</button>`
        : `${i.kind === "slack" && d.slack ? `<button class="btn small primary" type="button" data-act="agent-item" data-id="${esc(i.id)}" data-do="send"${off}>Post to Slack</button>` : ""}<button class="btn small" type="button" data-act="agent-item" data-id="${esc(i.id)}" data-do="copy"${off} title="Copies the text and marks it as handled">Copy and mark sent</button><button class="btn small" type="button" data-act="agent-item" data-id="${esc(i.id)}" data-do="dismiss"${off}>Dismiss</button><a class="btn small" href="/inbox.html" title="Edit the text in the Inbox">Edit in Inbox</a>`;
      const kind = { slack: "Slack draft", chase: "Chase note", suggestion: "Suggestion" }[i.kind];
      return `<div class="ai-item"><div><strong>${esc(i.title)}</strong> <span class="chip ${i.kind === "suggestion" ? "s-waived" : "s-warn"}">${kind}</span>${i.text ? `<div class="note ag-preview">${esc(i.text.slice(0, 220))}${i.text.length > 220 ? "…" : ""}</div>` : ""}<div class="note">${esc(i.why)}${i.source === "auto" ? " · found by Auto" : ""}</div></div><div class="row-actions">${acts}</div></div>`;
    };
    const list = items.length ? `<h3 class="ag-h">Needs your OK (${items.length})</h3><div class="ai-list">${items.map(card).join("")}</div>` : run && !run.first ? `<p class="note">Nothing needs your OK right now.</p>` : "";
    return `<section class="panel" id="agent-panel"><div class="panel-head"><h2>Agent</h2><span class="note">${live ? "Uses Claude to write drafts. You approve everything." : "Demo mode: simple rules, no AI key set. You approve everything."}</span></div>
    <div class="row-actions"><button class="btn small primary" type="button" data-act="agent-check"${off}>Check this release</button>
    <label class="ag-auto"><input type="checkbox" id="ag-auto-on"${autoOn ? " checked" : ""}${!d || ro ? " disabled" : ""}> Auto</label><select id="ag-auto-hours" aria-label="How often Auto checks"${!d || ro ? " disabled" : ""}>${[[1, "every hour"], [4, "every 4 hours"], [12, "every 12 hours"], [24, "every day"]].map(([h, l]) => `<option value="${h}"${hours === h ? " selected" : ""}>${l}</option>`).join("")}</select>
    <span class="msg ${AG.bad ? "bad" : ""}" id="ag-msg">${esc(AG.msg)}</span></div>
    <p class="note">${esc(last)}. Auto is ${autoOn ? `on, ${hours === 24 ? "daily" : `every ${hours === 1 ? "hour" : hours + " hours"}`}. It only runs while the server is running and only prepares drafts` : "off"}.</p>
    ${state}${list}
    <details class="quick"${AG.quickOpen ? " open" : ""}><summary>Quick helpers</summary>${renderQuickHelpers()}</details></section>`;
  }

  async function aiCall(kind) {
    const path = { briefing: "briefing", risks: "risks", deps: "dependencies" }[kind];
    AI.busy = kind; AI.error = ""; AI.note = ""; renderResults();
    try {
      const res = await fetch("/api/ai/" + path, { method: "POST", headers: RH, body: JSON.stringify({ plan: c.P, audience: AI.audience }) });
      if (res.status === 401) { toLogin(); return; }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
      if (kind === "briefing") AI.briefing = body;
      else { AI.kind = kind; AI.sugg = [...AI.sugg.filter((s) => (kind === "risks" ? ["blockedBy", "team", "handoff"] : ["tag", "area"]).includes(s.kind)), ...body.suggestions].map((s, i) => ({ ...s, id: String(i + 1) })); AI.note = body.suggestions.length ? "" : "Nothing new found."; }
    } catch (e) {
      AI.error = e.message;
    }
    AI.busy = "";
    renderResults();
  }

  /** Apply one approved suggestion to the plan. Returns true if something changed. */
  function aiApply(s) {
    if (s.kind === "handoff") {
      (c.P.handoffs ||= []).push({ what: s.value.what, from: s.value.from, to: s.value.to, owner: "", due: c.P.when.freezeAt || "", status: s.value.status || "Not started", blocks: s.value.blocks || "" });
      return true;
    }
    const t = c.P.tickets.find((x) => String(x.key).toUpperCase() === String(s.key).toUpperCase());
    if (!t) return false;
    if (s.kind === "tag") { t.tags = { ...(t.tags || {}), migration: true }; return true; }
    if (s.kind === "area") { t.area = s.value; return true; }
    if (s.kind === "team") { t.team = s.value; return true; }
    if (s.kind === "blockedBy") {
      const have = parseKeys(t.blockedBy);
      if (have.includes(String(s.value).toUpperCase())) return false;
      t.blockedBy = [...have, s.value].join(", ");
      return true;
    }
    return false;
  }

  function aiResolve(ids, apply) {
    let n = 0;
    for (const s of AI.sugg.filter((x) => ids.includes(x.id))) if (apply && aiApply(s)) n++;
    AI.sugg = AI.sugg.filter((x) => !ids.includes(x.id));
    AI.note = apply ? `Applied ${n}. Check the tickets and handoffs on the left.` : "";
    if (apply) { renderTickets(); renderHandoffs(); changed(); } else renderResults();
  }

  return { AG, AI, agentBarBtn, agentLoad, agentPost, agentCheck, agentItem, renderAgent, renderQuickHelpers, aiCall, aiApply, aiResolve };
}
