// A tiny stand-in for the GitHub REST API, enough to exercise the adapter:
// pagination via Link headers, issues vs PRs in the issues endpoint, reviews, check runs and rate limits.

import http from "node:http";

export async function startMockGithub() {
  let base = "";
  const calls = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const p = decodeURIComponent(url.pathname);
    const q = url.searchParams;
    calls.push(`${req.method} ${p}${url.search}`);
    const json = (body, headers = {}) => {
      res.writeHead(200, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };

    if (p === "/repos/acme/web/compare/v4.11.0...release/4.12") {
      return json({
        total_commits: 10,
        commits: [{ author: { login: "a" } }, { author: { login: "b" } }, { author: { login: "a" } }],
        files: [{ additions: 100, deletions: 20 }, { additions: 5, deletions: 5 }],
      });
    }

    if (p === "/repos/acme/web/commits/release/4.12/check-runs") {
      if (q.get("page") === "2") return json({ total_count: 3, check_runs: [{ name: "e2e", status: "in_progress", conclusion: null }] });
      return json(
        { total_count: 3, check_runs: [{ name: "build", status: "completed", conclusion: "success" }, { name: "unit", status: "completed", conclusion: "failure" }] },
        { Link: `<${base}/repos/acme/web/commits/release/4.12/check-runs?per_page=100&page=2>; rel="next"` },
      );
    }
    if (p === "/repos/acme/web/commits/release/4.12/status") return json({ statuses: [{ context: "lint", state: "success" }] });

    if (p === "/repos/acme/web/pulls" && q.get("state") === "closed") {
      return json([
        { number: 1, title: "Approved change", user: { login: "dana" }, merged_at: "2026-10-14T10:00:00Z", html_url: "u1" },
        { number: 2, title: "Merged without review", user: { login: "lee" }, merged_at: "2026-10-16T10:00:00Z", html_url: "u2" },
        { number: 9, title: "Closed, never merged", user: { login: "x" }, merged_at: null, html_url: "u9" },
      ]);
    }
    if (p === "/repos/acme/web/pulls" && q.get("state") === "open") {
      return json([{ number: 3, title: "Still open", user: { login: "priya" }, draft: false, created_at: "2026-10-17T10:00:00Z", head: { sha: "abc123" }, html_url: "u3" }]);
    }
    if (p === "/repos/acme/web/pulls/1/reviews") return json([{ user: { login: "r1" }, state: "COMMENTED" }, { user: { login: "r1" }, state: "APPROVED" }]);
    if (p === "/repos/acme/web/pulls/2/reviews") return json([{ user: { login: "r1" }, state: "APPROVED" }, { user: { login: "r1" }, state: "DISMISSED" }]);
    if (p === "/repos/acme/web/pulls/3/reviews") return json([{ user: { login: "r2" }, state: "CHANGES_REQUESTED" }]);
    if (p === "/repos/acme/web/commits/abc123/check-runs") return json({ total_count: 1, check_runs: [{ name: "build", status: "completed", conclusion: "failure" }] });
    if (p === "/repos/acme/web/commits/abc123/status") return json({ statuses: [] });

    if (p === "/repos/acme/web/issues") {
      const label = q.get("labels");
      const p0 = { number: 10, title: "Checkout totals wrong", labels: [{ name: "P0" }, { name: "release-blocker" }], assignee: { login: "dana" }, created_at: "2026-10-16T10:00:00Z", html_url: "i10" };
      const prLike = { number: 11, title: "A PR in the issues list", labels: [{ name: "P0" }], pull_request: {}, created_at: "2026-10-16T10:00:00Z" };
      const blockerOnly = { number: 12, title: "Blocked on vendor", labels: [{ name: "release-blocker" }], assignee: null, created_at: "2026-10-18T10:00:00Z", html_url: "i12" };
      if (label === "P0") return json([p0, prLike]);
      if (label === "release-blocker") return json([p0, blockerOnly]);
      return json([]);
    }

    if (p === "/repos/acme/web/releases") return json([{ draft: true, tag_name: "v4.12.0", name: "4.12" }, { draft: false, tag_name: "v4.11.0", name: "4.11" }]);

    if (p === "/repos/limited/repo/compare/a...b") {
      res.writeHead(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790000000" });
      return res.end("{}");
    }

    res.writeHead(404);
    res.end("{}");
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  return { base, calls, close: () => new Promise((r) => server.close(r)) };
}
