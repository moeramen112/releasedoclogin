// Release planner UI. Inputs on the left, live results on the right.
// The same engine and risk model the server uses run here, in the browser.
import { evaluate } from "/engine.js";
import { computeRisk } from "/risk.js";
import { analyzeDependencies, parseKeys, TEAMS, HANDOFF_STATUS } from "/deps.js";
import { mergeTickets, defaultPlan, blankPlan, nextPlan, applyTemplate, generateRunbook, planToSnapshot, planState, planConfig, briefMarkdown, reportModel, reportHtml, reportDocument, reportWord, statusModel, TYPES, PRIORITIES, TICKET_TYPES, STATUSES, AREAS, ENVIRONMENTS, STRATEGIES, CHECK_STATES, PHASES, ROLE_KEYS, TEMPLATES } from "/plan.js";

const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const OLD_KEY = "rr.plan.v1"; // the single plan the first version of the planner saved
const LIB_KEY = "rr.releases.v1";
const STANDALONE = typeof window !== "undefined" && window.__STANDALONE === true;
// The shareable preview: the example release, nothing can be changed, nothing is saved.
const READONLY = typeof window !== "undefined" && window.__READONLY === true;
const RUN_STATUS = ["todo", "doing", "done", "blocked"];
const LABEL = { pass: "Pass", warn: "At risk", fail: "Failing", pending: "Pending", waived: "Waived" };
const chip = (s) => `<span class="chip s-${s}"><i></i>${LABEL[s]}</span>`;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage can be unavailable */ } },
};

/* ---------- plan state ---------- */

const getPath = (o, p) => p.split(".").reduce((a, k) => (a == null ? a : a[k]), o);
function setPath(o, p, v) {
  const keys = p.split(".");
  const last = keys.pop();
  const target = keys.reduce((a, k) => a[k], o);
  target[last] = v;
}
function fillDefaults(def, val) {
  if (Array.isArray(def) || typeof def !== "object" || def === null) return val === undefined ? def : val;
  const out = {};
  for (const k of Object.keys(def)) out[k] = fillDefaults(def[k], val?.[k]);
  for (const k of Object.keys(val || {})) if (!(k in out)) out[k] = val[k];
  return out;
}
/* ---------- the release library: every release you have entered, saved in this browser ---------- */

const newId = () => "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
// What a saved plan is filled in from. Handoffs start empty, so an older plan never picks up the example's.
const FILL = () => ({ ...defaultPlan(), handoffs: [] });
const validPlan = (p) => Boolean(p && Array.isArray(p.tickets) && p.release);

function loadLib() {
  if (READONLY) { const id = newId(); return { current: id, order: [id], items: { [id]: { ...defaultPlan(), id } } }; }
  try {
    const raw = store.get(LIB_KEY);
    if (raw) {
      const l = JSON.parse(raw);
      const order = (l.order || []).filter((id) => validPlan(l.items?.[id]));
      if (order.length) {
        const items = {};
        for (const id of order) items[id] = { ...fillDefaults(FILL(), l.items[id]), id };
        return { current: items[l.current] ? l.current : order[0], order, items };
      }
    }
    const old = store.get(OLD_KEY); // keep whatever the first version saved
    if (old) {
      const p = JSON.parse(old);
      if (validPlan(p)) { const id = newId(); return { current: id, order: [id], items: { [id]: { ...fillDefaults(FILL(), p), id } } }; }
    }
  } catch { /* fall through to the example */ }
  const id = newId();
  return { current: id, order: [id], items: { [id]: { ...defaultPlan(), id } } };
}

let lib = loadLib();
let P = lib.items[lib.current];

/* ---------- saving ----------
   The single-file copy saves in this browser. Served by the server, releases are saved there instead,
   so everyone signed in sees the same ones. Each save names the version it started from; if someone
   else saved first, the server refuses and nothing is overwritten. */

const RH = { "Content-Type": "application/json", "X-Requested-With": "release-readiness" };
let remote = null; // { me, versions, pushed, chain, conflict, deleting }
let lastEdit = 0;
const readOnly = () => Boolean(remote && remote.me.role === "viewer");
const toLogin = () => location.replace("/login.html?next=" + encodeURIComponent(location.pathname));

function saveLib() {
  lib.items[lib.current] = P;
  if (READONLY) return;
  if (remote) { pushRemote(lib.current); return; }
  store.set(LIB_KEY, JSON.stringify(lib));
}

function setSaveState(text, kind = "") {
  const el = document.querySelector("#save-state");
  if (el) { el.textContent = text; el.className = "msg save-state " + kind; }
}

function pushRemote(id) {
  if (readOnly()) return;
  remote.chain = remote.chain.then(async () => {
    const plan = lib.items[id]; // the newest copy, not whatever was current when this was queued
    if (!plan || remote.conflict === id) return;
    const body = JSON.stringify(plan);
    if (remote.pushed[id] === body) return;
    setSaveState("Saving…");
    try {
      const res = await fetch("/api/releases/" + id, { method: "PUT", headers: RH, body: JSON.stringify({ plan, baseVersion: remote.versions[id] || 0 }) });
      const d = await res.json().catch(() => ({}));
      if (res.status === 401) { toLogin(); return; }
      if (res.status === 409) { remote.conflict = id; showConflict(d.error); setSaveState("Not saved", "bad"); return; }
      if (!res.ok) throw new Error(d.error || `Request failed (${res.status}).`);
      remote.versions[id] = d.version;
      remote.pushed[id] = body;
      setSaveState("Saved " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), "ok");
    } catch (e) {
      setSaveState("Not saved: " + e.message, "bad");
    }
  });
}

