import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTable, suggestMapping, mapTickets, importTickets, parsePoints, IMPORT_FIELDS, IMPORT_LIMITS } from "../src/import.js";

test("parseTable: quotes, doubled quotes, line breaks inside quotes, BOM, CRLF and Mac line ends", () => {
  const t = parseTable('﻿Key,Summary\r\nA-1,"Say ""hi"", then\nleave"\rA-2,plain\r\n');
  assert.deepEqual(t.headers, ["Key", "Summary"]);
  assert.deepEqual(t.rows, [["A-1", 'Say "hi", then\nleave'], ["A-2", "plain"]]);
  assert.equal(t.delimiter, ",");
});

test("parseTable: picks tab for a paste from a sheet, and semicolon or pipe for the others", () => {
  assert.equal(parseTable("Key\tSummary\nA-1\tHello, world").delimiter, "\t");
  assert.deepEqual(parseTable("Key\tSummary\nA-1\tHello, world").rows, [["A-1", "Hello, world"]]);
  assert.equal(parseTable("Key;Summary\nA-1;Hi").delimiter, ";");
  assert.equal(parseTable("Key|Summary\nA-1|Hi").delimiter, "|");
  assert.equal(parseTable("Key,Summary\nA-1,Hi", { delimiter: "," }).delimiter, ",");
});

test("parseTable: empty and odd input never throws and gives an empty table", () => {
  for (const x of ["", " ", "\n\n", null, undefined, 5, {}, '"', '"""', ",,,,", "a,\"b"]) assert.doesNotThrow(() => parseTable(x));
  assert.deepEqual(parseTable("").rows, []);
  assert.deepEqual(parseTable("Key,Summary\n,\n  ,  \n").rows, []); // blank lines are dropped
  assert.deepEqual(parseTable("Key,Summary\nA-1").rows, [["A-1"]]); // short rows stay short
});

test("parseTable: limits keep a huge paste from freezing the page", () => {
  const big = "k,s\n" + Array.from({ length: IMPORT_LIMITS.rows + 500 }, (_, i) => `A-${i},x`).join("\n");
  const t = parseTable(big);
  assert.equal(t.rows.length, IMPORT_LIMITS.rows);
  assert.equal(t.truncated, true);
  assert.equal(parseTable("a\n" + "x".repeat(IMPORT_LIMITS.cell + 500)).rows[0][0].length, IMPORT_LIMITS.cell);
  assert.ok(parseTable("a," .repeat(500) + "\n1").headers.length <= IMPORT_LIMITS.columns);
});

test("suggestMapping: reads the headers of real exports", () => {
  const jira = suggestMapping(["Issue key", "Issue id", "Summary", "Issue Type", "Status", "Priority", "Assignee", "Custom field (Story point estimate)", "Component/s"]);
  assert.equal(jira.key, 0); assert.equal(jira.summary, 2); assert.equal(jira.type, 3); assert.equal(jira.status, 4); assert.equal(jira.priority, 5); assert.equal(jira.assignee, 6);
  const ado = suggestMapping(["ID", "Work Item Type", "Title", "State", "Assigned To", "Priority", "Effort", "Area Path"]);
  assert.deepEqual([ado.key, ado.type, ado.summary, ado.status, ado.assignee, ado.priority, ado.points, ado.area], [0, 1, 2, 3, 4, 5, 6, 7]);
  const linear = suggestMapping(["ID", "Title", "Status", "Priority", "Estimate", "Assignee", "Team"]);
  assert.deepEqual([linear.key, linear.summary, linear.status, linear.priority, linear.points, linear.assignee, linear.team], [0, 1, 2, 3, 4, 5, 6]);
  const asana = suggestMapping(["Task ID", "Name", "Assignee", "Section/Column", "Priority"]);
  assert.deepEqual([asana.key, asana.summary, asana.assignee, asana.priority], [0, 1, 2, 4]);
  const trello = suggestMapping(["Card Name", "List Name", "Members"]);
  assert.equal(trello.summary, 0); // "Card Name" ends in a known name
  const none = suggestMapping(["foo", "bar"]);
  assert.ok(IMPORT_FIELDS.every((f) => none[f.id] === -1));
});

test("suggestMapping: a column is used for one field only, and strong names win over weak ones", () => {
  const m = suggestMapping(["Key", "Title", "Description"]);
  assert.equal(m.summary, 1); // "title" before "description"
  const used = Object.values(m).filter((x) => x >= 0);
  assert.equal(new Set(used).size, used.length);
});

