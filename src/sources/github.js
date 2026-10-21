// GitHub adapter. Talks to the REST API and returns the normalized slices the engine reads.
// Every slice is fetched independently, so one failing call degrades one criterion
// instead of the whole dashboard.

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function createClient({ token, baseUrl = process.env.GITHUB_API_URL || "https://api.github.com", fetchImpl = fetch } = {}) {
  async function request(path, query = {}) {
    const url = new URL(baseUrl.replace(/\/$/, "") + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    return send(url.toString());
  }

  async function send(url) {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "release-readiness",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20000) });
    if (res.ok) return res;
    const remaining = res.headers.get("x-ratelimit-remaining");
    if ((res.status === 403 || res.status === 429) && remaining === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const when = reset ? ` Resets ${new Date(reset * 1000).toISOString()}.` : "";
      throw new GitHubError(`GitHub rate limit reached.${token ? "" : " Set GITHUB_TOKEN to raise it."}${when}`, res.status);
    }
    if (res.status === 404) throw new GitHubError(`Not found. Check the repository and ref names${token ? " and the token's access" : ", or set GITHUB_TOKEN for private repositories"}.`, 404);
    if (res.status === 401) throw new GitHubError("GitHub rejected the token (401).", 401);
    throw new GitHubError(`GitHub returned ${res.status}.`, res.status);
  }

  /** Follow Link: rel="next" up to maxPages. itemsKey is for responses like { check_runs: [...] }. */
  async function paginate(path, query = {}, { maxPages = 5, itemsKey } = {}) {
    const out = [];
    let res = await request(path, { per_page: 100, ...query });
    for (let page = 1; ; page++) {
      const body = await res.json();
      out.push(...(itemsKey ? body[itemsKey] || [] : body));
      const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") || "");
      if (!next || page >= maxPages) break;
      res = await send(next[1]);
    }
    return out;
  }

  async function json(path, query) {
    return (await request(path, query)).json();
  }

  return { request, paginate, json };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

const refPath = (ref) => ref.split("/").map(encodeURIComponent).join("/");
const daysSince = (iso, now) => Math.max(0, Math.floor((now - Date.parse(iso)) / 86400000));

/** Turn check runs and commit statuses into one list of { name, outcome }. */
export function normalizeChecks(runs = [], statuses = []) {
  const out = [];
  for (const r of runs) {
    let outcome;
    if (r.status !== "completed") outcome = "pending";
    else if (["success", "neutral", "skipped"].includes(r.conclusion)) outcome = "pass";
    else outcome = "fail";
    out.push({ name: r.name, outcome });
  }
  for (const s of statuses) {
    const outcome = s.state === "success" ? "pass" : s.state === "pending" ? "pending" : "fail";
    out.push({ name: s.context, outcome });
  }
  return out;
}

export function summarizeChecks(checks) {
  return {
    total: checks.length,
    passed: checks.filter((c) => c.outcome === "pass").length,
    failed: checks.filter((c) => c.outcome === "fail").map((c) => c.name),
    pending: checks.filter((c) => c.outcome === "pending").map((c) => c.name),
  };
}

async function checksFor(client, repo, sha) {
  const [runs, status] = await Promise.all([
    client.paginate(`/repos/${repo}/commits/${sha}/check-runs`, {}, { itemsKey: "check_runs", maxPages: 3 }),
    client.json(`/repos/${repo}/commits/${sha}/status`),
  ]);
  return normalizeChecks(runs, status.statuses || []);
}

/** latest non-comment review per person decides */
export function reviewState(reviews) {
  const latest = new Map();
  for (const r of reviews) {
    if (!r.user || r.state === "COMMENTED" || r.state === "PENDING") continue;
    if (r.state === "DISMISSED") latest.delete(r.user.login);
    else latest.set(r.user.login, r.state);
  }
  const states = [...latest.values()];
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
  if (states.includes("APPROVED")) return "approved";
  return "review_required";
}

function severityOf(labels, cfg) {
  const names = labels.map((l) => (typeof l === "string" ? l : l.name).toLowerCase());
  const has = (list = []) => list.some((x) => names.includes(x.toLowerCase()));
  if (has(cfg.p0)) return "P0";
  if (has(cfg.p1)) return "P1";
  if (has(cfg.p2)) return "P2";
  return cfg.defaultBlockerSeverity || "P1";
}