function removeRemote(id) {
  remote.deleting.add(id);
  remote.chain = remote.chain.then(async () => {
    try {
      const res = await fetch("/api/releases/" + id, { method: "DELETE", headers: RH });
      if (res.status === 401) { toLogin(); return; }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status}).`);
      delete remote.versions[id]; delete remote.pushed[id];
    } catch (e) {
      setSaveState("Could not delete on the server: " + e.message, "bad");
    } finally {
      remote.deleting.delete(id);
    }
  });
}

function showConflict(message) {
  const el = $("#rel-msg");
  if (!el) return;
  el.className = "msg bad";
  el.innerHTML = `${esc(message || "Someone else changed this release.")} Your edits here are <strong>not saved</strong>. <button class="btn small" type="button" data-act="conflict-load">Load their version</button> <button class="btn small" type="button" data-act="conflict-copy">Keep mine as a copy</button>`;
}

const fromServer = (r) => ({ ...fillDefaults(FILL(), r.plan), id: r.id });
function adopt(r) {
  const plan = fromServer(r);
  lib.items[r.id] = plan;
  remote.versions[r.id] = r.version;
  remote.pushed[r.id] = JSON.stringify(plan); // same as the server's copy, so loading never counts as an edit
  return plan;
}

function startRemote(d) {
  remote = { me: d.me, versions: {}, pushed: {}, chain: Promise.resolve(), conflict: null, deleting: new Set() };
  lib = { current: "", order: [], items: {} };
  for (const r of d.releases) { adopt(r); lib.order.push(r.id); }
  if (!lib.order.length) {
    const id = newId();
    lib.items[id] = { ...blankPlan(Date.now()), id };
    lib.order.push(id);
  }
  const wanted = new URLSearchParams(location.search).get("release") || store.get("rr.current");
  lib.current = lib.items[wanted] ? wanted : lib.order[0];
  P = lib.items[lib.current];
  if (readOnly()) {
    const t = $(".relbar .toolbar"); if (t) t.inert = true;
    const sv = $("#save-state"); if (sv) sv.textContent = "View only";
  }
}

/** Pick up other people's saves. Never replaces what you are in the middle of typing. */
async function pollServer() {
  if (!remote || document.hidden) return;
  try {
    const res = await fetch("/api/releases");
    if (res.status === 401) { toLogin(); return; }
    if (!res.ok) return;
    const d = await res.json();
    const idle = Date.now() - lastEdit > 5000 && !remote.conflict;
    const onServer = new Set(d.releases.map((r) => r.id));
    let redraw = false, note = "";
    for (const r of d.releases) {
      if (remote.deleting.has(r.id)) continue;
      const known = remote.versions[r.id];
      if (known === undefined) {
        if (lib.items[r.id]) continue; // made here, still saving
        adopt(r); lib.order.push(r.id); redraw = true;
      } else if (r.version > known) {
        if (r.id === lib.current && !idle) continue; // saving will report the clash
        adopt(r);
        if (r.id === lib.current) { P = lib.items[r.id]; redraw = "page"; note = `Updated with changes from ${r.updatedBy}.`; }
        else redraw = redraw || true;
      }
    }
    for (const id of [...lib.order]) {
      if (remote.versions[id] !== undefined && !onServer.has(id) && !remote.deleting.has(id)) {
        lib.order.splice(lib.order.indexOf(id), 1);
        delete lib.items[id]; delete remote.versions[id]; delete remote.pushed[id];
        redraw = true;
        if (id === lib.current) {
          if (!lib.order.length) { const b = { ...blankPlan(Date.now()), id: newId() }; lib.items[b.id] = b; lib.order.push(b.id); }
          lib.current = lib.order[0]; P = lib.items[lib.current]; redraw = "page"; note = "Someone deleted the release you had open.";
        }
      }
    }
    if (redraw === "page") { showRelease(); if (note) sayRel(note, false, "ok"); }
    else if (redraw) renderRelSelect();
  } catch { /* try again at the next poll */ }
}

let openWaive = null;
let waiveError = "";
let integrations = { jira: false, server: false };
let addOpen = null; // "person" | "signoff" | null: which inline add form is open
const lastCleared = {}; // one-step undo for Clear all

/* ---------- field schema ---------- */

const opt = (arr) => arr.map((v) => ({ v, l: v }));
const CHECK_OPTS = CHECK_STATES;

const SECTIONS = [
  { id: "what", title: "What is shipping", hint: "Name, type and what customers will notice.", fields: [
    { p: "release.name", l: "Release name", ph: "e.g. Release 4.13" },
    { p: "release.version", l: "Version", mono: true, ph: "4.13.0" },
    { p: "release.type", l: "Release type", t: "select", o: opt(TYPES), after: "tpl" },
    { p: "release.fixVersion", l: "Jira fix version", mono: true, ph: "4.13" },
    { p: "release.autoSync", l: "Refresh from Jira every few minutes (server does it, even when nobody has this page open)", t: "check", wide: true },
    { p: "release.slackAlerts", l: "Post to Slack when the go/no-go call changes", t: "check", wide: true },
    { p: "release.summary", l: "What changes", t: "textarea", wide: true },
    { p: "release.customerImpact", l: "Customer impact", t: "textarea", wide: true },
  ] },
  { id: "who", title: "Who is involved", hint: "Named owners flow into the runbook and the brief.", fields: ROLE_KEYS.map(([k, l]) => ({ p: `people.${k}`, l, ph: "Name" })) },
  { id: "when", title: "When", hint: "Dates drive the runbook times and the deploy timing risk.", fields: [
    { p: "when.freezeAt", l: "Code freeze", t: "datetime" },
    { p: "when.meetingAt", l: "Go/no-go meeting", t: "datetime" },
    { p: "when.deployAt", l: "Deploy starts", t: "datetime" },
    { p: "when.windowHours", l: "Deploy window", t: "number", suffix: "hours" },
  ] },
  { id: "where", title: "Where", hint: "Repository, branches, environments and services in scope.", fields: [
    { p: "where.repo", l: "Repository", mono: true, ph: "owner/name" },
    { p: "where.baseRef", l: "Compare from (tag)", mono: true, ph: "v4.12.0" },
    { p: "where.headRef", l: "Release branch", mono: true, ph: "release/4.13" },
    { p: "where.environments", l: "Environments", t: "multi", o: opt(ENVIRONMENTS), wide: true },
    { p: "where.services", l: "Services affected", wide: true, ph: "e.g. orders-api, billing, web-app" },
  ] },
  { id: "how", title: "How it ships and how it comes back", hint: "Rollout, flags and the rollback plan.", fields: [
    { p: "how.strategy", l: "Rollout strategy", t: "select", o: STRATEGIES },
    { p: "how.rollbackMinutes", l: "Rollback target", t: "number", suffix: "minutes" },
    { p: "how.channel", l: "Release channel", mono: true, ph: "#release-413" },
    { p: "how.flagsDefaultOff", l: "New features behind flags, default off", t: "check" },
    { p: "how.rollbackPlan", l: "Rollback plan", t: "textarea", wide: true },
    { p: "how.dashboards", l: "Dashboards to watch", wide: true },
    { p: "how.verification", l: "Verification steps", t: "textarea", wide: true },
  ] },
];

const SIGNAL_GROUPS = [
  { title: "CI on the release branch", fields: [
    { p: "signals.ci.total", l: "Checks run", t: "number" },
    { p: "signals.ci.flaky", l: "Quarantined (flaky) failures", t: "number" },
    { p: "signals.ci.pending", l: "Still running", t: "number" },
    { p: "signals.ci.realFailures", l: "Real failing checks, one per line", t: "textarea", wide: true },
  ] },
  { title: "Pull requests", fields: [
    { p: "signals.openPrs", l: "Scoped PRs still open", t: "number" },
    { p: "signals.failingOpenPrs", l: "Of those, failing checks", t: "number" },
    { p: "signals.mergedTotal", l: "PRs merged into the release", t: "number" },
    { p: "signals.lateMerged", l: "Merged after the freeze", t: "number" },
    { p: "signals.mergedUnapproved", l: "Merged without an approval", t: "number" },
  ] },
  { title: "Size of the change", fields: [
    { p: "signals.commits", l: "Commits", t: "number" },
    { p: "signals.authors", l: "Authors", t: "number" },
    { p: "signals.filesChanged", l: "Files changed", t: "number" },
    { p: "signals.linesChanged", l: "Lines changed", t: "number" },
    { p: "scope.maxFiles", l: "File budget", t: "number" },
    { p: "scope.maxLines", l: "Line budget", t: "number" },
  ] },
  { title: "Performance, coverage and security", fields: [
    { p: "signals.p95DeltaPct", l: "p95 latency change", t: "number", suffix: "%" },
    { p: "signals.p95BudgetPct", l: "p95 budget", t: "number", suffix: "%" },
    { p: "signals.coverageDeltaPp", l: "Coverage change", t: "number", suffix: "pp" },
    { p: "signals.coverageFloorPp", l: "Coverage floor", t: "number", suffix: "pp" },
    { p: "signals.securityCritical", l: "Critical vulnerabilities", t: "number" },
    { p: "signals.securityHigh", l: "High vulnerabilities", t: "number" },
  ] },
];

const CHECK_FIELDS = [
  { p: "checks.migration", l: "Migration dry run on production-size data", t: "select", o: CHECK_OPTS },
  { p: "checks.rollback", l: "Rollback rehearsed on staging", t: "select", o: CHECK_OPTS },
  { p: "checks.notes", l: "Release notes drafted", t: "select", o: CHECK_OPTS },
  { p: "checks.errorbudget", l: "Error budget above floor", t: "select", o: CHECK_OPTS },
];

/* ---------- input rendering ---------- */

const fid = (p) => "f-" + p.replace(/\./g, "-");

function selectHtml(p, options, value, extra = "") {
  const o = options.map((x) => (typeof x === "string" ? { v: x, l: x } : x));
  return `<select data-p="${p}" ${extra}>${o.map((x) => `<option value="${esc(x.v)}"${x.v === value ? " selected" : ""}>${esc(x.l)}</option>`).join("")}</select>`;
}

function fieldHtml(f) {
  const v = getPath(P, f.p);
  const id = fid(f.p);
  const cls = `field${f.wide ? " wide" : ""}`;
  const mono = f.mono ? " mono" : "";
  if (f.t === "check") {
    return `<div class="${cls}"><span class="lab">${esc(f.l)}</span><div class="checks"><label><input type="checkbox" id="${id}" data-p="${f.p}"${v ? " checked" : ""}> ${v ? "Yes" : "No"}</label></div></div>`;
  }
  if (f.t === "multi") {
    return `<div class="${cls}"><span class="lab">${esc(f.l)}</span><div class="checks">${f.o.map((o) => `<label><input type="checkbox" data-p="${f.p}" data-multi="1" value="${esc(o.v)}"${(v || []).includes(o.v) ? " checked" : ""}> ${esc(o.l)}</label>`).join("")}</div></div>`;
  }
  let control;
  if (f.t === "select") control = selectHtml(f.p, f.o, v, `id="${id}"`);
  else if (f.t === "textarea") control = `<textarea id="${id}" data-p="${f.p}" rows="3">${esc(v)}</textarea>`;
  else if (f.t === "number") control = `<input id="${id}" type="number" step="any" data-p="${f.p}" value="${esc(v)}">`;
  else if (f.t === "datetime") control = `<input id="${id}" type="datetime-local" data-p="${f.p}" value="${esc(v)}">`;
  else control = `<input id="${id}" class="${mono.trim()}" type="text" data-p="${f.p}" value="${esc(v)}" placeholder="${esc(f.ph || "")}" autocomplete="off">`;
  const after = f.after === "tpl"
    ? `<div class="row-actions"><button class="btn small" type="button" data-act="apply-template">Apply defaults for this type</button><span class="tpl-note">Sets rollout, window, rollback time, sign-off roles and the runbook.</span></div>`
    : f.suffix ? `<span class="suffix">${esc(f.suffix)}</span>` : "";
  return `<div class="${cls}"><label for="${id}">${esc(f.l)}</label>${control}${after}</div>`;
}

const section = (id, title, hint, body, head = "") =>
  `<section class="panel" id="sec-${id}" aria-labelledby="h-${id}"><div class="panel-head"><div class="sec-head"><h2 id="h-${id}">${esc(title)}</h2><span class="hint">${esc(hint)}</span></div>${head}</div>${body}</section>`;

function renderInputs() {
  addOpen = null;
  let html = SECTIONS.map((s) => section(s.id, s.title, s.hint, `<div class="fields">${s.fields.map(fieldHtml).join("")}</div>` + (s.id === "who"
    ? `<div id="extra-people" class="extra-people"></div><div id="person-add"></div><div class="row-actions"><button class="btn small" type="button" data-act="add-person">Add person</button><span class="msg">Add a role that is not listed, such as Legal or Support lead.</span></div>` : ""))).join("");

  html += section("tickets", "Jira tickets and story points", "Points drive the scope forecast. Bugs at P0 and P1 are treated as blockers until they are done.",
    `<div class="fields">${[
      { p: "scope.velocity", l: "Team velocity", t: "number", suffix: "points per working day" },
      { p: "scope.bigAt", l: "Large ticket at", t: "number", suffix: "points or more" },
    ].map(fieldHtml).join("")}</div>
     <div class="tablewrap"><table class="tbl tk" style="min-width:1340px"><thead><tr><th>Key</th><th>Summary</th><th title="The team doing the work">Team</th><th title="Tickets that must be Done first. Separate keys with commas.">Blocked by</th><th>Type</th><th>Pri</th><th>Pts</th><th>Status</th><th>Assignee</th><th>Area</th><th title="Includes a database migration">Mig</th><th title="Customers will see this">Cust</th><th title="Lacks automated tests">No tests</th><th></th></tr></thead><tbody id="tickets-body"></tbody></table></div>
     <div class="row-actions"><button class="btn small" type="button" data-act="add-ticket">Add ticket</button><button class="btn small" type="button" data-act="pull-jira" id="b-jira">Pull from Jira</button><button class="btn small" type="button" data-act="refresh-jira" id="b-jira-refresh" title="Update statuses and points of the tickets below, and add new ones. Keeps tickets you typed by hand.">Refresh from Jira</button><span id="tk-clear"></span><span class="msg" id="tk-sum"></span><span class="msg" id="jira-msg"></span><span class="msg" id="sync-state"></span></div>`);

  html += section("handoffs", "Handoffs between teams", "Work one team must hand to another before it can start. Each handoff blocks the tickets you name until it is Done.",
    `<div class="tablewrap"><table class="tbl" style="min-width:1000px"><thead><tr><th>Handed over</th><th>From</th><th>To</th><th>Owner</th><th>Due</th><th>Status</th><th title="Ticket keys, separated by commas">Blocks</th><th></th></tr></thead><tbody id="handoffs-body"></tbody></table></div>
     <div class="row-actions"><button class="btn small" type="button" data-act="add-handoff">Add handoff</button><span class="msg">Ticket-to-ticket dependencies go in the Blocked by column above.</span></div>`);

  html += section("signals", "Quality signals", "What the engine checks against budgets. With GitHub and CI connected these fill in on their own.",
    SIGNAL_GROUPS.map((g) => `<div class="sec-head"><h2>${esc(g.title)}</h2></div><div class="fields">${g.fields.map(fieldHtml).join("")}</div>`).join(""));

  html += section("checks", "Checks and sign-offs", "Things a person confirms. Anything not done holds the release.",
    `<div class="fields">${CHECK_FIELDS.map(fieldHtml).join("")}</div>
     <div class="sec-head"><h2>Sign-offs</h2></div>
     <div id="signoffs"></div><div id="signoff-add"></div><div class="row-actions"><button class="btn small" type="button" data-act="add-signoff">Add sign-off role</button><span class="msg">Name the role and who approves it.</span></div>`);

  html += section("runbook", "Runbook", "Prefilled from the dates, owners and rollout strategy above. Edit any row.",
    `<div class="tablewrap"><table class="tbl" style="min-width:760px"><thead><tr><th>Phase</th><th>Step</th><th>Owner</th><th>When</th><th>Status</th><th></th></tr></thead><tbody id="runbook-body"></tbody></table></div>
     <div class="row-actions"><button class="btn small" type="button" data-act="add-step">Add step</button><button class="btn small" type="button" data-act="regen-runbook">Regenerate from plan</button><span id="rb-clear"></span><span class="msg" id="rb-msg">Regenerating replaces your edits to these rows.</span></div>`);

  html += `<datalist id="people-list"></datalist>`;
  $("#inputs").innerHTML = html;
  renderExtraPeople();
  renderSignoffs();
  renderPeopleList();
  renderTickets();
  renderHandoffs();
  renderRunbook();
  renderClear(true);
  updateJiraButton();
}

const TEAM_OPTS = [{ v: "", l: "—" }, ...TEAMS.map((x) => ({ v: x, l: x }))];

/** A note when a "blocked by" names a ticket that is not in this release. */
function blockedUnknown(t) {
  const known = new Set(P.tickets.map((x) => String(x.key).toUpperCase()));
  const bad = parseKeys(t.blockedBy).filter((k) => !known.has(k) && k !== String(t.key).toUpperCase());
  return bad.length ? `${bad.join(", ")} ${bad.length === 1 ? "is" : "are"} not in this release's ticket list, so ${bad.length === 1 ? "it counts" : "they count"} as unresolved.` : "";
}

function renderHandoffs() {
  const body = $("#handoffs-body");
  if (!body) return;
  P.handoffs ||= [];
  body.innerHTML = P.handoffs.map((h, i) => {
    const b = `handoffs.${i}`;
    return `<tr>
      <td><input class="s" type="text" data-p="${b}.what" value="${esc(h.what)}" placeholder="Final designs" aria-label="What is handed over"></td>
      <td>${selectHtml(`${b}.from`, TEAM_OPTS, h.from || "", `class="tm" aria-label="From team"`)}</td>
      <td>${selectHtml(`${b}.to`, TEAM_OPTS, h.to || "", `class="tm" aria-label="To team"`)}</td>
      <td><input class="ow" type="text" list="people-list" data-p="${b}.owner" value="${esc(h.owner)}" aria-label="Owner"></td>
      <td><input class="wh" type="datetime-local" data-p="${b}.due" value="${esc(h.due)}" aria-label="Due"></td>
      <td>${selectHtml(`${b}.status`, HANDOFF_STATUS, h.status || "Not started", `class="st" aria-label="Status"`)}</td>
      <td><input class="bb mono" type="text" data-p="${b}.blocks" value="${esc(h.blocks)}" placeholder="REL-1, REL-2" aria-label="Tickets this blocks"></td>
      <td><button class="icon-btn" type="button" data-act="del-handoff" data-i="${i}" aria-label="Remove handoff">×</button></td></tr>`;
  }).join("") || `<tr><td colspan="8" class="msg">No handoffs yet. Add one for anything a team must hand over before another can start, such as designs before tickets, or a merge before QA.</td></tr>`;
}

function renderTickets() {
  $("#tickets-body").innerHTML = P.tickets.map((t, i) => {
    const b = `tickets.${i}`;
    const tag = (k, label) => `<td class="c"><input type="checkbox" data-p="${b}.tags.${k}" aria-label="${label} for ${esc(t.key)}"${t.tags?.[k] ? " checked" : ""}></td>`;
    return `<tr>
      <td><input class="k mono" type="text" data-p="${b}.key" value="${esc(t.key)}" aria-label="Ticket key"></td>
      <td><input class="s" type="text" data-p="${b}.summary" value="${esc(t.summary)}" aria-label="Summary for ${esc(t.key)}"></td>
      <td>${selectHtml(`${b}.team`, TEAM_OPTS, t.team || "", `class="tm" aria-label="Team for ${esc(t.key)}"`)}</td>
      <td><input class="bb mono${blockedUnknown(t) ? " warn-in" : ""}" type="text" data-p="${b}.blockedBy" value="${esc(t.blockedBy || "")}" placeholder="REL-1, REL-2" aria-label="Blocked by, for ${esc(t.key)}"${blockedUnknown(t) ? ` title="${esc(blockedUnknown(t))}"` : ""}></td>
      <td>${selectHtml(`${b}.type`, TICKET_TYPES, t.type, `class="ty" aria-label="Type"`)}</td>
      <td>${selectHtml(`${b}.priority`, PRIORITIES, t.priority, `class="pr" aria-label="Priority"`)}</td>
      <td><input class="pt" type="number" min="0" step="0.5" data-p="${b}.points" value="${esc(t.points)}" aria-label="Story points for ${esc(t.key)}"></td>
      <td>${selectHtml(`${b}.status`, STATUSES, t.status, `class="st" aria-label="Status"`)}</td>
      <td><input class="as" type="text" data-p="${b}.assignee" value="${esc(t.assignee)}" aria-label="Assignee"></td>
      <td>${selectHtml(`${b}.area`, AREAS, t.area, `class="ar" aria-label="Area"`)}</td>
      ${tag("migration", "Migration")}${tag("customerFacing", "Customer facing")}${tag("untested", "Lacks tests")}
      <td><button class="icon-btn" type="button" data-act="del-ticket" data-i="${i}" aria-label="Remove ${esc(t.key)}">×</button></td></tr>`;
  }).join("") || `<tr><td colspan="14" class="msg">No tickets yet. Add one, or pull the fix version from Jira.</td></tr>`;
}

function renderRunbook() {
  $("#runbook-body").innerHTML = P.runbook.map((r, i) => {
    const b = `runbook.${i}`;
    return `<tr>
      <td>${selectHtml(`${b}.phase`, PHASES, r.phase, `class="ph" aria-label="Phase"`)}</td>
      <td><input class="s" type="text" data-p="${b}.step" value="${esc(r.step)}" aria-label="Step"></td>
      <td><input class="ow" type="text" list="people-list" data-p="${b}.owner" value="${esc(r.owner)}" aria-label="Owner"></td>
      <td><input class="wh" type="datetime-local" data-p="${b}.at" value="${esc(r.at)}" aria-label="When"></td>
      <td>${selectHtml(`${b}.status`, RUN_STATUS, r.status, `class="st" aria-label="Status"`)}</td>
      <td><button class="icon-btn" type="button" data-act="del-step" data-i="${i}" aria-label="Remove step">×</button></td></tr>`;
  }).join("");
}


/* ---------- custom people, sign-offs, clear all ---------- */

function addFormHtml(kind) {
  const person = kind === "person";
  return `<form class="form addform" data-form="add-${kind}">
    <label>${person ? "Field name" : "Role name"}<input name="label" required maxlength="60" autocomplete="off" placeholder="${person ? "e.g. Legal reviewer" : "e.g. Legal"}"></label>
    <label>${person ? "Owner" : "Approver name"}<input name="name" maxlength="80" autocomplete="off" placeholder="Person's name"></label>
    ${person ? "" : `<div><span class="lab">Approved</span><span class="radios" role="radiogroup" aria-label="Approved"><label><input type="radio" name="approved" value="false" checked> Pending</label><label><input type="radio" name="approved" value="true"> Approved</label></span></div>`}
    <div class="err" role="alert" hidden></div>
    <div class="row"><button class="btn small primary" type="submit">${person ? "Add field" : "Add sign-off"}</button><button class="btn small" type="button" data-act="cancel-add">Cancel</button></div></form>`;
}

function renderExtraPeople() {
  const rows = (P.extraPeople || []).map((x, i) => `<div class="extra-row"><input type="text" data-p="extraPeople.${i}.label" value="${esc(x.label)}" aria-label="Field name" placeholder="Field name"><input type="text" data-p="extraPeople.${i}.name" value="${esc(x.name)}" aria-label="${esc(x.label)} owner" placeholder="Owner"><button class="icon-btn" type="button" data-act="del-person" data-i="${i}" aria-label="Remove ${esc(x.label)}">×</button></div>`).join("");
  $("#extra-people").innerHTML = rows ? `<div class="lab-row">Custom fields</div>${rows}` : "";
  $("#person-add").innerHTML = addOpen === "person" ? addFormHtml("person") : "";
}

function renderSignoffs() {
  $("#signoffs").innerHTML = P.signoffs.map((s, i) => `<div class="signoff"><input type="text" class="role" data-p="signoffs.${i}.role" value="${esc(s.role)}" aria-label="Role name"><input type="text" data-p="signoffs.${i}.who" value="${esc(s.who)}" aria-label="${esc(s.role)} approver" placeholder="Approver"><span class="radios" role="radiogroup" aria-label="${esc(s.role)} approval"><label><input type="radio" name="so-${i}" data-p="signoffs.${i}.approved" value="false"${s.approved ? "" : " checked"}> Pending</label><label><input type="radio" name="so-${i}" data-p="signoffs.${i}.approved" value="true"${s.approved ? " checked" : ""}> Approved</label></span><button class="icon-btn" type="button" data-act="del-signoff" data-i="${i}" aria-label="Remove ${esc(s.role)}">×</button></div>`).join("")
    || `<div class="msg">No sign-offs required. Add a role if someone must approve.</div>`;
  $("#signoff-add").innerHTML = addOpen === "signoff" ? addFormHtml("signoff") : "";
}

function renderPeopleList() {
  const names = [...new Set([...Object.values(P.people), ...(P.extraPeople || []).map((x) => x.name)].map((n) => String(n || "").trim()).filter(Boolean))];
  const dl = $("#people-list");
  if (dl) dl.innerHTML = names.map((n) => `<option value="${esc(n)}">`).join("");
}

let clearSig = "";
function renderClear(force = false) {
  const sig = `${P.tickets.length > 0}|${P.runbook.length > 0}`;
  if (!force && sig === clearSig) return;
  clearSig = sig;
  const slot = (id, what, label, n) => { const el = $("#" + id); if (el) el.innerHTML = `<button class="btn small" type="button" data-act="clear" data-what="${what}"${n ? "" : " disabled"}>${label}</button>`; };
  slot("tk-clear", "tickets", "Clear all tickets", P.tickets.length);
  slot("rb-clear", "runbook", "Clear all steps", P.runbook.length);
}

function sayUndo(id, text, what) {
  const el = $("#" + id);
  if (el) { el.className = "msg"; el.innerHTML = `${esc(text)} <button class="btn small" type="button" data-act="undo-clear" data-what="${what}">Undo</button>`; }
}


/* ---------- library actions ---------- */

function relLabel(p, now) {
  let tail = "";
  try {
    const r = evaluate(planToSnapshot(p, now), planConfig(p), planState(p));
    tail = ` · ${r.verdict.call} · risk ${computeRisk(p, now).score}`;
  } catch { /* a broken plan still gets a name */ }
  return (p.release.name || "Untitled release") + tail;
}

function renderRelSelect() {
  const now = Date.now(), sel = $("#rel-select");
  if (!sel) return;
  sel.innerHTML = lib.order.map((id) => `<option value="${esc(id)}"${id === lib.current ? " selected" : ""}>${esc(relLabel(id === lib.current ? P : lib.items[id], now))}</option>`).join("");
}

function showRelease() {
  openWaive = null; waiveError = "";
  if (remote) store.set("rr.current", lib.current);
  saveLib();
  renderInputs();
  renderResults();
}

function openRelease(id) {
  if (!lib.items[id]) return;
  lib.items[lib.current] = P;
  lib.current = id;
  P = lib.items[id];
  showRelease();
}

function addRelease(plan) {
  plan.id = newId();
  lib.items[lib.current] = P;
  lib.items[plan.id] = plan;
  lib.order.push(plan.id);
  lib.current = plan.id;
  P = plan;
  showRelease();
}

let lastDeleted = null;
function deleteRelease() {
  const id = lib.current, idx = lib.order.indexOf(id), name = P.release.name || "Untitled release";
  lastDeleted = { plan: P, idx };
  lib.order.splice(idx, 1);
  delete lib.items[id];
  if (remote) removeRemote(id);
  if (!lib.order.length) { const b = { ...blankPlan(Date.now(), P.release.type), id: newId() }; lib.items[b.id] = b; lib.order.push(b.id); }
  lib.current = lib.order[Math.min(idx, lib.order.length - 1)];
  P = lib.items[lib.current];
  showRelease();
  sayRel(`Deleted “${name}”.`, true);
}

function sayRel(text, undo = false, kind = "") {
  const el = $("#rel-msg");
  el.className = "msg " + kind;
  el.innerHTML = esc(text) + (undo ? ` <button class="btn small" type="button" data-act="rel-undo">Undo</button>` : "");
}

/* ---------- results ---------- */

function compute() {
  const now = Date.now();
  const snapshot = planToSnapshot(P, now);
  const result = evaluate(snapshot, planConfig(P), planState(P));
  const risk = computeRisk(P, now);
  const deps = analyzeDependencies(P.tickets, P.handoffs, now, Date.parse(P.when.freezeAt) || null);
  const model = reportModel(P, result, risk, now);
  return { now, result, risk, deps, model, brief: briefMarkdown(P, result, risk, now) };
}

const ratioColor = (r) => (r >= 0.66 ? "var(--bad)" : r >= 0.33 ? "var(--warn)" : "var(--good)");
const FC_CHIP = { complete: "pass", "on-track": "pass", tight: "warn", behind: "fail", "after-freeze": "fail", unknown: "pending" };
const FC_TEXT = { complete: "Complete", "on-track": "On track", tight: "Tight", behind: "Behind", "after-freeze": "Open after freeze", unknown: "No velocity" };

function renderSumbar({ result, risk, now }) {
  const v = result.verdict, cls = { "NO-GO": "nogo", HOLD: "hold", GO: "go" }[v.call];
  const deploy = Date.parse(P.when.deployAt);
  const days = Number.isNaN(deploy) ? "not set" : deploy < now ? "passed" : `${Math.max(0, Math.round(((deploy - now) / 86400000) * 10) / 10)} d`;
  const kv = (b, s, c = "") => `<div class="kv"><b class="${c}">${esc(b)}</b><span>${esc(s)}</span></div>`;
  $("#sumbar").innerHTML =
    `<span class="call ${cls}">${esc(v.call)}</span>` +
    kv(`${risk.score}/100`, `Risk · ${risk.level}`, `lvl-${risk.level}`) +
    kv(`${risk.points.pctDone}%`, `Points done · ${risk.points.done}/${risk.points.total}`) +
    kv(days, "To deploy") +
    kv(`${v.counts.fail + v.counts.warn + v.counts.pending}`, "Criteria open") +
    `<span class="spacer"></span><div class="toolbar">${STANDALONE ? `<button class="btn small" type="button" data-act="copy-json">Copy plan JSON</button>` : `<button class="btn small" type="button" data-act="export">Export plan</button>`}</div>`;
}

function renderVerdict({ result }) {
  const { verdict, criteria } = result;
  const cls = { "NO-GO": "nogo", HOLD: "hold", GO: "go" }[verdict.call];
  const total = criteria.length || 1;
  const bar = ["pass", "waived", "warn", "pending", "fail"].map((k) => `<span class="p-${k}" style="width:${(verdict.counts[k] / total) * 100}%" title="${LABEL[k]}: ${verdict.counts[k]}"></span>`).join("");
  const tally = ["pass", "warn", "pending", "fail", "waived"].filter((k) => verdict.counts[k]).map((k) => `<span class="chip s-${k}"><i></i>${verdict.counts[k]} ${LABEL[k].toLowerCase()}</span>`).join("");
  const holding = criteria.filter((c) => verdict.holding.includes(c.id));
  const list = holding.length
    ? `<div class="holding"><h3>What is holding the release</h3><ul>${holding.map((c) => `<li>${chip(c.effective)}<span><strong>${esc(c.name)}</strong> <span class="mono">${esc(c.detail)}</span></span></li>`).join("")}</ul></div>`
    : `<div class="holding"><h3>Nothing is holding the release</h3></div>`;
  return `<section class="verdict" aria-label="Go/no-go verdict"><div class="v-badge ${cls}"><span class="label">Current call</span><span class="word">${esc(verdict.call)}</span><span>${esc(verdict.reason)}</span></div><div class="v-body"><div class="tally">${tally}</div><div class="progress" role="img" aria-label="Criteria mix">${bar}</div>${list}</div></section>`;
}

function renderRisk({ risk }) {
  const sorted = [...risk.factors].sort((a, b) => b.points - a.points);
  const active = sorted.filter((f) => f.points > 0), quiet = sorted.filter((f) => f.points === 0);
  const rows = active.map((f) => {
    const r = f.points / f.max;
    return `<div class="factor"><span class="fl">${esc(f.label)}</span><span class="fv">${f.points} / ${f.max}</span><div class="fb"><i style="width:${r * 100}%;background:${ratioColor(r)}"></i></div><span class="fd">${esc(f.detail)}</span></div>`;
  }).join("");
  const recs = risk.recommendations.length
    ? `<div class="sec-head"><h2>What to do about it</h2></div><ol class="recs">${risk.recommendations.map((r) => `<li><strong>${esc(r.label)}.</strong> ${esc(r.advice)}</li>`).join("")}</ol>`
    : `<div class="msg">No single factor is driving the risk.</div>`;
  const ladder = `<div class="sec-head"><h2>Suggested rollout for this risk level</h2></div><div class="ladder">${risk.ladder.steps.map((p, i) => `${i ? '<span class="arrow">→</span>' : ""}<span class="step">${p}%</span>`).join("")}<span class="msg">${risk.ladder.bake} minute bake</span></div><div class="msg">${esc(risk.ladder.note)}</div>`;
  return `<section class="panel"><h2>Risk analysis</h2>
    <div class="risk-head"><div><div class="risk-score">${risk.score}<small> / 100</small></div><div class="risk-level lvl-${risk.level}">${risk.level} risk</div></div>
    <div class="meter-wrap"><div class="meter"><span class="m1"></span><span class="m2"></span><span class="m3"></span><span class="m4"></span></div><div class="meter-mark" style="left:${risk.score}%"></div><div class="meter-labels"><span>0</span><span>25</span><span>50</span><span>75</span><span>100</span></div></div></div>
    <div>${rows}</div>${quiet.length ? `<div class="msg">No risk from: ${quiet.map((f) => esc(f.label.toLowerCase())).join(", ")}.</div>` : ""}
    ${recs}${ladder}</section>`;
}

function renderPoints({ risk }) {
  const p = risk.points, fc = risk.forecast, t = p.total || 1;
  const areas = Object.entries(p.byArea).sort((a, b) => b[1].total - a[1].total);
  return `<section class="panel"><div class="panel-head"><h2>Story points</h2><span class="chip s-${FC_CHIP[fc.state]}"><i></i>${FC_TEXT[fc.state]}</span></div>
    <div class="pts-stack" role="img" aria-label="${p.done} done, ${p.inFlight} in flight, ${p.todo} not started"><span style="width:${(p.done / t) * 100}%;background:var(--good)"></span><span style="width:${(p.inFlight / t) * 100}%;background:var(--pend)"></span><span style="width:${(p.todo / t) * 100}%;background:var(--line)"></span></div>
    <div class="legend"><span><i style="background:var(--good)"></i>Done ${p.done}</span><span><i style="background:var(--pend)"></i>In flight ${p.inFlight}</span><span><i style="background:var(--line)"></i>Not started ${p.todo}</span></div>
    <div class="stats"><div class="stat"><b>${p.total}</b><span>Total points</span></div><div class="stat"><b>${p.remaining}</b><span>Remaining</span></div><div class="stat"><b>${fc.needPerDay ?? "n/a"}</b><span>Needed per day</span></div><div class="stat"><b>${fc.velocity || "n/a"}</b><span>Velocity per day</span></div></div>
    <div class="msg">${esc(fc.detail)}</div>
    <div>${areas.map(([a, v]) => `<div class="area-row"><span>${esc(a)}</span><div class="fb"><i style="width:${v.total ? (v.done / v.total) * 100 : 0}%"></i></div><span class="mono">${v.done}/${v.total}</span></div>`).join("")}</div></section>`;
}

function renderDeps({ result, deps }) {
  const c = result.criteria.find((x) => x.id === "deps");
  const head = `<div class="panel-head"><h2>Dependencies</h2>${c ? chip(c.effective) : ""}</div>`;
  if (!deps.any) return `<section class="panel">${head}<div class="msg">Nothing entered yet. Use <strong>Team</strong> and <strong>Blocked by</strong> on the tickets, and <strong>Handoffs between teams</strong> below them, to show what waits on what. Pulling from Jira fills in "is blocked by" links for you.</div></section>`;
  const on = (w) => w.on.map((x) => (x.kind === "handoff" ? `${esc(x.what)} <span class="msg">(${esc(x.team || "handoff")}, ${esc(x.status)})</span>` : `<span class="mono">${esc(x.key)}</span> <span class="msg">(${esc(x.status)})</span>`)).join(", ");
  const h3 = (t) => `<div class="sec-head"><h2>${esc(t)}</h2></div>`;
  let html = head + (c ? `<div class="msg">${esc(c.detail)}</div>` : "");
  if (deps.cycles.length) html += `<div class="banner bad" role="alert"><strong>Circular dependency.</strong><span>${deps.cycles.map((x) => esc([...x, x[0]].join(" → "))).join("; ")}. None of these can start until one of the links is removed.</span></div>`;
  if (deps.longestChain.length >= 2) html += h3("Longest chain, in the order it must happen") + `<div class="ladder">${deps.longestChain.keys.map((k, i) => `${i ? '<span class="arrow">→</span>' : ""}<span class="step mono">${esc(k)}</span>`).join("")}</div>`;
  if (deps.finishFirst.length) html += h3("Finish these first") + `<ul class="plain">${deps.finishFirst.map((x) => `<li><span class="mono">${esc(x.key)}</span>${x.team ? ` <span class="msg">${esc(x.team)}</span>` : ""} ${esc(x.summary)}: holds up ${x.unblocks} ${x.unblocks === 1 ? "ticket" : "tickets"}</li>`).join("")}</ul>`;
  if (deps.waiting.length) html += h3("Waiting") + `<div class="tablewrap"><table class="tbl"><thead><tr><th>Ticket</th><th>Team</th><th>Status</th><th>Waiting on</th></tr></thead><tbody>${deps.waiting.map((w) => `<tr><td><span class="mono">${esc(w.key)}</span> ${esc(w.summary)}</td><td>${esc(w.team || "—")}</td><td>${esc(w.status)}</td><td>${on(w)}</td></tr>`).join("")}</tbody></table></div>`;
  if (deps.startedEarly.length) html += h3("Started before the input was done") + `<ul class="plain">${deps.startedEarly.map((w) => `<li><span class="mono">${esc(w.key)}</span> is ${esc(w.status.toLowerCase())} but waiting on ${on(w)}</li>`).join("")}</ul>`;
  if (deps.ready.length) html += h3("Ready to start now") + `<ul class="plain">${deps.ready.map((x) => `<li><span class="mono">${esc(x.key)}</span> ${esc(x.summary)}</li>`).join("")}</ul>`;
  const lateH = [...deps.handoffs.overdue.map((x) => `${esc(x.what)} (${esc(x.from || "?")} to ${esc(x.to || "?")}) is overdue`), ...deps.handoffs.blocked.map((x) => `${esc(x.what)} is blocked`), ...deps.handoffs.afterFreeze.map((x) => `${esc(x.what)} is due after the code freeze`)];
  if (lateH.length) html += h3("Handoffs to chase") + `<ul class="plain">${lateH.map((x) => `<li>${x}</li>`).join("")}</ul>`;
  return `<section class="panel">${html}</section>`;
}

function renderCriteria({ result }) {
  const order = { fail: 0, warn: 1, pending: 2, waived: 3, pass: 4 };
  const sorted = [...result.criteria].sort((a, b) => order[a.effective] - order[b.effective]);
  const rows = sorted.map((c) => {
    const w = c.waiver, active = w && w.valid && !w.stale;
    const wn = w && c.effective === "waived" ? `<div class="wn">Waived by ${esc(w.approver)}: ${esc(w.reason)}</div>`
      : w && w.stale ? `<div class="wn stale">A waiver from ${esc(w.approver)} no longer applies because this got worse.</div>` : "";
    const btns = [
      c.status !== "pass" && !active ? `<button class="btn small" type="button" data-act="waive" data-id="${esc(c.id)}">Waive</button>` : "",
      w ? `<button class="btn small" type="button" data-act="unwaive" data-id="${esc(c.id)}">Remove waiver</button>` : "",
    ].join("");
    const form = openWaive === c.id
      ? `<form class="form wf" data-form="waive" data-id="${esc(c.id)}"><label>Approved by<input name="approver" required maxlength="80" value="${esc(P.people.releaseManager)}"></label><label>Reason<textarea name="reason" required maxlength="400" placeholder="Why this is acceptable, and what follows (a hotfix, a monitor)"></textarea></label>${waiveError ? `<div class="err" role="alert">${esc(waiveError)}</div>` : ""}<div class="row"><button class="btn small primary" type="submit">Record waiver</button><button class="btn small" type="button" data-act="close-waive">Cancel</button></div></form>` : "";
    return `<div class="crow">${chip(c.effective)}<div><span class="cn">${esc(c.name)}</span><span class="adv">${c.required ? "REQUIRED" : "ADVISORY"}</span><div class="cd">${esc(c.detail)}</div></div><div class="row-actions">${btns}</div>${wn}${form}</div>`;
  }).join("");
  return `<section class="panel"><div class="panel-head"><h2>Go/no-go criteria</h2><span class="note">A waiver needs a named approver and a reason.</span></div><div>${rows}</div></section>`;
}

function renderBrief({ brief }) {
  return `<section class="panel"><div class="panel-head"><h2>Release brief</h2><div class="row-actions"><button class="btn small" type="button" data-act="copy-doc" title="Paste into Google Docs, Word, Confluence or Notion with formatting kept">Copy for Docs</button><button class="btn small" type="button" data-act="copy-brief">Copy Markdown</button>${STANDALONE ? "" : `<button class="btn small" type="button" data-act="download-word">Word (.doc)</button><button class="btn small" type="button" data-act="download-doc" title="Open it, then Print and Save as PDF">Printable page</button><button class="btn small" type="button" data-act="download-status" title="One page for leadership">Status one-pager</button><button class="btn small" type="button" data-act="download-brief">.md</button>`}<span class="msg" id="brief-msg"></span></div></div><pre class="brief" id="brief">${esc(brief)}</pre></section>`;
}

let last = null;
function renderResults() {
  try {
    last = compute();
  } catch (e) {
    $("#results").innerHTML = `<div class="banner bad"><strong>Could not compute the results.</strong><span>${esc(e.message)}</span></div>`;
    return;
  }
  renderSumbar(last);
  const fresh = !P.release.name.trim() && P.tickets.length === 0 && !Number(P.signals.ci.total);
  const roNote = READONLY ? `<div class="banner"><strong>View only.</strong><span>This is an example release with invented names and numbers. You can look at everything, but nothing can be changed or saved.</span></div>` : "";
  const note = roNote + (fresh ? `<div class="banner"><strong>New release.</strong><span>Name it and set the dates on the left, then add tickets or pull them from Jira. The call stays HOLD until the checks have data, and anything unknown counts as risk.</span></div>` : "");
  renderRelSelect();
  $("#results").innerHTML = note + renderVerdict(last) + renderRisk(last) + renderPoints(last) + renderDeps(last) + renderCriteria(last) + renderBrief(last);
  const p = last.risk.points;
  const sum = $("#tk-sum");
  if (sum) sum.textContent = `${p.tickets} tickets · ${p.total} points · ${p.done} done`;
}

/* ---------- saving and events ---------- */

let raf = 0, saveTimer = 0;
function changed() {
  lastEdit = Date.now();
  if (readOnly()) setSaveState("View only: changes are not saved.", "bad");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveLib, 250);
  clearTimeout(syncTimer); syncTimer = setTimeout(showSync, 1200);
  renderClear();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(renderResults);
}

