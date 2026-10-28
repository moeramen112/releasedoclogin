// Ticket import from a spreadsheet: paste cells, or load a CSV or TSV export from any tracker
// (Jira, Linear, Asana, Azure DevOps, Trello, a plain spreadsheet).
//
// Pure functions. No clock, no network, no disk. The same file runs in the browser (the import panel)
// and in tests. Three steps, each usable on its own:
//   parseTable(text)            -> { headers, rows }          text to cells
//   suggestMapping(headers)     -> { key: 0, summary: 1, ... } which column holds which ticket field
//   mapTickets(rows, mapping)   -> { tickets, skipped, notes } cells to the planner's ticket shape
//
// How to change the rules
//  - IMPORT_FIELDS lists the ticket fields and the header names that mean each one. Add a synonym to teach it a new export.
//  - The value maps (PRIORITY, STATUS, TYPE) say how a word in a spreadsheet becomes a planner value.
//    Each entry is [pattern, result]; the first pattern that matches wins.

export const IMPORT_LIMITS = { rows: 5000, columns: 60, cell: 2000, chars: 2_000_000 };

/* ---------- 1. text to cells ---------- */

const DELIMITERS = ["\t", ",", ";", "|"];

/** The delimiter that appears most in the first line (outside quotes). Tab wins ties: pasting from a sheet gives tabs. */
function detectDelimiter(text) {
  const counts = Object.fromEntries(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (let i = 0; i < text.length && i < 5000; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "\n" || c === "\r")) break;
    else if (!quoted && c in counts) counts[c]++;
  }
  return DELIMITERS.reduce((best, d) => (counts[d] > counts[best] ? d : best), "\t");
}

/**
 * Split text into rows of cells. Handles quoted cells, "" for a quote inside one, line breaks inside quotes,
 * a leading BOM, Windows and Mac line endings, and ragged rows. Never throws; stops at the limits.
 */
export function parseTable(input, { delimiter } = {}) {
  let text = String(input ?? "").slice(0, IMPORT_LIMITS.chars).replace(/^\uFEFF/, "");
  const delim = delimiter || detectDelimiter(text);
  const out = [];
  let row = [], cell = "", quoted = false, truncated = text.length >= IMPORT_LIMITS.chars;
  const endCell = () => { row.push(cell.slice(0, IMPORT_LIMITS.cell)); cell = ""; };
  const endRow = () => { endCell(); if (row.some((x) => x.trim() !== "")) out.push(row.slice(0, IMPORT_LIMITS.columns)); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delim) endCell();
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; endRow(); }
    else cell += c;
    if (out.length > IMPORT_LIMITS.rows) { truncated = true; break; }
  }
  if (cell !== "" || row.length) endRow();
  const headers = (out.shift() || []).map((h) => h.trim());
  if (out.length > IMPORT_LIMITS.rows) { out.length = IMPORT_LIMITS.rows; truncated = true; }
  return { delimiter: delim, headers, rows: out, truncated };
}

/* ---------- 2. which column is which ---------- */

/** The ticket fields, in the order columns are claimed. `names` are header texts (lowercase, letters and digits only). */
export const IMPORT_FIELDS = [
  { id: "key", label: "Ticket key", names: ["key", "issuekey", "ticketkey", "id", "ticketid", "issueid", "workitemid", "taskid", "identifier", "ref", "reference", "number", "ticket", "issue"] },
  { id: "summary", label: "Summary", names: ["summary", "title", "name", "taskname", "workitemtitle", "subject", "issuetitle", "description"] },
  { id: "type", label: "Type", names: ["type", "issuetype", "workitemtype", "tickettype", "kind"] },
  { id: "priority", label: "Priority", names: ["priority", "prio", "severity", "urgency"] },
  { id: "points", label: "Story points", names: ["storypoints", "storypointestimate", "points", "estimate", "size", "effort", "pts", "sp"] },
  { id: "status", label: "Status", names: ["status", "state", "workflowstate", "column", "stage"] },
  { id: "assignee", label: "Assignee", names: ["assignee", "assignedto", "assigned", "owner", "responsible", "person"] },
  { id: "area", label: "Area", names: ["area", "component", "components", "module", "areapath"] },
  { id: "team", label: "Team", names: ["team", "squad", "group", "department"] },
  { id: "blockedBy", label: "Blocked by", names: ["blockedby", "isblockedby", "dependson", "dependencies", "predecessors", "blockers", "blocker"] },
];

const squash = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Guess the mapping from the header row. Each column is used for at most one field. Returns { fieldId: columnIndex or -1 }. */
export function suggestMapping(headers) {
  const heads = (headers || []).map(squash);
  const taken = new Set();
  const map = {};
  const claim = (f, test) => {
    for (const name of f.names) {            // earlier names are stronger matches
      const i = heads.findIndex((h, n) => !taken.has(n) && h && test(h, name));
      if (i >= 0) { taken.add(i); map[f.id] = i; return; }
    }
  };
  for (const f of IMPORT_FIELDS) claim(f, (h, name) => h === name);
  // Second look for headers with extra words around a known name: "Card Name", "Custom field (Story point estimate)".
  for (const f of IMPORT_FIELDS) if (map[f.id] === undefined) claim(f, (h, name) => (name.length >= 4 && h.endsWith(name)) || (name.length >= 8 && h.includes(name)));
  for (const f of IMPORT_FIELDS) if (map[f.id] === undefined) map[f.id] = -1;
  return map;
}

/* ---------- 3. cells to tickets ---------- */

