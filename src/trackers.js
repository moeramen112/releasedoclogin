// Ticket trackers: where a release's tickets come from.
//
// A tracker is a small object. Anything with this shape plugs in; nothing else in the app needs to change:
//   id            short name used in URLs and config, e.g. "jira"
//   label         what people see, e.g. "Jira"
//   versionLabel  what the tracker calls a release, e.g. "fix version"
//   needs         the settings it wants, shown when they are missing, e.g. "JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN"
//   configured(env)                          true when those settings are present
//   fetchTickets({ version, config, env })   resolves to tickets in the planner's shape (see src/import.js for the fields)
//
// To add a tracker: write that object, then pass it in `deps.trackers` to createApp, or add it to BUILT_IN below.
// A tracker that has no API can still be used: export a spreadsheet and use Import in the planner (src/import.js).

import { jiraConfigured, fetchJiraRelease } from "./sources/jira.js";

export const jiraTracker = {
  id: "jira",
  label: "Jira",
  versionLabel: "fix version",
  needs: "JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN",
  configured: jiraConfigured,
  fetchTickets: (args) => fetchJiraRelease(args),
};

const BUILT_IN = [jiraTracker];

const REQUIRED = ["id", "label", "needs"];

/** Throws a plain message when an object is not a usable tracker. */
export function checkTracker(t) {
  if (!t || typeof t !== "object") throw new Error("A tracker must be an object.");
  for (const k of REQUIRED) if (typeof t[k] !== "string" || !t[k]) throw new Error(`Tracker is missing "${k}".`);
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(t.id)) throw new Error(`Tracker id "${t.id}" must be lowercase letters, digits and dashes.`);
  if (typeof t.configured !== "function") throw new Error(`Tracker "${t.id}" needs a configured(env) function.`);
  if (typeof t.fetchTickets !== "function") throw new Error(`Tracker "${t.id}" needs a fetchTickets(args) function.`);
  return t;
}

/** A lookup of trackers by id. `extra` adds to (or replaces) the built-in ones. */
export function createTrackers(extra = []) {
  const all = new Map();
  for (const t of [...BUILT_IN, ...extra]) all.set(checkTracker(t).id, { versionLabel: "version", ...t });
  return {
    get: (id) => all.get(String(id || "jira")) || null,
    /** What the pages need to know about each tracker. Never includes secrets. */
    list: (env = process.env) => [...all.values()].map((t) => ({ id: t.id, label: t.label, versionLabel: t.versionLabel, needs: t.needs, configured: Boolean(t.configured(env)) })),
  };
}
