const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const H = { "Content-Type": "application/json", "X-Requested-With": "release-readiness" };
let me = null;

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: H, body: JSON.stringify(body) });
  const d = await res.json().catch(() => ({}));
  if (res.status === 401) { location.replace("/login.html?next=/admin.html"); throw new Error("Sign in required."); }
  if (!res.ok) throw new Error(d.error || `Request failed (${res.status}).`);
  return d;
}
const fail = (e) => { $("#err").textContent = e.message; $("#err").hidden = false; };
const clearErr = () => { $("#err").hidden = true; };

function showLink(d, who) {
  $("#link").value = d.inviteUrl;
  $("#link-title").textContent = `Send this link to ${who}.`;
  $("#link-box").hidden = false;
  $("#link").select();
}

function render(users) {
  const rows = users.map((u) => {
    const self = me && u.email === me.email;
    const status = !u.active ? "Turned off" : u.joined ? "Active" : u.invitePending ? "Invited" : "Invite expired";
    const roleSel = `<select data-act="role" data-email="${esc(u.email)}" aria-label="Role for ${esc(u.email)}"${self ? " disabled" : ""}>${["viewer", "editor", "admin"].map((r) => `<option value="${r}"${u.role === r ? " selected" : ""}>${r[0].toUpperCase() + r.slice(1)}</option>`).join("")}</select>`;
    const actions = self ? `<span class="msg">You</span>` : `${!u.joined ? `<button class="btn small" type="button" data-act="reinvite" data-email="${esc(u.email)}">New invite link</button> ` : ""}<button class="btn small" type="button" data-act="${u.active ? "off" : "on"}" data-email="${esc(u.email)}">${u.active ? "Turn off" : "Turn on"}</button>`;
    return `<tr><td>${esc(u.name || "—")}</td><td class="mono">${esc(u.email)}</td><td>${roleSel}</td><td>${status}</td><td>${actions}</td></tr>`;
  }).join("");
  $("#users").innerHTML = `<thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody>`;
}

$("#invite").addEventListener("submit", async (e) => {
  e.preventDefault(); clearErr();
  try {
    const d = await api("/api/admin/users", { email: $("#i-email").value, name: $("#i-name").value, role: $("#i-role").value });
    showLink(d, d.email); render(d.users); e.target.reset(); $("#i-role").value = "editor";
  } catch (err) { fail(err); }
});

$("#copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("#link").value); $("#copy").textContent = "Copied"; }
  catch { $("#link").select(); $("#copy").textContent = "Press Ctrl+C to copy"; }
});

document.addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  clearErr();
  try {
    if (b.dataset.act === "reinvite") { const d = await api("/api/admin/users/reinvite", { email: b.dataset.email }); showLink(d, d.email); render(d.users); }
    else if (b.dataset.act === "off") { render((await api("/api/admin/users/update", { email: b.dataset.email, active: false })).users); }
    else if (b.dataset.act === "on") { render((await api("/api/admin/users/update", { email: b.dataset.email, active: true })).users); }
  } catch (err) { fail(err); }
});
document.addEventListener("change", async (e) => {
  const s = e.target.closest("select[data-act=role]");
  if (!s) return;
  clearErr();
  try { render((await api("/api/admin/users/update", { email: s.dataset.email, role: s.value })).users); }
  catch (err) { fail(err); load(); }
});

async function load() {
  try {
    me = await api("/api/auth/me");
    render((await api("/api/admin/users")).users);
  } catch (err) { fail(err); }
}
load();

