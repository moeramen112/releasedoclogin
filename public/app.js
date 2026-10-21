// Dashboard client. Fetches /api/readiness and renders it. No framework, no build step.
// Secrets never reach this file: the server holds the tokens.

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage can be unavailable */ } },
};

const LABEL = { pass: "Pass", warn: "At risk", fail: "Failing", pending: "Pending", waived: "Waived" };
const S = { cfg: null, data: null, mode: "demo", filter: "All", form: null, formError: "", busy: false, loadError: "" };

const chip = (s, text) => `<span class="chip s-${s}"><i></i>${esc(text || LABEL[s])}</span>`;
const when = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const safeUrl = (u) => (/^https?:\/\//.test(u || "") ? u : null);

// When sign-in is on, the server records the signed-in person; the name boxes show that and cannot be edited.
const signedName = () => (S.cfg?.authEnabled && S.cfg.me ? S.cfg.me.name || S.cfg.me.email : null);
const whoValue = () => signedName() || store.get("rr.who") || "";
const whoAttr = () => (signedName() ? " readonly" : "");

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", "X-Requested-With": "release-readiness", ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) { location.replace("/login.html?next=" + encodeURIComponent(location.pathname)); throw new Error("Sign in required."); }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
  return body;
}

function query(extra = {}) {
  const q = new URLSearchParams({ demo: S.mode === "demo" ? "1" : "0", ...extra });
  if (S.mode === "live") {
    for (const [k, id] of [["repo", "f-repo"], ["base", "f-base"], ["head", "f-head"]]) {
      const v = $("#" + id).value.trim();
      if (v) q.set(k, v);
    }
  }
  return q.toString();
}

async function load(refresh = false) {
  S.busy = true; S.loadError = ""; renderControls();
  try {
    S.data = await api("/api/readiness?" + query(refresh ? { refresh: "1" } : {}));
  } catch (e) {
    S.loadError = e.message;
  }
  S.busy = false; S.form = null; render();
}

async function act(path, body) {
  S.busy = true; S.formError = ""; renderControls();
  try {
    S.data = await api(path + "?" + query(), { method: "POST", body: JSON.stringify(body) });
    S.form = null;
  } catch (e) {
    S.formError = e.message;
  }
  S.busy = false; render();
}

/* ---------- rendering ---------- */

function renderControls() {
  const live = S.mode === "live";
  $("#mode-live").setAttribute("aria-pressed", live);
  $("#mode-demo").setAttribute("aria-pressed", !live);
  for (const id of ["f-repo", "f-base", "f-head"]) $("#" + id).disabled = !live;
  $("#b-load").disabled = S.busy;
  $("#b-refresh").disabled = S.busy;
  $("#b-slack").disabled = S.busy || !S.cfg?.integrations.slack;
  $("#b-slack").title = S.cfg?.integrations.slack ? "" : "Set SLACK_WEBHOOK_URL on the server to enable this";
}

function render() {
  renderControls();
  const d = S.data;
  const banner = $("#banner");
  if (S.loadError) {
    banner.innerHTML = `<div class="banner bad"><strong>Could not load readiness.</strong><span>${esc(S.loadError)}</span></div>`;
  }
  if (!d) return;

  const { snapshot, result } = d;
  const rel = snapshot.release;
  $("#relname").textContent = `${rel.name} readiness`;
  $("#relsub").textContent = d.mode === "demo"
    ? `${rel.repo} · ${rel.headRef} vs ${rel.baseRef} · invented data`
    : `${rel.repo} · ${rel.headRef} vs ${rel.baseRef}`;

  const tags = [];
  tags.push(d.mode === "demo" ? `<span class="tag sample">Sample data</span>` : `<span class="tag">Fetched ${esc(when(snapshot.generatedAt))}</span>`);
  if (d.mode === "live") {
    tags.push(`<span class="tag ${snapshot.sources.github === "error" ? "err" : "on"}">GitHub ${d.integrations.github ? "token" : "anonymous"}</span>`);
    tags.push(`<span class="tag ${snapshot.sources.jira === "ok" ? "on" : snapshot.sources.jira === "error" ? "err" : ""}">Jira ${esc(snapshot.sources.jira)}</span>`);
  }
  tags.push(`<span class="tag ${d.integrations.slack ? "on" : ""}">Slack ${d.integrations.slack ? "on" : "off"}</span>`);
  if (rel.goNoGoMeeting) tags.push(`<span class="tag">Go/no-go ${esc(when(rel.goNoGoMeeting))}</span>`);
  $("#meta").innerHTML = tags.join("");

  const errs = Object.entries(snapshot.errors || {});
  if (!S.loadError) {
    banner.innerHTML = errs.length
      ? `<div class="banner"><strong>Some data could not be loaded. Affected criteria show as pending, never as passing.</strong><ul>${errs.map(([k, v]) => `<li><span class="mono">${esc(k)}</span>: ${esc(v)}</li>`).join("")}</ul></div>`
      : "";
  }

  renderVerdict(result);
  renderCriteria(result);
  renderBlockers(snapshot);
  renderSignoffs(snapshot);
  renderGates(snapshot);
  renderTrend(d.history);
  renderPrs(snapshot);
  renderAudit(d.audit);
}

