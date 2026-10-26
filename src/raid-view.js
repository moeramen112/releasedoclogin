// HTML for the RAID page. Pure: give it rows from raid.js buildRaidView(), get a string back.
// Class names used here live in public/styles.css under "RAID page".

import { esc } from "./html.js";
import { summarizeRaid } from "./raid.js";

const RATING = { High: "s-fail", Medium: "s-warn", Low: "s-pending" };
const TYPE_TEXT = { Risk: ["risk", "risks"], Assumption: ["assumption", "assumptions"], Issue: ["issue", "issues"], Dependency: ["dependency", "dependencies"] };
const dueText = (r) => (r.dueMs === null || r.dueMs === undefined ? "" : new Date(r.dueMs).toLocaleDateString("en-US", { month: "short", day: "numeric" }));

/** The counts line: open by type, high, overdue, and items nobody owns. */
export function renderRaidSummary(rows) {
  const s = summarizeRaid(rows);
  const types = Object.keys(TYPE_TEXT).map((t) => `<span class="chip s-pending"><i></i>${s.byType[t]} ${TYPE_TEXT[t][s.byType[t] === 1 ? 0 : 1]}</span>`).join(" ");
  return `<div class="row-actions">${types}${s.high ? ` <span class="chip s-fail"><i></i>${s.high} high</span>` : ""}${s.overdue ? ` <span class="chip s-fail"><i></i>${s.overdue} overdue</span>` : ""}${s.noOwner ? ` <span class="chip s-warn"><i></i>${s.noOwner} without an owner</span>` : ""}</div>`;
}

/**
 * The table. `href(releaseId)` says where the release link goes. Rows already come sorted (overdue first).
 */
export function renderRaidTable(rows, { href = (id) => `/plan.html?release=${encodeURIComponent(id)}` } = {}) {
  if (!rows.length) return `<div class="msg">Nothing matches. Add items under RAID log in the planner, or clear the filters.</div>`;
  const body = rows.map((r) => `<tr${r.status === "Closed" || r.status === "Confirmed" || r.status === "Wrong" ? ' class="done"' : ""}>
    <td><a href="${esc(href(r.releaseId))}">${esc(r.releaseName)}</a></td>
    <td><span class="chip ${RATING[r.rating] || "s-pending"}">${esc(r.type)}</span></td>
    <td>${esc(r.title)}${r.response ? `<div class="msg">${esc(r.response)}</div>` : ""}</td>
    <td>${r.owner ? esc(r.owner) : `<span class="msg">no owner</span>`}</td>
    <td>${esc(dueText(r))}${r.overdue ? ` <span class="msg" style="color:var(--bad)">overdue</span>` : ""}</td>
    <td>${esc(r.rating)}</td>
    <td>${esc(r.status)}</td></tr>`).join("");
  return `<div class="tablewrap"><table class="tbl" style="min-width:820px"><thead><tr><th>Release</th><th>Type</th><th>What</th><th>Owner</th><th>Due</th><th>Rating</th><th>Status</th></tr></thead><tbody>${body}</tbody></table></div>`;
}
