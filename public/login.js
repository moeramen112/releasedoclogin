// Sign-in and invite pages. Plain JS, no build step.
const $ = (s) => document.querySelector(s);
const H = { "Content-Type": "application/json", "X-Requested-With": "release-readiness" };

async function post(path, body) {
  try {
    const res = await fetch(path, { method: "POST", headers: H, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "Could not reach the server." } };
  }
}
function showError(text) { const e = $("#err"); e.textContent = text; e.hidden = !text; }
function safeNext() {
  const n = new URLSearchParams(location.search).get("next") || "/";
  return n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/\\") ? n : "/";
}

const login = $("#login"), accept = $("#accept");

if (login) {
  fetch("/api/auth/status").then((r) => r.json()).then((s) => {
    if (s.authEnabled === false) location.replace("/");
    if (!s.hasUsers) {
      const n = $("#notice");
      n.innerHTML = "<strong>No accounts yet.</strong><span>The person running the server needs to set ADMIN_EMAIL and restart it. The first admin link is then printed in the server log.</span>";
      n.hidden = false;
    }
  }).catch(() => {});
  login.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("");
    $("#go").disabled = true;
    const r = await post("/api/auth/login", { email: $("#email").value, password: $("#password").value });
    if (r.ok) location.assign(safeNext());
    else { showError(r.data.error || "Could not sign in."); $("#go").disabled = false; $("#password").value = ""; $("#password").focus(); }
  });
}

if (accept) {
  const q = new URLSearchParams(location.search);
  const email = q.get("email") || "", token = q.get("token") || "";
  $("#email").value = email;
  if (!email || !token) { showError("This invite link is incomplete. Ask an admin for a new one."); $("#go").disabled = true; }
  accept.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("");
    if ($("#password").value !== $("#again").value) { showError("The two passwords do not match."); return; }
    $("#go").disabled = true;
    const r = await post("/api/auth/accept", { email, token, name: $("#name").value, password: $("#password").value });
    if (r.ok) location.assign("/");
    else { showError(r.data.error || "Could not create the account."); $("#go").disabled = false; }
  });
}