function renderVerdict({ verdict, criteria }) {
  const cls = { "NO-GO": "nogo", HOLD: "hold", GO: "go" }[verdict.call];
  const total = criteria.length || 1;
  const bar = ["pass", "waived", "warn", "pending", "fail"].map((k) => `<span class="p-${k}" style="width:${(verdict.counts[k] / total) * 100}%" title="${LABEL[k]}: ${verdict.counts[k]}"></span>`).join("");
  const tally = ["pass", "warn", "pending", "fail", "waived"].filter((k) => verdict.counts[k]).map((k) => `<span class="chip s-${k}"><i></i>${verdict.counts[k]} ${LABEL[k].toLowerCase()}</span>`).join("");
  const holding = criteria.filter((c) => verdict.holding.includes(c.id));
  const list = holding.length
    ? `<div class="holding"><h3>What is holding the release</h3><ul>${holding.map((c) => `<li>${chip(c.effective)}<span><strong>${esc(c.name)}</strong> <span class="mono">${esc(c.detail)}</span></span></li>`).join("")}</ul></div>`
    : `<div class="holding"><h3>Nothing is holding the release</h3></div>`;
  $("#verdict").innerHTML =
    `<div class="v-badge ${cls}"><span class="label">Current call</span><span class="word">${esc(verdict.call)}</span><span>${esc(verdict.reason)}</span></div>` +
    `<div class="v-body"><div class="tally">${tally}</div><div class="progress" role="img" aria-label="Criteria status mix">${bar}</div>${list}</div>`;
}

function formHtml(c) {
  const f = S.form;
  if (!f || f.id !== c.id) return "";
  const err = S.formError ? `<div class="err" role="alert">${esc(S.formError)}</div>` : "";
  if (f.kind === "waive") {
    return `<form class="form" data-form="waive" data-id="${esc(c.id)}">
      <label>Approved by<input name="approver" required maxlength="80"${whoAttr()} value="${esc(whoValue())}" placeholder="Name of the person accepting the risk"></label>
      <label>Reason<textarea name="reason" required maxlength="400" placeholder="Why this is acceptable, and what follows (a hotfix, a monitor)"></textarea></label>
      ${err}<div class="row"><button class="btn small primary" type="submit">Record waiver</button><button class="btn small" type="button" data-act="close">Cancel</button></div></form>`;
  }
  return `<form class="form" data-form="manual" data-check="${esc(c.checkId)}" data-state="${esc(f.state)}">
    <label>${f.state === "pass" ? "Confirmed by" : "Marked failing by"}<input name="by" required maxlength="80"${whoAttr()} value="${esc(whoValue())}"></label>
    <label>Note<input name="note" maxlength="300" placeholder="What you saw, with a link if you have one"></label>
    ${err}<div class="row"><button class="btn small primary" type="submit">Save</button><button class="btn small" type="button" data-act="close">Cancel</button></div></form>`;
}

