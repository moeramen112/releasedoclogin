import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient, fetchGithub, GitHubError } from "../src/sources/github.js";
import { startMockGithub } from "../testing/mock-github.js";

const config = JSON.parse(readFileSync(new URL("../readiness.config.json", import.meta.url), "utf8"));
const release = { ...config.release, repo: "acme/web", baseRef: "v4.11.0", headRef: "release/4.12", tag: "v4.12.0" };
const now = Date.parse("2026-10-19T12:00:00Z");

let mock, result;
before(async () => {
  mock = await startMockGithub();
  const client = createClient({ token: "t", baseUrl: mock.base });
  result = await fetchGithub({ release, config, token: "t", client, now });
});
after(() => mock.close());

test("no slice failed", () => {
  assert.deepEqual(result.errors, {});
});

test("compare: sums file changes and counts distinct authors", () => {
  assert.deepEqual(result.data.compare, { commits: 10, filesChanged: 2, truncated: false, additions: 105, deletions: 25, authors: 2 });
});

test("ci: follows pagination and merges check runs with commit statuses", () => {
  const ci = result.data.ci;
  assert.equal(ci.total, 4); // build, unit, e2e (page 2), lint (status)
  assert.equal(ci.passed, 2);
  assert.deepEqual(ci.failed, ["unit"]);
  assert.deepEqual(ci.pending, ["e2e"]);
});

test("merged PRs: only merged ones, approval follows the latest review per person", () => {
  const prs = result.data.mergedPrs;
  assert.deepEqual(prs.map((p) => p.number), [1, 2]);
  assert.equal(prs[0].approved, true); // a later APPROVED outranks an earlier COMMENT
  assert.equal(prs[1].approved, false); // approval was dismissed
});

test("open PRs: failing checks and requested changes are surfaced", () => {
  const [pr] = result.data.openPrs;
  assert.equal(pr.number, 3);
  assert.equal(pr.checks, "failing");
  assert.equal(pr.review, "changes_requested");
  assert.equal(pr.ageDays, 2);
});

test("blockers: dedupes across labels, drops PRs, ranks by severity", () => {
  const b = result.data.blockers;
  assert.deepEqual(b.map((x) => x.key), ["#10", "#12"]);
  assert.equal(b[0].sev, "P0");
  assert.equal(b[1].sev, "P1"); // blocker label with no severity label uses the default
  assert.equal(b[1].owner, "Unassigned");
});

test("draft release is found by tag", () => {
  assert.equal(result.data.draftRelease.exists, true);
});

test("rate limits produce a readable error", async () => {
  const client = createClient({ baseUrl: mock.base });
  await assert.rejects(
    () => client.json("/repos/limited/repo/compare/a...b"),
    (e) => e instanceof GitHubError && /rate limit/i.test(e.message) && /GITHUB_TOKEN/.test(e.message),
  );
});

test("one failing slice does not take the others down", async () => {
  const client = createClient({ token: "t", baseUrl: mock.base });
  const r = await fetchGithub({ release: { ...release, baseRef: "does-not-exist" }, config, token: "t", client, now });
  assert.match(r.errors.compare, /Not found/);
  assert.ok(r.data.ci && r.data.blockers);
});