function onEdit(e) {
  const el = e.target.closest("[data-p]");
  if (!el) return;
  if (el.dataset.multi) {
    setPath(P, el.dataset.p, [...document.querySelectorAll(`[data-multi][data-p="${el.dataset.p}"]:checked`)].map((x) => x.value));
  } else if (el.type === "radio") {
    if (el.checked) setPath(P, el.dataset.p, el.value === "true");
  } else if (el.type === "checkbox") {
    setPath(P, el.dataset.p, el.checked);
    const lab = el.closest("label");
    if (lab && el.dataset.p === "how.flagsDefaultOff") lab.lastChild.textContent = el.checked ? " Yes" : " No";
  } else if (el.type === "number") {
    setPath(P, el.dataset.p, el.value === "" ? 0 : Number(el.value));
  } else {
    setPath(P, el.dataset.p, el.value);
  }
  if (/^(people|extraPeople)\./.test(el.dataset.p)) renderPeopleList();
  changed();
}
document.addEventListener("input", onEdit);
document.addEventListener("change", onEdit);

const blankTicket = () => ({ key: "REL-", summary: "", type: "Story", priority: "P2", points: 0, status: "To do", assignee: "", area: "Core", team: "", blockedBy: "", tags: { migration: false, customerFacing: false, untested: false } });

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const slug = () => (P.release.name || "release").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function say(id, text, kind = "") {
  const el = $("#" + id);
  if (el) { el.textContent = text; el.className = "msg " + kind; }
}

