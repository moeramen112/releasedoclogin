import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetchJiraRelease, mapStatus } from "../src/sources/jira.js";
import { createApp } from "../src/server.js";

const env = { JIRA_BASE_URL: "https://acme.atlassian.net/", JIRA_EMAIL: "a@acme.com", JIRA_API_TOKEN: "tok" };
const issue = (key, f) => ({ key, fields: { summary: key + " summary", issuetype: { name: "Story" }, priority: { name: "High" }, status: { name: "In Progress", statusCategory: { key: "indeterminate" } }, assignee: { displayName: "Dana K." }, components: [], labels: [], ...f } });

function mockFetch(pages, seen) {
  let i = 0;
  return async (url, opts) => {
    seen.push({ url, opts, body: JSON.parse(opts.body) });
    const page = pages[i++];
    return { ok: true, status: 200, json: async () => page };
  };
}

test("story points come from the configured custom field, across pages", async () => {
  const seen = [];
  const pages = [
    { issues: [issue("REL-1", { customfield_10099: 5, issuetype: { name: "Bug" }, priority: { name: "Highest" }, components: [{ name: "Payments" }], labels: ["Migration", "customer-facing"] })], nextPageToken: "t2", isLast: false },
    { issues: [issue("REL-2", { customfield_10099: 3.5, status: { name: "Done", statusCategory: { key: "done" } } }), issue("REL-3", {})], isLast: true },
  ];
  const out = await fetchJiraRelease({ version: "4.12", config: { jira: { storyPointsField: "customfield_10099" } }, env, fetchImpl: mockFetch(pages, seen) });

  assert.equal(out.length, 3);
  assert.deepEqual(out.map((x) => x.points), [5, 3.5, 0]);
  assert.equal(out[0].type, "Bug");
  assert.equal(out[0].priority, "P0");
  assert.equal(out[0].area, "Payments");
  assert.equal(out[0].tags.migration, true);
  assert.equal(out[0].tags.customerFacing, true);
  assert.equal(out[1].status, "Done");
  assert.equal(out[2].area, "Core");

  assert.equal(seen.length, 2);
  assert.ok(seen[0].body.fields.includes("customfield_10099"));
  assert.match(seen[0].body.jql, /fixVersion = "4\.12"/);
  assert.equal(seen[1].body.nextPageToken, "t2");
  assert.equal(seen[0].url, "https://acme.atlassian.net/rest/api/3/search/jql");
  assert.match(seen[0].opts.headers.Authorization, /^Basic /);
});

test("\"is blocked by\" links become the ticket's blockers, and \"blocks\" links do not", async () => {
  const link = (inward, outward, side, key) => ({ type: { name: "Blocks", inward, outward }, [side]: { key } });
  const pages = [{ issues: [
    issue("FE-1", { issuelinks: [link("is blocked by", "blocks", "inwardIssue", "BE-1"), link("is blocked by", "blocks", "inwardIssue", "BE-2"), link("is blocked by", "blocks", "outwardIssue", "QA-1")] }),
    issue("BE-1", { issuelinks: [link("is blocked by", "blocks", "outwardIssue", "FE-1")] }),
    issue("REL-9", { issuelinks: [{ type: { name: "Relates", inward: "relates to", outward: "relates to" }, inwardIssue: { key: "REL-1" } }] }),
    issue("REL-10", {}),
  ], isLast: true }];
  const seen = [];
  const out = await fetchJiraRelease({ version: "4.12", config: {}, env, fetchImpl: mockFetch(pages, seen) });
  assert.deepEqual(out.map((x) => x.blockedBy), ["BE-1, BE-2", "", "", ""]);
  assert.ok(seen[0].body.fields.includes("issuelinks"));
});

test("Jira statuses map to the planner's four", () => {
  assert.equal(mapStatus({ name: "Backlog", statusCategory: { key: "new" } }), "To do");
  assert.equal(mapStatus({ name: "In Code Review", statusCategory: { key: "indeterminate" } }), "In review");
  assert.equal(mapStatus({ name: "Doing", statusCategory: { key: "indeterminate" } }), "In progress");
  assert.equal(mapStatus({ name: "Shipped", statusCategory: { key: "done" } }), "Done");
});

test("bad credentials give a readable error", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(() => fetchJiraRelease({ version: "4.12", config: {}, env, fetchImpl }), /rejected the credentials/);
});

test("the planner endpoint needs Jira config and a version, and the shared modules are served", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rr-jira-"));
  const mk = async (e, deps = {}) => {
    const a = await createApp({ stateDir: dir, auth: false, defaultMode: "demo", env: e, deps });
    await new Promise((r) => a.server.listen(0, "127.0.0.1", r));
    return { a, b: `http://127.0.0.1:${a.server.address().port}` };
  };
  const off = await mk({});
  const on = await mk(env, { fetchJiraRelease: async ({ version }) => [{ key: "REL-9", points: 2, version }] });
  try {
    let r = await fetch(off.b + "/api/jira/issues?version=4.12");
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /not configured/);

    r = await fetch(on.b + "/api/jira/issues");
    assert.equal(r.status, 400);

    r = await fetch(on.b + "/api/jira/issues?version=4.12");
    const body = await r.json();
    assert.equal(body.issues[0].key, "REL-9");

    for (const f of ["/engine.js", "/risk.js", "/plan.js"]) {
      const m = await fetch(off.b + f);
      assert.equal(m.status, 200);
      assert.match(m.headers.get("content-type"), /javascript/);
    }
    assert.equal((await fetch(off.b + "/server.js")).status, 404); // only the three pure modules are exposed
  } finally {
    off.a.server.close(); on.a.server.close(); rmSync(dir, { recursive: true, force: true });
  }
});
