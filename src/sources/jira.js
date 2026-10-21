// Jira Cloud adapter. Pulls unresolved high-priority issues for the release version
// and maps them to the same shape GitHub blockers use.

const DEFAULT_PRIORITY_MAP = { Highest: "P0", Blocker: "P0", Critical: "P0", High: "P1", Major: "P1", Medium: "P2", Low: "P2", Lowest: "P2" };

export function jiraConfigured(env = process.env) {
  return Boolean(env.JIRA_BASE_URL && env.JIRA_EMAIL && env.JIRA_API_TOKEN);
}

export function buildJql(template, release) {
  return template.replaceAll("{{version}}", String(release.jiraVersion || release.name).replace(/"/g, '\\"'));
}

/** Map a Jira status to the four the planner uses. Status category decides; "review" in the name splits In progress. */
export function mapStatus(status) {
  const cat = status?.statusCategory?.key;
  if (cat === "done") return "Done";
  if (cat === "new") return "To do";
  return /review|qa|test/i.test(status?.name || "") ? "In review" : "In progress";
}

const JIRA_TYPES = { Bug: "Bug", Task: "Task", "Sub-task": "Task", Story: "Story", Epic: "Story" };

/**
 * Every issue in the release's fix version, with story points, for the planner.
 * Story points live in a custom field whose id differs per Jira site: set jira.storyPointsField.
 */
export async function fetchJiraRelease({ version, config, env = process.env, fetchImpl = fetch, now = Date.now() }) {
  const base = env.JIRA_BASE_URL.replace(/\/$/, "");
  const auth = Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString("base64");
  const jira = config.jira || {};
  const pointsField = jira.storyPointsField || "customfield_10016";
  const map = { ...DEFAULT_PRIORITY_MAP, ...(jira.priorityMap || {}) };
  const jql = buildJql(jira.releaseJql || 'fixVersion = "{{version}}" ORDER BY priority DESC, key ASC', { jiraVersion: version });
  const areaFor = (f) => f.components?.[0]?.name || f.labels?.find((l) => l.startsWith("area-"))?.slice(5) || "Core";

  const issues = [];
  let nextPageToken;
  for (let page = 0; page < 5; page++) {
    const res = await fetchImpl(`${base}/rest/api/3/search/jql`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jql, fields: ["summary", "priority", "assignee", "status", "issuetype", "components", "labels", pointsField], maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) }),
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 401 || res.status === 403) throw new Error(`Jira rejected the credentials (${res.status}).`);
    if (!res.ok) throw new Error(`Jira returned ${res.status}. Check the fix version and releaseJql in readiness.config.json.`);
    const body = await res.json();
    issues.push(...(body.issues || []));
    nextPageToken = body.nextPageToken;
    if (!nextPageToken || body.isLast) break;
  }

  return issues.map((i) => {
    const f = i.fields;
    const labels = (f.labels || []).map((l) => l.toLowerCase());
    return {
      key: i.key,
      summary: f.summary,
      type: JIRA_TYPES[f.issuetype?.name] || "Task",
      priority: map[f.priority?.name] || "P2",
      points: Number(f[pointsField]) || 0,
      status: mapStatus(f.status),
      assignee: f.assignee?.displayName || "Unassigned",
      area: areaFor(f),
      tags: { migration: labels.includes("migration"), customerFacing: labels.includes("customer-facing"), untested: labels.includes("needs-tests") },
    };
  });
}

export async function fetchJira({ release, config, env = process.env, fetchImpl = fetch, now = Date.now() }) {
  const base = env.JIRA_BASE_URL.replace(/\/$/, "");
  const auth = Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString("base64");
  const jira = config.jira || {};
  const jql = buildJql(jira.jql || 'fixVersion = "{{version}}" AND resolution = Unresolved AND priority in (Highest, High)', release);
  const map = { ...DEFAULT_PRIORITY_MAP, ...(jira.priorityMap || {}) };

  const res = await fetchImpl(`${base}/rest/api/3/search/jql`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jql, fields: ["summary", "priority", "assignee", "created", "status"], maxResults: 100 }),
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 401 || res.status === 403) throw new Error(`Jira rejected the credentials (${res.status}).`);
  if (!res.ok) throw new Error(`Jira returned ${res.status}. Check the JQL in readiness.config.json.`);
  const body = await res.json();

  return (body.issues || []).map((i) => ({
    key: i.key,
    sev: map[i.fields.priority?.name] || "P2",
    title: i.fields.summary,
    owner: i.fields.assignee?.displayName || "Unassigned",
    ageDays: Math.max(0, Math.floor((now - Date.parse(i.fields.created)) / 86400000)),
    status: i.fields.status?.name || "Open",
    url: `${base}/browse/${i.key}`,
    source: "jira",
  }));
}