const PRIORITY = [
  [/^(p0|0|1|highest|blocker|critical|urgent|sev0|sev1|s1|showstopper)$/, "P0"],
  [/^(p1|2|high|major|sev2|s2|important)$/, "P1"],
  [/^(p2|3|medium|med|normal|moderate|sev3|s3|default)$/, "P2"],
  [/^(p3|4|5|low|lowest|minor|trivial|sev4|s4|none|nice ?to ?have)$/, "P3"],
];
const STATUS = [
  [/(not started|unstarted|backlog|to ?do|open|new|planned|ready for dev|icebox|triage)/, "To do"],
  [/(cancel|won'?t|reject|duplicate|obsolete|declined)/, "Done"], // closed without shipping: it no longer holds the release back
  [/(done|closed|resolved|complete|shipped|released|merged|finished|deployed|verified)/, "Done"],
  [/(review|qa|test|verify|validation|approval|uat)/, "In review"],
  [/(progress|doing|started|active|wip|develop|working|implement|building)/, "In progress"],
  [/.*/, "To do"],
];
const TYPE = [
  [/(bug|defect|incident|problem|regression|fix)/, "Bug"],
  [/(story|feature|epic|enhancement|improvement|user ?story|requirement)/, "Story"],
  [/.*/, "Task"],
];
const AREAS = ["Payments", "Auth", "Data", "Core", "Mobile", "UI", "Infra", "Security"];

/** The first table entry whose pattern matches; `known` is false when only the catch-all (or nothing) matched. */
const pick = (table, value, fallback) => {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return { value: fallback, known: false };
  for (const [re, out] of table) if (re.test(v)) return { value: out, known: re.source !== ".*" };
  return { value: fallback, known: false };
};
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** "5", "5.5", "5 pts", "5,5" (a comma as the decimal point) -> a number from 0 to 1000. Anything else is 0. */
export function parsePoints(v) {
  const m = String(v ?? "").trim().replace(/,(?=\d{1,2}\b)/, ".").match(/^-?\d+(\.\d+)?/);
  const n = m ? Number(m[0]) : 0;
  return Number.isFinite(n) ? Math.min(1000, Math.max(0, Math.round(n * 100) / 100)) : 0;
}

/** Ticket keys from "A-1, B-2; C-3 D-4". */
const keysFrom = (v) => [...new Set(String(v ?? "").split(/[\s,;|]+/).map((x) => x.trim()).filter(Boolean))].map((x) => x.slice(0, 40)).join(", ");

/**
 * Turn rows into planner tickets.
 *  rows     arrays of cells (from parseTable)
 *  mapping  { fieldId: columnIndex or -1 }; a field with no column gets a plain default
 * Returns { tickets, skipped: [{ row, reason }], notes }. `row` counts from 2 (row 1 is the header), like a spreadsheet.
 * `notes` are one-line warnings, such as "3 priorities were not recognised and became P2".
 */
export function mapTickets(rows, mapping = {}) {
  const cellOf = (r, id) => (Number.isInteger(mapping[id]) && mapping[id] >= 0 ? r[mapping[id]] ?? "" : "");
  const tickets = [], skipped = [], seen = new Set();
  let badPriority = 0, generated = 0;
  (rows || []).forEach((r, n) => {
    const rowNo = n + 2;
    const summary = clip(cellOf(r, "summary"), 200);
    let key = clip(cellOf(r, "key"), 40);
    if (!key && !summary) { skipped.push({ row: rowNo, reason: "no key and no summary" }); return; }
    if (!key) { key = `IMP-${++generated}`; }
    const id = key.toUpperCase();
    if (seen.has(id)) { skipped.push({ row: rowNo, reason: `${key} appears twice; the first one was kept` }); return; }
    seen.add(id);
    const pr = pick(PRIORITY, cellOf(r, "priority"), "P2");
    if (String(cellOf(r, "priority")).trim() && !pr.known) badPriority++;
    const area = clip(cellOf(r, "area"), 40);
    tickets.push({
      key, summary: summary || key,
      type: pick(TYPE, cellOf(r, "type"), "Task").value,
      priority: pr.value,
      points: parsePoints(cellOf(r, "points")),
      status: pick(STATUS, cellOf(r, "status"), "To do").value,
      assignee: clip(cellOf(r, "assignee"), 60) || "Unassigned",
      area: AREAS.find((a) => a.toLowerCase() === area.toLowerCase()) || area || "Core",
      team: clip(cellOf(r, "team"), 40),
      blockedBy: keysFrom(cellOf(r, "blockedBy")),
      tags: { migration: false, customerFacing: false, untested: false },
    });
  });
  const notes = [];
  if (badPriority) notes.push(`${badPriority} priorit${badPriority === 1 ? "y was" : "ies were"} not recognised and became P2.`);
  if (generated) notes.push(`${generated} row${generated === 1 ? " had" : "s had"} no key, so ${generated === 1 ? "it was" : "they were"} numbered IMP-1${generated > 1 ? ` to IMP-${generated}` : ""}.`);
  if (!mapping || !(mapping.key >= 0)) notes.push("No column is set as the ticket key. Pick one if your sheet has it, so a second import updates tickets instead of adding copies.");
  return { tickets, skipped, notes };
}

/** All three steps at once, for callers that do not need to show the mapping. */
export function importTickets(text, mapping) {
  const t = parseTable(text);
  const m = mapping || suggestMapping(t.headers);
  return { ...mapTickets(t.rows, m), headers: t.headers, mapping: m, truncated: t.truncated };
}