function updateJiraButton() {
  const why = integrations.jira ? "" : integrations.server ? "Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN on the server" : "Available when running the server (npm start)";
  for (const id of ["#b-jira", "#b-jira-refresh"]) {
    const b = $(id);
    if (!b) continue;
    b.disabled = !integrations.jira;
    if (why) b.title = why;
  }
}

let syncTimer;
const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
async function showSync() {
  const el = $("#sync-state");
  if (!el || !remote || !P) return;
  try {
    const res = await fetch("/api/sync");
    if (!res.ok) return;
    const s = (await res.json())[lib.current] || {};
    const bits = [];
    if (P.release.autoSync) bits.push(s.lastError ? `Auto-refresh failed: ${s.lastError}` : s.lastSync ? `Auto-refreshed from Jira ${ago(s.lastSync)}.` : "Auto-refresh is on. First run within a minute.");
    if (P.release.slackAlerts && s.lastCall) bits.push(`Slack alerts watching: ${s.lastCall}.`);
    if (s.alertError) bits.push(`Slack failed: ${s.alertError}`);
    el.textContent = bits.join(" ");
    el.className = "msg" + (s.lastError || s.alertError ? " bad" : "");
  } catch { /* status is a nicety */ }
}

async function refreshJira() {
  const version = P.release.fixVersion.trim();
  if (!version) { say("jira-msg", "Enter the Jira fix version first.", "bad"); return; }
  say("jira-msg", "Refreshing from Jira…");
  try {
    const res = await fetch("/api/jira/issues?version=" + encodeURIComponent(version));
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
    const m = mergeTickets(P.tickets, body.issues);
    P.tickets = m.tickets;
    renderTickets(); changed();
    say("jira-msg", `Refreshed ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}: ${m.updated} updated, ${m.added} new, ${m.kept} not in Jira kept as they were.`, "ok");
  } catch (e) {
    say("jira-msg", e.message, "bad");
  }
}