test("mapTickets: normalises priority, status, type, points, area and blockers", () => {
  const rows = [
    ["A-1", "Checkout", "Bug", "Critical", "5 pts", "In Review", "Dana", "payments", "A-9; A-8,A-9"],
    ["A-2", "Docs", "Task", "4", "2,5", "Won't do", "", "Sparkles", ""],
    ["A-3", "Tests", "Story", "Medium", "abc", "Ready for QA", "Lee", "", ""],
    ["A-4", "Idea", "", "nonsense", "-3", "Not started", "", "", ""],
  ];
  const map = { key: 0, summary: 1, type: 2, priority: 3, points: 4, status: 5, assignee: 6, area: 7, blockedBy: 8 };
  const { tickets, notes } = mapTickets(rows, map);
  assert.deepEqual(tickets.map((t) => [t.type, t.priority, t.points, t.status, t.assignee, t.area]), [
    ["Bug", "P0", 5, "In review", "Dana", "Payments"],
    ["Task", "P3", 2.5, "Done", "Unassigned", "Sparkles"],
    ["Story", "P2", 0, "In review", "Lee", "Core"],
    ["Task", "P2", 0, "To do", "Unassigned", "Core"],
  ]);
  assert.equal(tickets[0].blockedBy, "A-9, A-8");
  assert.match(notes.join(" "), /1 priority was not recognised/);
});

test("mapTickets: rows without keys are numbered, duplicates and empty rows are skipped and explained", () => {
  const { tickets, skipped, notes } = mapTickets([["", "No key here"], ["A-1", "One"], ["a-1", "Again"], ["", ""], ["", "Second without key"]], { key: 0, summary: 1 });
  assert.deepEqual(tickets.map((t) => t.key), ["IMP-1", "A-1", "IMP-2"]);
  assert.deepEqual(skipped.map((s) => s.row), [4, 5]); // row 1 is the header, so data starts at 2
  assert.match(skipped[0].reason, /twice/);
  assert.match(notes.join(" "), /numbered IMP-1 to IMP-2/);
  assert.equal(mapTickets([["x"]], {}).notes.some((n) => /No column is set as the ticket key/.test(n)), true);
});

test("mapTickets: spreadsheet formulas and markup stay plain text, and long cells are cut", () => {
  const { tickets } = mapTickets([["=1+1", "<img src=x onerror=alert(1)>" + "y".repeat(500), "", "", "", "", "@SUM(A1)"]], { key: 0, summary: 1, assignee: 6 });
  assert.equal(tickets[0].key, "=1+1");
  assert.ok(tickets[0].summary.length <= 200);
  assert.equal(tickets[0].assignee, "@SUM(A1)"); // stored as text; the pages escape it when they draw it
});

test("parsePoints", () => {
  for (const [v, n] of [["5", 5], ["5.5", 5.5], ["5 pts", 5], ["2,5", 2.5], ["", 0], [null, 0], ["x", 0], ["-4", 0], ["99999", 1000], ["1e3", 1], ["NaN", 0], [Infinity, 0]]) assert.equal(parsePoints(v), n, String(v));
});

test("importTickets: the whole path on a pasted sheet, and a second import line up by key", () => {
  const sheet = "Key\tSummary\tStatus\tStory Points\nREL-1\tLogin\tDone\t3\nREL-2\tPay\tIn progress\t5";
  const r = importTickets(sheet);
  assert.equal(r.tickets.length, 2);
  assert.equal(r.tickets[1].points, 5);
  assert.equal(r.mapping.points, 3);
});

test("fuzz: random garbage never throws and always returns well-formed tickets", () => {
  let s = 99; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const bits = ['"', ",", "\t", ";", "\n", "\r\n", "a", "REL-1", "5", "=", " ", "\u0000", "é", "<b>", "\ud800", "|"];
  for (let i = 0; i < 400; i++) {
    const text = Array.from({ length: Math.floor(rnd() * 120) }, () => bits[Math.floor(rnd() * bits.length)]).join("");
    const r = importTickets(text);
    for (const t of r.tickets) {
      assert.equal(typeof t.key, "string"); assert.ok(t.key.length > 0);
      assert.ok(["P0", "P1", "P2", "P3"].includes(t.priority)); assert.ok(["To do", "In progress", "In review", "Done"].includes(t.status));
      assert.ok(Number.isFinite(t.points) && t.points >= 0 && t.points <= 1000);
    }
  }
});