function renderCriteria({ criteria }) {
  $("#criteria").innerHTML = criteria.map((c) => {
    const w = c.waiver;
    const wnote = w && c.effective === "waived"
      ? `<div class="waiver-note">Waived by ${esc(w.approver)} on ${esc(when(w.at))}: ${esc(w.reason)}</div>`
      : w && w.stale ? `<div class="waiver-note stale">A waiver from ${esc(w.approver)} no longer applies because this got worse since ${esc(when(w.at))}.</div>` : "";
    const btns = [];
    if (c.type === "manual") {
      btns.push(`<button class="btn small" type="button" data-act="manual" data-id="${esc(c.id)}" data-state="pass">Confirm</button>`);
      btns.push(`<button class="btn small" type="button" data-act="manual" data-id="${esc(c.id)}" data-state="fail">Mark failing</button>`);
      if (c.status !== "pending") btns.push(`<button class="btn small" type="button" data-act="clear" data-check="${esc(c.checkId)}">Clear</button>`);
    }
    if (c.status !== "pass" && !(w && w.valid && !w.stale)) btns.push(`<button class="btn small" type="button" data-act="waive" data-id="${esc(c.id)}">Waive</button>`);
    if (w) btns.push(`<button class="btn small" type="button" data-act="unwaive" data-id="${esc(c.id)}">Remove waiver</button>`);
    return `<div class="crit"><div class="row1"><span class="name">${esc(c.name)}</span>${chip(c.effective)}</div>
      <div class="detail">${esc(c.detail)}</div>${wnote}
      <div class="foot"><span class="src">${c.required ? "REQUIRED" : "ADVISORY"} · ${esc(c.source.toUpperCase())}</span>${btns.length ? `<div class="btns">${btns.join("")}</div>` : ""}${formHtml(c)}</div></div>`;
  }).join("");
}

function renderBlockers(snapshot) {
  const list = snapshot.data.blockers;
  if (!list) { $("#filters").innerHTML = ""; $("#blockers").innerHTML = `<tbody><tr><td class="empty">Blockers could not be loaded.</td></tr></tbody>`; return; }
  $("#filters").innerHTML = ["All", "P0", "P1", "P2"].map((s) => {
    const n = s === "All" ? list.length : list.filter((b) => b.sev === s).length;
    return `<button type="button" data-filter="${s}" aria-pressed="${S.filter === s}">${s} ${n}</button>`;
  }).join("");
  const rows = list.filter((b) => S.filter === "All" || b.sev === S.filter);
  $("#blockers").innerHTML = rows.length
    ? `<thead><tr><th>Sev</th><th>Issue</th><th>Owner</th><th class="num">Age</th></tr></thead><tbody>${rows.map((b) => {
      const link = safeUrl(b.url);
      const key = link ? `<a class="id" href="${esc(link)}" target="_blank" rel="noopener">${esc(b.key)} · ${esc(b.source)}</a>` : `<span class="id">${esc(b.key)} · ${esc(b.source)}</span>`;
      return `<tr><td><span class="sev sev-${esc(b.sev)}">${esc(b.sev)}</span></td><td class="t">${key}${esc(b.title)}<span class="id">${esc(b.status)}</span></td><td>${esc(b.owner)}</td><td class="num">${b.ageDays}d</td></tr>`;
    }).join("")}</tbody>`
    : `<tbody><tr><td class="empty">No open blockers at this severity.</td></tr></tbody>`;
}

function renderSignoffs(snapshot) {
  const s = snapshot.data.signoffs;
  $("#signoffs").innerHTML = s
    ? s.map((r) => `<div class="appr-row"><strong>${esc(r.role)}</strong>${r.approved ? chip("pass", "Approved") : chip("pending", "Pending")}</div>`).join("")
    : `<div class="empty">No sign-off tracking issue is configured. Set <span class="mono">signoffs.issue</span> in readiness.config.json to read sign-off labels from a GitHub issue.</div>`;
}

