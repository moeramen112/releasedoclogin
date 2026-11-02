// Read-only share links. A link shows one release and nothing else, with no sign-in.
//
// Pure functions (no clock, disk or network of their own), so the rules are easy to test and change:
//   newToken()                     a random secret for the link; only its hash is ever saved
//   hashToken(token)               what the server stores and looks up
//   linkState(link, now)           "active", "expired" or "revoked"
//   publicView(plan, now)          the ONLY facts a share page may show. Add a field here to share more.
//   renderSharePage(view|null)     the HTML page. Escaped, no scripts, no links out.
//
// What is deliberately left out: ticket text, people's names, Slack settings, notes, RAID owners, other releases.

import crypto from "node:crypto";
import { esc } from "./html.js";
import { completePlan, runbookStatus } from "./plan.js";
import { takeSnapshot } from "./history.js";

export const SHARE_DEFAULT_DAYS = 7;
export const SHARE_MAX_DAYS = 90;
export const MAX_LINKS_PER_RELEASE = 20;
export const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;

export const newToken = () => crypto.randomBytes(24).toString("base64url");
export const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

/** Days to a number from 1 to SHARE_MAX_DAYS; anything unusable becomes the default. */
export function clampDays(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, SHARE_MAX_DAYS) : SHARE_DEFAULT_DAYS;
}

export function linkState(link, now = Date.now()) {
  if (!link) return "missing";
  if (link.revoked) return "revoked";
  return Number.isFinite(link.expiresAt) && link.expiresAt > now ? "active" : "expired";
}

const when = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? "" : new Date(t).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }); };

/** The facts a share page may show about a release. */
export function publicView(plan, now = Date.now()) {
  const p = completePlan(plan || {});
  const snap = takeSnapshot(p, now);
  const rb = runbookStatus(p, now);
  return {
    name: String(p.release?.name || "Untitled release").slice(0, 120), version: String(p.release?.version || "").slice(0, 40),
    call: snap.call, reason: String(snap.reason || "").slice(0, 400), risk: snap.risk, riskLevel: snap.riskLevel,
    pctDone: snap.pctDone, openCriteria: snap.open, waived: snap.waived, tickets: snap.tickets,
    runbook: { done: rb.done, total: rb.total, blocked: rb.blocked.length, overdue: rb.overdue.length },
    deployAt: p.when?.deployAt || "", outcome: p.outcome?.status || "", asOf: new Date(now).toISOString(),
  };
}

const CALL_CLASS = { GO: "pass", HOLD: "warn", "NO-GO": "fail" };
const CSS = `body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:#f6f5f1;color:#1d1d1b}
@media(prefers-color-scheme:dark){body{background:#16171a;color:#ececea}.card{background:#1f2125!important;border-color:#33363c!important}}
.wrap{max-width:680px;margin:0 auto;padding:24px 16px}.card{background:#fff;border:1px solid #d9d6cc;border-radius:10px;padding:18px;margin:14px 0}
h1{margin:0 0 2px;font-size:24px}.sub,.note{color:#6b6a63;font-size:14px}
.call{display:inline-block;font:700 28px ui-monospace,monospace;padding:4px 14px;border-radius:8px}
.pass{background:#e0f2e8;color:#1b7a49}.warn{background:#fbefd2;color:#8f5a00}.fail{background:#fbe2df;color:#b3261e}
.grid{display:flex;flex-wrap:wrap;gap:12px}.stat{flex:1 1 130px}.n{font:600 26px ui-monospace,monospace}.l{font-size:13px;color:#6b6a63}`;

/** The share page. `view` is publicView() output, or null for a link that no longer works. */
export function renderSharePage(view) {
  const shell = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${view ? esc(view.name) + " – status" : "Link not active"}</title><style>${CSS}</style></head><body><div class="wrap">${body}</div></body></html>`;
  if (!view) return shell(`<div class="card"><h1>This link is no longer active</h1><p class="note">It has expired or was turned off. Ask the person who sent it for a new one.</p></div>`);
  const cls = CALL_CLASS[view.call] || "warn";
  const rb = view.runbook;
  return shell(`<h1>${esc(view.name)}${view.version ? ` <span class="sub">${esc(view.version)}</span>` : ""}</h1>
<div class="sub">Read-only status${view.deployAt ? ` · deploy ${esc(when(view.deployAt))}` : ""}${view.outcome ? ` · ${esc(view.outcome)}` : ""}</div>
<div class="card"><span class="call ${cls}">${esc(view.call)}</span><p>${esc(view.reason)}</p></div>
<div class="card"><div class="grid">
<div class="stat"><div class="n">${esc(view.risk)}/100</div><div class="l">risk · ${esc(view.riskLevel)}</div></div>
<div class="stat"><div class="n">${esc(Math.round(view.pctDone))}%</div><div class="l">points done</div></div>
<div class="stat"><div class="n">${esc(view.openCriteria)}</div><div class="l">criteria open</div></div>
<div class="stat"><div class="n">${esc(rb.done)}/${esc(rb.total)}</div><div class="l">runbook steps done</div></div></div>
${rb.blocked || rb.overdue ? `<p class="note">${rb.blocked ? `${esc(rb.blocked)} runbook step${rb.blocked === 1 ? "" : "s"} blocked. ` : ""}${rb.overdue ? `${esc(rb.overdue)} overdue.` : ""}</p>` : ""}</div>
<p class="note">Snapshot as of ${esc(when(view.asOf))}. This page is read-only and shows this release only.</p>`);
}
