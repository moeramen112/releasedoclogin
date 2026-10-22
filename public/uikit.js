// Small helpers shared by the planner page and its panels.
export const $ = (s, r = document) => r.querySelector(s);
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const LABEL = { pass: "Pass", warn: "At risk", fail: "Failing", pending: "Pending", waived: "Waived" };
export const chip = (s) => `<span class="chip s-${s}"><i></i>${LABEL[s]}</span>`;
