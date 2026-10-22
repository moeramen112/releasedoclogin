const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const H = { "Content-Type": "application/json", "X-Requested-With": "release-readiness" };
const KIND = { slack: "Slack draft", chase: "Chase note", suggestion: "Suggestion" };
let data = null, canEdit = false;

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: H, body: JSON.stringify(body) });
  const d = await res.json().catch(() => ({}));
  if (res.status === 401) { location.replace("/login.html?next=/inbox.html"); throw new Error("Sign in required."); }
  if (!res.ok) throw new Error(d.error || `Request failed (${res.status}).`);
  return d;
}
const fail = (e) => { $("#err").textContent = e.message; $("#err").hidden = false; };
const when = (ms) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function card(i) {
  const head = `<div class="inbox-head"><span class="chip ${i.kind === "suggestion" ? "s-waived" : i.importance === "high" ? "s-warn" : "s-pending"}">${KIND[i.kind] || i.kind}</span> <strong>${esc(i.title)}</strong></div>
    <div class="note"><a href="/plan.html?release=${encodeURIComponent(i.releaseId)}">${esc(i.releaseName)}</a> · ${esc(i.source === "auto" ? "Auto" : "Manual")} check · ${esc(when(i.createdAt))}${i.why ? ` · ${esc(i.why)}` : ""}</div>`;
  if (i.status !== "open") return `<div class="inbox-item done">${head}<div class="note">${esc(i.outcome)}${i.decidedBy ? ` by ${esc(i.decidedBy)}` : ""}, ${esc(when(i.decidedAt))}</div></div>`;
  const dis = canEdit ? "" : " disabled";
  const dismiss = `<button class="btn small" type="button" data-act="dismiss" data-id="${esc(i.id)}"${dis}>Dismiss</button>`;
  if (i.kind === "suggestion") return `<div class="inbox-item">${head}<div class="row-actions"><a class="btn small primary" href="/plan.html?release=${encodeURIComponent(i.releaseId)}">Open release to apply</a>${dismiss}</div></div>`;
  const send = i.kind === "slack" ? `<button class="btn small primary" type="button" data-act="send" data-id="${esc(i.id)}"${canEdit && data.slack ? "" : " disabled"} title="${data.slack ? "Posts this text to your Slack channel" : "Slack is not set up on this server"}">Post to Slack</button>` : "";
  return `<div class="inbox-item">${head}<textarea data-text="${esc(i.id)}" rows="${i.kind === "slack" ? 7 : 3}" aria-label="Draft text"${dis}>${esc(i.text)}</textarea>
    <div class="row-actions">${send}<button class="btn small" type="button" data-act="copy" data-id="${esc(i.id)}">Copy</button><button class="btn small" type="button" data-act="save" data-id="${esc(i.id)}"${dis}>Save edit</button><button class="btn small" type="button" data-act="done" data-id="${esc(i.id)}"${dis} title="Use this after you have sent it yourself">Mark as sent</button>${dismiss}<span class="msg" data-msg="${esc(i.id)}"></span></div></div>`;
}

function render() {
  const open = data.items.filter((i) => i.status === "open"), done = data.items.filter((i) => i.status !== "open");
  $("#open-box").innerHTML = `<div class="panel-head"><h2>Needs your OK${open.length ? ` (${open.length})` : ""}</h2><span class="note">${data.mode === "live" ? "Written with Claude. Check before sending." : "Demo mode: simple rules, no AI key set."}</span></div>` +
    (open.length ? open.map(card).join("") : `<p class="note">Nothing waiting. Open a release in the planner and press <strong>Check this release</strong>, or switch Auto on.</p>`);
  const box = $("#done-box");
  box.hidden = !done.length;
  box.innerHTML = done.length ? `<div class="panel-head"><h2>Recently handled</h2></div>${done.map(card).join("")}` : "";
  document.querySelectorAll("[data-inbox]").forEach((a) => { a.textContent = data.openCount ? `Inbox (${data.openCount})` : "Inbox"; });
}

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const id = b.dataset.id, act = b.dataset.act, ta = document.querySelector(`[data-text="${id}"]`), msg = document.querySelector(`[data-msg="${id}"]`);
  try {
    if (act === "copy") { await navigator.clipboard.writeText(ta.value); if (msg) msg.textContent = "Copied."; return; }
    if (act === "save") { data = await api("/api/agent/item", { id, action: "edit", text: ta.value }); if (msg) msg.textContent = "Saved."; render(); return; }
    b.disabled = true;
    data = await api("/api/agent/item", { id, action: act === "send" ? "send" : act, text: ta?.value });
    $("#err").hidden = true;
    render();
  } catch (err) { b.disabled = false; fail(err); }
});

(async () => {
  try {
    data = await api("/api/agent");
    const me = await (await fetch("/api/auth/me")).json().catch(() => ({}));
    canEdit = me.authEnabled === false || ["admin", "editor"].includes(me.role);
    render();
  } catch (e) { fail(e); }
})();
