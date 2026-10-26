// RAID page: fetch the releases, hand them to raid.js, draw with raid-view.js. No rules live here.
import { buildRaidView, filterRaid } from "/raid.js";
import { renderRaidSummary, renderRaidTable } from "/raid-view.js";
import { esc } from "/html.js";

const $ = (s) => document.querySelector(s);
let plans = [];

async function load() {
  const res = await fetch("/api/releases");
  if (res.status === 401) { location.replace("/login.html?next=/raid.html"); return; }
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || `Request failed (${res.status}).`);
  plans = d.releases.map((r) => ({ ...r.plan, id: r.id }));
}

function draw() {
  const view = buildRaidView(plans, { includeClosed: $("#f-closed").checked });
  const keep = { owner: $("#f-owner").value, release: $("#f-release").value };
  $("#f-owner").innerHTML = `<option value="">Everyone</option>` + [...view.owners, "(none)"].map((o) => `<option${o === keep.owner ? " selected" : ""}>${esc(o)}</option>`).join("");
  $("#f-release").innerHTML = `<option value="">All open releases</option>` + plans.map((p) => `<option value="${esc(p.id)}"${p.id === keep.release ? " selected" : ""}>${esc(p.release?.name || "Untitled release")}</option>`).join("");
  const rows = filterRaid(view.rows, { type: $("#f-type").value, rating: $("#f-rating").value, owner: $("#f-owner").value, releaseId: $("#f-release").value });
  $("#summary").innerHTML = renderRaidSummary(view.rows);
  $("#table").innerHTML = renderRaidTable(rows);
}

for (const id of ["f-type", "f-rating", "f-owner", "f-release", "f-closed"]) $("#" + id).addEventListener("change", draw);
load().then(draw).catch((e) => { $("#err").textContent = e.message; $("#err").hidden = false; });