function renderGates(snapshot) {
  const { ci, compare } = snapshot.data;
  let html = "";
  if (ci) {
    const failed = ci.failed.length, pending = ci.pending.length;
    const t = ci.total || 1;
    html += `<div class="stage"><span><strong>Checks</strong></span><div class="bar" role="img" aria-label="${ci.passed} of ${ci.total} checks passing"><span class="p-pass" style="width:${(ci.passed / t) * 100}%"></span><span class="p-pending" style="width:${(pending / t) * 100}%"></span><span class="p-fail" style="width:${(failed / t) * 100}%"></span></div><span class="val">${ci.passed} / ${ci.total}</span></div>`;
    if (failed) html += `<div class="failnames">${ci.failed.slice(0, 8).map((n) => `<span class="chip s-fail">${esc(n)}</span>`).join("")}${failed > 8 ? `<span class="note">+${failed - 8} more</span>` : ""}</div>`;
    if (pending) html += `<div class="failnames">${ci.pending.slice(0, 8).map((n) => `<span class="chip s-pending">${esc(n)}</span>`).join("")}</div>`;
  } else html += `<div class="empty">CI status could not be loaded.</div>`;
  if (compare) {
    html += `<div class="stats"><div class="stat"><b>${compare.commits}</b><span>Commits</span></div><div class="stat"><b>${compare.filesChanged}${compare.truncated ? "+" : ""}</b><span>Files</span></div><div class="stat"><b>${(compare.additions + compare.deletions).toLocaleString()}</b><span>Lines changed</span></div><div class="stat"><b>${compare.authors}</b><span>Authors</span></div></div>`;
  }
  $("#gates").innerHTML = html;
}

