// Demo data. Same shape as the live sources, so the engine and UI cannot tell the difference.
// Everything here is invented.

export function demoSnapshot(release, now = Date.now()) {
  const day = 86400000;
  const iso = (daysAgo) => new Date(now - daysAgo * day).toISOString();
  const freeze = Date.parse(release.freezeDate);

  const mergedPrs = Array.from({ length: 28 }, (_, i) => ({
    number: 4400 + i,
    title: `Change ${i + 1} for ${release.name}`,
    author: ["dana", "priya", "marcus", "lee", "ana", "jo"][i % 6],
    mergedAt: new Date(freeze - (28 - i) * 3600000 * 5).toISOString(),
    approved: i !== 7 && i !== 19,
    url: "#",
  }));
  // Three PRs landed after the freeze.
  [25, 26, 27].forEach((i, n) => { mergedPrs[i].mergedAt = new Date(freeze + (n + 1) * 3600000 * 9).toISOString(); });

  return {
    generatedAt: new Date(now).toISOString(),
    mode: "demo",
    release,
    sources: { github: "ok", jira: "ok" },
    errors: {},
    data: {
      compare: { commits: 142, filesChanged: 318, truncated: false, additions: 9120, deletions: 3480, authors: 23 },
      ci: {
        total: 1546, passed: 1540,
        failed: ["integration / sync-retry (quarantine)", "e2e / checkout-flaky (quarantine)", "e2e / search-flaky (quarantine)", "integration / webhooks-flaky (quarantine)", "integration / export-flaky (quarantine)", "integration / email-flaky (quarantine)"],
        pending: [],
      },
      mergedPrs,
      openPrs: [
        { number: 4471, title: "Bump http-parse to 3.1.9 (CVE fix)", author: "tomas", draft: false, checks: "passing", review: "review_required", ageDays: 1, url: "#" },
        { number: 4463, title: "Orders: batch backfill for migration 0412", author: "marcus", draft: false, checks: "failing", review: "changes_requested", ageDays: 2, url: "#" },
        { number: 4458, title: "Release notes: customer-facing copy", author: "ana", draft: true, checks: "passing", review: "draft", ageDays: 2, url: "#" },
      ],
      blockers: [
        { key: "REL-2841", sev: "P0", title: "Checkout total wrong for multi-currency carts", owner: "Dana K.", ageDays: 3, status: "In review", url: "#", source: "jira" },
        { key: "REL-2790", sev: "P1", title: "Migration 0412 holds a lock on orders for 38s on prod-size data", owner: "Marcus T.", ageDays: 5, status: "Fix merged, re-running", url: "#", source: "jira" },
        { key: "#4452", sev: "P1", title: "Android push token refresh crashes on OS 14+", owner: "priya", ageDays: 2, status: "Assigned", url: "#", source: "github" },
        { key: "#4466", sev: "P2", title: "Settings tooltip clipped in Safari 17", owner: "Unassigned", ageDays: 1, status: "Open", url: "#", source: "github" },
      ],
      draftRelease: { exists: false },
      signoffs: [
        { role: "QA", approved: true },
        { role: "Product", approved: true },
        { role: "Security", approved: false },
        { role: "SRE on-call", approved: false },
      ],
    },
  };
}

/** Starting state for demo mode: three manual checks, one failing, so the demo shows a NO-GO. */
export const DEMO_SEED = {
  manual: {
    migration: { state: "fail", by: "Marcus T.", note: "Lock held 38s, budget is 5s.", at: "2026-10-19T12:40:00Z" },
    rollback: { state: "pass", by: "Hiro N.", note: "Rolled back in 4m 12s on staging.", at: "2026-10-18T20:10:00Z" },
    errorbudget: { state: "pass", by: "Hiro N.", note: "62% remaining.", at: "2026-10-19T13:00:00Z" },
  },
};
