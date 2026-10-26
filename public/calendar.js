// Calendar page: fetch the releases, hand them to schedule.js, draw with schedule-view.js. No rules live here.
import { buildSchedule, suggestSlots } from "/schedule.js";
import { renderTimeline, renderConflicts, viewRange } from "/schedule-view.js";
import { esc } from "/html.js";
import { evaluate } from "/engine.js";
import { computeRisk } from "/risk.js";
import { planToSnapshot, planConfig, planState } from "/plan.js";

const $ = (s) => document.querySelector(s);
const H = { "Content-Type": "application/json", "X-Requested-With": "release-readiness" };
let plans = [], canEdit = false;

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: H, body: JSON.stringify(body) });
  const d = await res.json().catch(() => ({}));
  if (res.status === 401) { location.replace("/login.html?next=/calendar.html"); throw new Error("Sign in required."); }
  if (!res.ok) throw new Error(d.error || `Request failed (${res.status}).`);
  return d;
}
const fail = (e) => { $("#err").textContent = e.message; $("#err").hidden = false; };

/** The call and risk next to each name. Same functions the planner uses, so the numbers match. */
function extrasFor(list, now) {
  return Object.fromEntries(list.map((p) => {
    try { return [p.id, { call: evaluate(planToSnapshot(p, now), planConfig(p), planState(p)).verdict.call, risk: computeRisk(p, now).score }]; } catch { return [p.id, {}]; }
  }));
}

function draw() {
  const now = Date.now();
  const sched = buildSchedule(plans, { now, includeClosed: $("#closed").checked });
  const open = buildSchedule(plans, { now }); // clashes only ever involve open releases
  const range = viewRange(now, { days: Number($("#range").value) });
  $("#timeline").innerHTML = renderTimeline(sched, { ...range, extras: extrasFor(plans, now) });
  $("#clash-title").textContent = open.conflicts.length ? `Clashes (${open.conflicts.length})` : "Clashes";
  $("#clashes").innerHTML = renderConflicts(open, { slotsFor: (id) => suggestSlots(plans, id, { now, count: 3 }) });
  $("#ai-check").hidden = !open.conflicts.length;
  $("#ai-check").disabled = !canEdit;
  const box = $("#unsched-box");
  box.hidden = !open.unscheduled.length;
  box.innerHTML = open.unscheduled.length ? `<div class="panel-head"><h2>No deploy date yet</h2></div><p class="note">These cannot clash with anything until they have one: ${open.unscheduled.map((u) => `<a href="/plan.html?release=${encodeURIComponent(u.id)}">${esc(u.name)}</a>`).join(", ")}.</p>` : "";
}

$("#range").addEventListener("change", draw);
$("#closed").addEventListener("change", draw);
$("#ai-check").addEventListener("click", async () => {
  const out = $("#ai-out"), btn = $("#ai-check");
  btn.disabled = true; out.textContent = "Thinking…";
  try {
    const r = await api("/api/ai/schedule", {});
    const names = new Map(plans.map((p) => [p.id, p.release?.name || "Untitled release"]));
    out.innerHTML = `<p class="note">${r.mode === "live" ? "Written with Claude. A suggestion, not a decision." : "Demo mode: simple rules, no AI key set."}</p>` +
      (r.advice.length ? r.advice.map((a) => `<div class="clash-card"><span class="chip s-waived">${a.move ? "Suggestion" : "No slot"}</span><div><span>${a.move ? `Move <strong>${esc(a.moveName || names.get(a.move))}</strong> to <strong>${esc(new Date(a.to).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</strong>. ` : ""}${esc(a.why)}${a.move ? ` <a href="/plan.html?release=${encodeURIComponent(a.move)}">Open it to change the date</a>` : ""}</span></div></div>`).join("") : `<p class="msg ok">Nothing to advise.</p>`);
  } catch (e) { out.textContent = ""; fail(e); } finally { btn.disabled = !canEdit; }
});

(async () => {
  try {
    const d = await api("/api/releases");
    plans = d.releases.map((r) => ({ ...r.plan, id: r.id }));
    canEdit = d.authEnabled === false || ["admin", "editor"].includes(d.me?.role);
    draw();
  } catch (e) { fail(e); }
})();
