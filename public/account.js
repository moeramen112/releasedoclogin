const $ = (s) => document.querySelector(s);
const H = { "Content-Type": "application/json", "X-Requested-With": "release-readiness" };
fetch("/api/auth/me").then((r) => r.json()).then((m) => { $("#who").textContent = `${m.name || m.email} · ${m.role}`; }).catch(() => {});
$("#pw").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#err").hidden = true; $("#ok").hidden = true;
  if ($("#next").value !== $("#again").value) { $("#err").textContent = "The two new passwords do not match."; $("#err").hidden = false; return; }
  const res = await fetch("/api/auth/password", { method: "POST", headers: H, body: JSON.stringify({ current: $("#current").value, next: $("#next").value }) });
  const d = await res.json().catch(() => ({}));
  if (res.ok) { $("#ok").textContent = "Password changed. You were signed out everywhere else."; $("#ok").hidden = false; e.target.reset(); }
  else { $("#err").textContent = d.error || "Could not change the password."; $("#err").hidden = false; }
});