function renderTrend(history) {
  const el = $("#trend");
  const pts = history.filter((h) => h.open !== null);
  if (pts.length < 2) {
    $("#trnote").textContent = "";
    el.innerHTML = `<div class="empty">This chart fills in as the dashboard is refreshed. Each change in the blocker count or the call is recorded here. ${pts.length} point so far.</div>`;
    return;
  }
  const W = 520, H = 220, L = 34, R = 16, T = 16, B = 30;
  const t0 = Date.parse(pts[0].t), t1 = Date.parse(pts.at(-1).t);
  const maxY = Math.max(4, Math.ceil(Math.max(...pts.map((p) => p.open)) / 4) * 4);
  const x = (t) => L + ((Date.parse(t) - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - v / maxY) * (H - T - B);
  const color = { "NO-GO": "var(--bad)", HOLD: "var(--warn)", GO: "var(--good)" };
  let g = "";
  for (let v = 0; v <= maxY; v += maxY / 4) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  const line = pts.map((p) => `${x(p.t)},${y(p.open)}`).join(" ");
  const area = `M${x(pts[0].t)},${y(0)} L${line.split(" ").join(" L")} L${x(pts.at(-1).t)},${y(0)} Z`;
  const last = pts.at(-1);
  $("#trnote").textContent = `${pts.length} points`;
  el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Open blockers over time, ${last.open} now">${g}
    <path d="${area}" fill="var(--accent)" fill-opacity="0.14"/><polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2"/>
    ${pts.map((p) => `<circle cx="${x(p.t)}" cy="${y(p.open)}" r="${p === last ? 5 : 3}" fill="${color[p.call]}" stroke="var(--surface)" stroke-width="1.5"><title>${esc(when(p.t))}: ${p.open} open, ${esc(p.call)}</title></circle>`).join("")}
    <text x="${L}" y="${H - 8}">${esc(when(pts[0].t))}</text><text x="${W - R}" y="${H - 8}" text-anchor="end">${esc(when(last.t))}</text></svg>
    <div class="note">Dot colour is the call at that moment: red no-go, amber hold, green go.</div>`;
}

function renderPrs(snapshot) {
  const prs = snapshot.data.openPrs;
  $("#prnote").textContent = prs ? `${prs.length} open` : "";
  if (!prs) { $("#prs").innerHTML = `<tbody><tr><td class="empty">Pull requests could not be loaded.</td></tr></tbody>`; return; }
  if (!prs.length) { $("#prs").innerHTML = `<tbody><tr><td class="empty">Every scoped PR is merged.</td></tr></tbody>`; return; }
  const checkChip = (c) => chip(c === "passing" ? "pass" : c === "failing" ? "fail" : "pending", c);
  $("#prs").innerHTML = `<thead><tr><th>PR</th><th>Author</th><th>Checks</th><th>Review</th><th class="num">Open</th></tr></thead><tbody>${prs.map((p) => {
    const link = safeUrl(p.url);
    const id = link ? `<a class="id" href="${esc(link)}" target="_blank" rel="noopener">#${p.number}</a>` : `<span class="id">#${p.number}</span>`;
    return `<tr><td class="t">${id}${esc(p.title)}</td><td>${esc(p.author)}</td><td>${checkChip(p.checks)}</td><td>${esc(String(p.review).replace(/_/g, " "))}</td><td class="num">${p.ageDays}d</td></tr>`;
  }).join("")}</tbody>`;
}

function renderAudit(audit) {
  $("#audit").innerHTML = audit.length
    ? `<thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead><tbody>${audit.map((a) => `<tr><td class="num">${esc(when(a.at))}</td><td>${esc(a.by)}</td><td class="mono">${esc(a.action)}</td><td>${esc(a.detail)}</td></tr>`).join("")}</tbody>`
    : `<tbody><tr><td class="empty">No waivers, confirmations or notifications yet.</td></tr></tbody>`;
}

/* ---------- events ---------- */

document.addEventListener("click", (e) => {
  const f = e.target.closest("[data-filter]");
  if (f) { S.filter = f.dataset.filter; renderBlockers(S.data.snapshot); return; }
  const m = e.target.closest("[data-mode]");
  if (m) { S.mode = m.dataset.mode; store.set("rr.mode", S.mode); load(); return; }
  const a = e.target.closest("[data-act]");
  if (!a) return;
  const { act: what, id, state, check } = a.dataset;
  S.formError = "";
  if (what === "close") { S.form = null; renderCriteria(S.data.result); }
  else if (what === "waive") { S.form = { kind: "waive", id }; renderCriteria(S.data.result); }
  else if (what === "manual") { S.form = { kind: "manual", id, state }; renderCriteria(S.data.result); }
  else if (what === "unwaive") {
    const by = $("#f-who").value.trim();
    if (!by) { S.formError = ""; $("#f-who").focus(); $("#banner").innerHTML = `<div class="banner">Enter your name at the top first. The audit log records who removed the waiver.</div>`; return; }
    act("/api/unwaive", { id, by });
  } else if (what === "clear") {
    const by = $("#f-who").value.trim() || "unknown";
    act("/api/manual", { checkId: check, state: "unset", by });
  }
});

document.addEventListener("submit", (e) => {
  const form = e.target.closest("[data-form]");
  if (!form) return;
  e.preventDefault();
  const v = Object.fromEntries(new FormData(form));
  if (form.dataset.form === "waive") {
    if (!signedName()) { store.set("rr.who", v.approver); $("#f-who").value = v.approver; }
    act("/api/waive", { id: form.dataset.id, approver: v.approver, reason: v.reason });
  } else {
    if (!signedName()) { store.set("rr.who", v.by); $("#f-who").value = v.by; }
    act("/api/manual", { checkId: form.dataset.check, state: form.dataset.state, by: v.by, note: v.note });
  }
});

$("#controls").addEventListener("submit", (e) => { e.preventDefault(); load(true); });
$("#b-refresh").addEventListener("click", () => load(true));
$("#b-slack").addEventListener("click", async () => {
  const by = $("#f-who").value.trim();
  if (!by) { $("#f-who").focus(); $("#banner").innerHTML = `<div class="banner">Enter your name first. The audit log records who posted the summary.</div>`; return; }
  await act("/api/notify", { by });
  if (!S.formError) $("#banner").innerHTML = `<div class="banner" style="--warn:var(--good);--warn-bg:var(--good-bg)">Posted the ${esc(S.data.result.verdict.call)} summary to Slack.</div>`;
  else $("#banner").innerHTML = `<div class="banner bad">${esc(S.formError)}</div>`;
});
$("#f-who").addEventListener("change", (e) => { if (!signedName()) store.set("rr.who", e.target.value.trim()); });

/* ---------- start ---------- */

(async function init() {
  try { S.cfg = await api("/api/config"); } catch (e) { S.loadError = e.message; }
  S.mode = store.get("rr.mode") || S.cfg?.defaultMode || "demo";
  if (S.cfg) {
    $("#f-repo").value = S.cfg.release.repo;
    $("#f-base").value = S.cfg.release.baseRef;
    $("#f-head").value = S.cfg.release.headRef;
  }
  $("#f-who").value = whoValue();
  if (signedName()) { $("#f-who").readOnly = true; $("#f-who").title = "You are signed in, so this is recorded for you."; }
  load();
})();