async function pullJira() {
  const version = P.release.fixVersion.trim();
  if (!version) { say("jira-msg", "Enter the Jira fix version first.", "bad"); return; }
  say("jira-msg", "Loading from Jira…");
  try {
    const res = await fetch("/api/jira/issues?version=" + encodeURIComponent(version));
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
    P.tickets = body.issues;
    renderTickets(); changed();
    const pts = body.issues.reduce((n, i) => n + i.points, 0);
    say("jira-msg", `Loaded ${body.issues.length} tickets and ${pts} points from fix version ${version}. This replaced the tickets above.`, "ok");
  } catch (e) {
    say("jira-msg", e.message, "bad");
  }
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-act]");
  if (!a) return;
  const act = a.dataset.act, i = Number(a.dataset.i);
  if (act === "add-ticket") {
    P.tickets.push(blankTicket()); renderTickets(); changed();
    const rows = document.querySelectorAll("#tickets-body tr"); rows[rows.length - 1]?.querySelector("input")?.focus();
  } else if (act === "del-ticket") { P.tickets.splice(i, 1); renderTickets(); changed(); }
  else if (act === "add-handoff") {
    (P.handoffs ||= []).push({ what: "", from: "Design", to: "Frontend", owner: "", due: P.when.freezeAt || "", status: "Not started", blocks: "" });
    renderHandoffs(); changed();
    const rows = document.querySelectorAll("#handoffs-body tr"); rows[rows.length - 1]?.querySelector("input")?.focus();
  }
  else if (act === "del-handoff") { P.handoffs.splice(i, 1); renderHandoffs(); changed(); }
  else if (act === "add-step") { P.runbook.push({ id: "s" + Date.now(), phase: "Deploy", step: "", owner: P.people.releaseManager, at: P.when.deployAt, status: "todo" }); renderRunbook(); changed(); }
  else if (act === "del-step") { P.runbook.splice(i, 1); renderRunbook(); changed(); }
  else if (act === "regen-runbook") { P.runbook = generateRunbook(P); renderRunbook(); changed(); say("rb-msg", "Runbook regenerated from the plan.", "ok"); }
  else if (act === "apply-template") {
    applyTemplate(P, P.release.type); renderInputs(); changed();
    const t = TEMPLATES[P.release.type];
    say("rb-msg", `Applied ${P.release.type} defaults: ${t.strategy} rollout, ${t.windowHours} hour window, ${t.rollbackMinutes} minute rollback, sign-offs from ${t.roles.join(", ")}.`, "ok");
  }
  else if (act === "add-person" || act === "add-signoff") {
    const kind = act === "add-person" ? "person" : "signoff";
    addOpen = addOpen === kind ? null : kind;
    renderExtraPeople(); renderSignoffs();
    $(`#${kind}-add input`)?.focus();
  }
  else if (act === "cancel-add") { addOpen = null; renderExtraPeople(); renderSignoffs(); }
  else if (act === "del-person") { P.extraPeople.splice(i, 1); renderExtraPeople(); renderPeopleList(); changed(); }
  else if (act === "del-signoff") { P.signoffs.splice(i, 1); renderSignoffs(); changed(); }
  else if (act === "clear") {
    const what = a.dataset.what, n = P[what].length;
    lastCleared[what] = P[what]; P[what] = [];
    if (what === "tickets") renderTickets(); else renderRunbook();
    changed();
    sayUndo(what === "tickets" ? "jira-msg" : "rb-msg", `Cleared ${n} ${what === "tickets" ? "tickets" : "steps"}.`, what);
  }
  else if (act === "undo-clear") {
    const what = a.dataset.what;
    if (lastCleared[what]) {
      P[what] = lastCleared[what]; delete lastCleared[what];
      if (what === "tickets") renderTickets(); else renderRunbook();
      changed();
      say(what === "tickets" ? "jira-msg" : "rb-msg", "Restored.", "ok");
    }
  }
  else if (act === "pull-jira") pullJira();
  else if (act === "refresh-jira") refreshJira();
  else if (act === "waive") { openWaive = a.dataset.id; waiveError = ""; renderResults(); }
  else if (act === "close-waive") { openWaive = null; waiveError = ""; renderResults(); }
  else if (act === "unwaive") { delete P.waivers[a.dataset.id]; changed(); }
  else if (act === "copy-brief") {
    const text = last.brief;
    try { await navigator.clipboard.writeText(text); say("brief-msg", "Copied.", "ok"); }
    catch { const r = document.createRange(); r.selectNodeContents($("#brief")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); say("brief-msg", "Press Ctrl+C or Cmd+C to copy.", ""); }
  }
  else if (act === "copy-doc") {
    const html = reportHtml(last.model);
    try { await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([last.brief], { type: "text/plain" }) })]); say("brief-msg", "Copied. Paste into your doc.", "ok"); }
    catch { say("brief-msg", "Copy was blocked here. Use Copy Markdown instead.", "bad"); }
  }
  else if (act === "download-word") download(`${slug()}-release-doc.doc`, reportWord(last.model), "application/msword");
  else if (act === "download-doc") download(`${slug()}-release-doc.html`, reportDocument(last.model), "text/html");
  else if (act === "download-status") download(`${slug()}-status.html`, reportDocument(statusModel(last.model)), "text/html");
  else if (act === "download-brief") download(`${slug()}-brief.md`, last.brief, "text/markdown");
  else if (act === "copy-json") {
    try { await navigator.clipboard.writeText(JSON.stringify(P, null, 2)); say("brief-msg", "Plan JSON copied.", "ok"); } catch { say("brief-msg", "Copy was blocked here.", "bad"); }
  }
  else if (act === "export") download(`${slug()}-plan.json`, JSON.stringify(P, null, 2), "application/json");
  else if (act === "import") $("#import-file").click();
  else if (act === "rel-new") {
    addRelease(blankPlan(Date.now(), P.release.type));
    sayRel("New release. Name it and set the dates, then add tickets or pull them from Jira.", false, "ok");
    $("#f-release-name")?.focus();
  }
  else if (act === "rel-next") {
    const from = P.release.name || "Untitled release";
    addRelease(nextPlan(P, Date.now()));
    sayRel(`Started the next release from “${from}”. People, environments and rollout settings carried over. Tickets, signals, checks and approvals are cleared.`, false, "ok");
    $("#f-release-name")?.focus();
  }
  else if (act === "rel-dup") {
    const c = JSON.parse(JSON.stringify(P));
    c.release.name = `Copy of ${P.release.name || "Untitled release"}`;
    addRelease(c);
    sayRel("Duplicated. Changes here do not affect the original.", false, "ok");
  }
  else if (act === "rel-example") { addRelease(defaultPlan()); sayRel("Loaded the example release as a new entry.", false, "ok"); }
  else if (act === "conflict-load" || act === "conflict-copy") {
    const id = lib.current;
    try {
      const res = await fetch("/api/releases/" + id, { headers: RH });
      if (res.status === 401) { toLogin(); return; }
      const mine = JSON.parse(JSON.stringify(P));
      if (res.ok) { adopt(await res.json()); P = lib.items[id]; }
      else { // it was deleted: keep mine as a new release
        delete remote.versions[id]; delete remote.pushed[id];
      }
      remote.conflict = null;
      if (act === "conflict-copy" || !res.ok) {
        mine.release.name = `${mine.release.name || "Untitled release"} (my edits)`;
        addRelease(mine);
        sayRel("Your edits are saved as a separate release.", false, "ok");
      } else {
        showRelease();
        sayRel("Loaded the latest version.", false, "ok");
      }
    } catch (err) { sayRel("Could not load it: " + err.message, false, "bad"); }
  }
  else if (act === "rel-delete") deleteRelease();
  else if (act === "rel-undo") {
    if (lastDeleted) {
      const { plan, idx } = lastDeleted; lastDeleted = null;
      lib.items[lib.current] = P;
      lib.items[plan.id] = plan;
      lib.order.splice(Math.min(idx, lib.order.length), 0, plan.id);
      openRelease(plan.id);
      sayRel(`Restored “${plan.release.name || "Untitled release"}”.`, false, "ok");
    }
  }
});