export async function fetchGithub({ release, config, token, client = createClient({ token }), now = Date.now() }) {
  const repo = release.repo;
  const data = {};
  const errors = {};
  const labelCfg = config.labels || {};

  async function slice(key, fn) {
    try { data[key] = await fn(); }
    catch (e) { errors[key] = e.message; }
  }

  await Promise.all([
    slice("compare", async () => {
      const c = await client.json(`/repos/${repo}/compare/${refPath(release.baseRef)}...${refPath(release.headRef)}`);
      const files = c.files || [];
      const authors = new Set((c.commits || []).map((x) => x.author?.login || x.commit?.author?.name).filter(Boolean));
      return {
        commits: c.total_commits ?? c.ahead_by ?? 0,
        filesChanged: files.length,
        truncated: files.length >= 300,
        additions: files.reduce((n, f) => n + (f.additions || 0), 0),
        deletions: files.reduce((n, f) => n + (f.deletions || 0), 0),
        authors: authors.size,
      };
    }),

    slice("ci", async () => summarizeChecks(await checksFor(client, repo, refPath(release.headRef)))),

    slice("mergedPrs", async () => {
      const closed = await client.paginate(`/repos/${repo}/pulls`, { state: "closed", base: release.headRef, sort: "updated", direction: "desc" }, { maxPages: 3 });
      const merged = closed.filter((p) => p.merged_at).slice(0, 60);
      return mapLimit(merged, 6, async (p) => {
        const reviews = await client.paginate(`/repos/${repo}/pulls/${p.number}/reviews`, {}, { maxPages: 2 });
        return {
          number: p.number,
          title: p.title,
          author: p.user?.login || "unknown",
          mergedAt: p.merged_at,
          approved: reviewState(reviews) === "approved",
          url: p.html_url,
        };
      });
    }),

    slice("openPrs", async () => {
      const open = await client.paginate(`/repos/${repo}/pulls`, { state: "open", base: release.headRef }, { maxPages: 2 });
      return mapLimit(open.slice(0, 30), 6, async (p) => {
        const [checks, reviews] = await Promise.all([
          checksFor(client, repo, p.head.sha).catch(() => []),
          client.paginate(`/repos/${repo}/pulls/${p.number}/reviews`, {}, { maxPages: 1 }),
        ]);
        const sum = summarizeChecks(checks);
        return {
          number: p.number,
          title: p.title,
          author: p.user?.login || "unknown",
          draft: Boolean(p.draft),
          checks: !sum.total ? "none" : sum.failed.length ? "failing" : sum.pending.length ? "pending" : "passing",
          review: p.draft ? "draft" : reviewState(reviews),
          ageDays: daysSince(p.created_at, now),
          url: p.html_url,
        };
      });
    }),

    slice("blockers", async () => {
      const labels = [...new Set([...(labelCfg.blocker || []), ...(labelCfg.p0 || []), ...(labelCfg.p1 || [])])];
      const seen = new Map();
      await Promise.all(labels.map(async (label) => {
        const issues = await client.paginate(`/repos/${repo}/issues`, { state: "open", labels: label }, { maxPages: 2 });
        for (const i of issues) {
          if (i.pull_request) continue;
          if (config.issues?.milestone && i.milestone?.title !== config.issues.milestone) continue;
          seen.set(i.number, i);
        }
      }));
      const order = { P0: 0, P1: 1, P2: 2 };
      return [...seen.values()]
        .map((i) => ({
          key: `#${i.number}`,
          sev: severityOf(i.labels || [], labelCfg),
          title: i.title,
          owner: i.assignee?.login || "Unassigned",
          ageDays: daysSince(i.created_at, now),
          status: i.assignee ? "Assigned" : "Open",
          url: i.html_url,
          source: "github",
        }))
        .sort((a, b) => order[a.sev] - order[b.sev] || b.ageDays - a.ageDays);
    }),

    slice("draftRelease", async () => {
      const releases = await client.json(`/repos/${repo}/releases`, { per_page: 30 });
      const exists = releases.some((r) => r.draft && (r.tag_name === release.tag || r.name === release.name));
      return { exists };
    }),

    ...(config.signoffs?.issue ? [slice("signoffs", async () => {
      const issue = await client.json(`/repos/${repo}/issues/${config.signoffs.issue}`);
      const names = new Set((issue.labels || []).map((l) => (typeof l === "string" ? l : l.name).toLowerCase()));
      return config.signoffs.roles.map((r) => ({ role: r.role, approved: names.has(r.label.toLowerCase()) }));
    })] : []),
  ]);

  return { data, errors };
}
