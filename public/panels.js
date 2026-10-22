// The result panels on the right-hand side. Each takes the computed results and returns HTML.
// renderCriteria and renderBrief also take the bits of page state they show.
import { esc, LABEL, chip } from "/uikit.js";

export const ratioColor = (r) => (r >= 0.66 ? "var(--bad)" : r >= 0.33 ? "var(--warn)" : "var(--good)");
export const FC_CHIP = { complete: "pass", "on-track": "pass", tight: "warn", behind: "fail", "after-freeze": "fail", unknown: "pending" };
export const FC_TEXT = { complete: "Complete", "on-track": "On track", tight: "Tight", behind: "Behind", "after-freeze": "Open after freeze", unknown: "No velocity" };

export function renderVerdict({ result }) {
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

export function renderRisk({ risk }) {
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

export function renderPoints({ risk }) {
  const p = risk.points, fc = risk.forecast, t = p.total || 1;
  const areas = Object.entries(p.byArea).sort((a, b) => b[1].total - a[1].total);
  return `<section class="panel"><div class="panel-head"><h2>Story points</h2><span class="chip s-${FC_CHIP[fc.state]}"><i></i>${FC_TEXT[fc.state]}</span></div>
    <div class="pts-stack" role="img" aria-label="${p.done} done, ${p.inFlight} in flight, ${p.todo} not started"><span style="width:${(p.done / t) * 100}%;background:var(--good)"></span><span style="width:${(p.inFlight / t) * 100}%;background:var(--pend)"></span><span style="width:${(p.todo / t) * 100}%;background:var(--line)"></span></div>
    <div class="legend"><span><i style="background:var(--good)"></i>Done ${p.done}</span><span><i style="background:var(--pend)"></i>In flight ${p.inFlight}</span><span><i style="background:var(--line)"></i>Not started ${p.todo}</span></div>
    <div class="stats"><div class="stat"><b>${p.total}</b><span>Total points</span></div><div class="stat"><b>${p.remaining}</b><span>Remaining</span></div><div class="stat"><b>${fc.needPerDay ?? "n/a"}</b><span>Needed per day</span></div><div class="stat"><b>${fc.velocity || "n/a"}</b><span>Velocity per day</span></div></div>
    <div class="msg">${esc(fc.detail)}</div>
    <div>${areas.map(([a, v]) => `<div class="area-row"><span>${esc(a)}</span><div class="fb"><i style="width:${v.total ? (v.done / v.total) * 100 : 0}%"></i></div><span class="mono">${v.done}/${v.total}</span></div>`).join("")}</div></section>`;
}

export function renderDeps({ result, deps }) {
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

export function renderCriteria({ result }, { P, openWaive, waiveError }) {
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

export function renderBrief({ brief }, { STANDALONE }) {
  return `<section class="panel"><div class="panel-head"><h2>Release brief</h2><div class="row-actions"><button class="btn small" type="button" data-act="copy-doc" title="Paste into Google Docs, Word, Confluence or Notion with formatting kept">Copy for Docs</button><button class="btn small" type="button" data-act="copy-brief">Copy Markdown</button>${STANDALONE ? "" : `<button class="btn small" type="button" data-act="download-word">Word (.doc)</button><button class="btn small" type="button" data-act="download-doc" title="Open it, then Print and Save as PDF">Printable page</button><button class="btn small" type="button" data-act="download-status" title="One page for leadership">Status one-pager</button><button class="btn small" type="button" data-act="download-brief">.md</button>`}<span class="msg" id="brief-msg"></span></div></div><pre class="brief" id="brief">${esc(brief)}</pre></section>`;
}

const OUT_CHIP = { "Shipped cleanly": "pass", "Shipped with issues": "warn", "Rolled back": "fail", Cancelled: "waived" };
const when = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? "" : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); };

/** Closed releases and how they turned out. rows and sum come from history.js. */
export function renderHistory(rows, sum, currentId) {
  const head = `<div class="panel-head"><h2>Release history</h2><span class="note">Releases with an outcome recorded under "After the release".</span></div>`;
  if (!rows.length) return `<section class="panel" id="history-panel">${head}<div class="msg">No closed releases yet. When a release is done, pick how it went under <strong>After the release</strong> on the left and it will show up here with the call it had when it closed.</div></section>`;
  const tally = [["clean", "shipped cleanly", "pass"], ["issues", "shipped with issues", "warn"], ["rolledBack", "rolled back", "fail"], ["cancelled", "cancelled", "waived"]].filter(([k]) => sum[k]).map(([k, l, c]) => `<span class="chip s-${c}"><i></i>${sum[k]} ${l}</span>`).join(" ");
  const calls = ["GO", "HOLD", "NO-GO"].filter((c) => sum.byCall[c]).map((c) => `<li><strong>${esc(c)}</strong> at close: ${sum.byCall[c].shipped} shipped, ${sum.byCall[c].trouble} had issues or were rolled back</li>`).join("");
  const body = rows.map((r) => `<tr><td>${esc(r.name)}${r.version ? ` <span class="mono">${esc(r.version)}</span>` : ""}<div class="msg">${esc(when(r.at))}</div></td><td><span class="chip s-${OUT_CHIP[r.status] || "pending"}"><i></i>${esc(r.status)}</span></td><td>${r.call ? `${esc(r.call)}${r.risk === null ? "" : `<div class="msg">risk ${r.risk}</div>`}` : "—"}</td><td>${r.id === currentId ? `<span class="msg">Open now</span>` : `<button class="btn small" type="button" data-act="open-release" data-id="${esc(r.id)}">Open</button>`}</td></tr>${r.note ? `<tr><td colspan="4" class="msg">${esc(r.note.length > 200 ? r.note.slice(0, 200) + "…" : r.note)}</td></tr>` : ""}`).join("");
  return `<section class="panel" id="history-panel">${head}<div class="row-actions">${tally}</div>${sum.shippedAgainstCall ? `<div class="msg">${sum.shippedAgainstCall} shipped while the call was HOLD or NO-GO.</div>` : ""}${calls ? `<ul class="plain">${calls}</ul>` : ""}<div class="tablewrap"><table class="tbl"><thead><tr><th>Release</th><th>Outcome</th><th>Call when closed</th><th></th></tr></thead><tbody>${body}</tbody></table></div></section>`;
}