document.addEventListener("submit", (e) => {
  const f = e.target.closest("[data-form='waive']");
  if (!f) return;
  e.preventDefault();
  const v = Object.fromEntries(new FormData(f));
  const approver = String(v.approver || "").trim(), reason = String(v.reason || "").trim();
  if (!approver) { waiveError = "Name the person who approves this waiver."; renderResults(); return; }
  if (reason.length < 8) { waiveError = "Give a reason of at least a few words."; renderResults(); return; }
  const crit = last.result.criteria.find((c) => c.id === f.dataset.id);
  P.waivers[f.dataset.id] = { approver, reason, at: new Date().toISOString(), statusAtWaive: crit.status };
  openWaive = null; waiveError = "";
  changed();
});

document.addEventListener("submit", (e) => {
  const f = e.target.closest("[data-form^='add-']");
  if (!f) return;
  e.preventDefault();
  const v = Object.fromEntries(new FormData(f));
  const label = String(v.label || "").trim(), name = String(v.name || "").trim();
  const err = f.querySelector(".err");
  if (!label) { err.textContent = f.dataset.form === "add-person" ? "Give the field a name, like Legal reviewer." : "Give the role a name, like Legal."; err.hidden = false; f.querySelector("input[name=label]").focus(); return; }
  if (f.dataset.form === "add-person") {
    (P.extraPeople ||= []).push({ label, name });
    addOpen = null; renderExtraPeople(); renderPeopleList();
  } else {
    P.signoffs.push({ role: label, who: name, approved: v.approved === "true" });
    addOpen = null; renderSignoffs();
  }
  changed();
});

