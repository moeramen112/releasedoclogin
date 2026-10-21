// Builds one normalized snapshot from whichever sources are on.

import { fetchGithub } from "./sources/github.js";
import { fetchJira, jiraConfigured } from "./sources/jira.js";
import { demoSnapshot } from "./sources/fixture.js";

export async function buildSnapshot({ release, config, mode, env = process.env, deps = {} }) {
  if (mode === "demo") return demoSnapshot(release, deps.now);

  const sources = { github: "ok", jira: jiraConfigured(env) ? "ok" : "off" };
  const data = {};
  const errors = {};
  const blockers = [];
  const blockerErrors = [];

  const [gh, jira] = await Promise.all([
    (deps.fetchGithub || fetchGithub)({ release, config, token: env.GITHUB_TOKEN }),
    sources.jira === "ok"
      ? (deps.fetchJira || fetchJira)({ release, config, env }).then((v) => ({ value: v }), (e) => ({ error: e.message }))
      : Promise.resolve(null),
  ]);

  Object.assign(data, gh.data);
  Object.assign(errors, gh.errors);
  if (gh.data.blockers) blockers.push(...gh.data.blockers);
  if (gh.errors.blockers) blockerErrors.push(`GitHub: ${gh.errors.blockers}`);

  if (jira?.value) blockers.push(...jira.value);
  if (jira?.error) { sources.jira = "error"; blockerErrors.push(`Jira: ${jira.error}`); }

  const order = { P0: 0, P1: 1, P2: 2 };
  data.blockers = blockers.sort((a, b) => order[a.sev] - order[b.sev] || b.ageDays - a.ageDays);
  if (blockerErrors.length) errors.blockers = blockerErrors.join(" ");
  else delete errors.blockers;

  // If every GitHub call failed, say so; the criteria already show pending with the reasons.
  if (!Object.keys(gh.data).length) sources.github = "error";

  return { generatedAt: new Date().toISOString(), mode: "live", release, sources, errors, data };
}