$("#rel-select").addEventListener("change", (e) => openRelease(e.target.value));

$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const p = JSON.parse(await file.text());
    if (!p || !Array.isArray(p.tickets) || !p.release) throw new Error("That file is not a release plan.");
    addRelease(fillDefaults(FILL(), p));
    sayRel(`Imported “${P.release.name || "Untitled release"}” as a new release.`, false, "ok");
  } catch (err) {
    $("#results").insertAdjacentHTML("afterbegin", `<div class="banner bad" role="alert"><strong>Could not import.</strong><span>${esc(err.message)}</span></div>`);
  }
});

/* ---------- start ---------- */

(async function init() {
  let offline = false;
  if (!STANDALONE) {
    try {
      const res = await fetch("/api/releases");
      if (res.status === 401) { toLogin(); return; }
      if (res.ok) startRemote(await res.json());
      else offline = true;
    } catch { offline = true; }
  }
  renderInputs();
  renderResults();
  saveLib();
  if (READONLY) {
    document.body.classList.add("ro");
    for (const el of [$("#inputs"), $(".relbar .toolbar")]) if (el) el.inert = true;
    setSaveState("View only");
  }
  if (STANDALONE) return; // no server behind a single-file copy
  if (offline) sayRel("Could not reach the server, so changes are saved only in this browser.", false, "bad");
  else if (remote) {
    if (readOnly()) { const i = $("#inputs"); if (i) i.inert = true; }
    setInterval(pollServer, 20000);
    setInterval(showSync, 30000); showSync();
    document.addEventListener("visibilitychange", () => { if (!document.hidden) pollServer(); });
  }
  try {
    const res = await fetch("/api/config");
    if (res.ok) { const cfg = await res.json(); integrations = { jira: Boolean(cfg.integrations?.jira), server: true }; updateJiraButton(); }
  } catch { /* no server, planner still works on its own */ }
})();
