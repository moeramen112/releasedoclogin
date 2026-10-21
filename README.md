# Release Readiness (team edition, with sign-in)

A go/no-go tool for release managers. It answers one question, "can we ship?", from the data you already have, and it keeps a record of who accepted which risk.

This edition is built for a team. Only people you invite can open it, each person has a role, and releases are saved on the server so everyone sees the same ones. The single-user version is at https://github.com/moeramen112/releasedoc.

![Dashboard](docs/dashboard.png)

## The problem

Before a release, someone collects status by hand from the issue tracker, CI, the security scanner and a dozen Slack threads, then argues about whether it is safe to ship. The answer is in a spreadsheet nobody trusts and a meeting nobody enjoys. This tool puts that answer in one place, computed from the same rules every time, with the reasons attached.

## What it does

**Dashboard (`/`)** reads a real release from GitHub (and Jira, if configured) and shows a Go, Hold or No-Go call with the criteria behind it.

**Planner (`/plan.html`)** is for entering a release by hand, or pulling its Jira tickets and story points. It produces:

- the same go/no-go call, using the same engine
- a risk score out of 100 with a breakdown by factor, plain-language recommendations, and a suggested staged rollout
- a story-point forecast: points done, points remaining, and whether the team's velocity can finish before the freeze
- a runbook, prefilled from the dates, owners and rollout strategy
- a dependency view: what is waiting on what, what to finish first, and which handoffs between teams are late
- a release brief in Markdown (who, what, when, where, how, dependencies, risk, criteria, runbook) to paste into Slack or Confluence

![Planner](docs/planner.png)

## Dependencies: what waits on what

Some work cannot start until other work is done: the frontend waits for the backend, QA waits for the merge, tickets cannot be written until the designs are handed over. Two things in the planner capture this.

- **Team and Blocked by** on each ticket. Name the team doing the work, and list the tickets that must be Done first, separated by commas (for example `REL-2841, REL-2790`).
- **Handoffs between teams**, a table below the tickets. Each row is something one team hands to another (a name, who from, who to, an owner, a due date, a status) and the tickets it blocks. Ticket keys in these lists are not case sensitive.

From that the planner shows, in a Dependencies panel and in the release brief:

- tickets that are **waiting**, and on what
- the **longest chain** that has to happen in order
- the tickets to **finish first**, ranked by how many others they hold up
- work **started before its input was done** (in progress or in review while the blocker is open)
- tickets that are **ready to start now**
- **handoffs to chase**: overdue, blocked, or due after the code freeze
- **circular dependencies**, where tickets wait on each other so none can start

It adds a **Dependencies clear** check to go/no-go (advisory by default; a release can make it required) and a Dependencies factor to the risk score. A blocker that is not in this release's ticket list counts as unresolved, and the Blocked by box is highlighted. **Pull from Jira** fills Blocked by from Jira "is blocked by" links, and **Refresh from Jira** keeps what you typed. I tested the Jira links against a mock, not a live Jira.

## Using it for every release

The planner keeps a library of releases, so each new release starts clean and the old ones stay available.

| Button | What it does |
|---|---|
| **New release** | An empty release with sensible defaults: a Tuesday 2 AM deploy at least a week out, freeze and go/no-go dates before it, the sign-offs for the release type, and a runbook. Everything unknown shows as pending, so a new release can never read GO by accident. |
| **Start next release** | The usual way to begin the next release in a series. Keeps the people, repository, environments, rollout and rollback settings, budgets and which sign-offs are needed. Clears the name, dates, tickets, quality signals, checks, approvals and waivers. |
| **Duplicate** | An exact copy, for trying a what-if. |
| **Delete** | Removes the release, with an Undo. |
| **Load example** | Adds the invented example release, for demos. |
| **Import** | Adds a release from a plan file saved with Export plan. |

Pick a release from the list at the top to switch. Each release shows its current call and risk score in the list.

Releases are saved on the server, so everyone signed in sees the same list. The page checks for changes by other people every 20 seconds and never replaces what you are typing. **Export plan** and **Import** still work for backups and for moving a release between servers. The single-file copy saves in the browser only.

Per-release criteria are already supported by the engine: a release can switch a criterion off, make it advisory, or add its own checks that a person confirms. There is no screen for it yet, so today that is set in the plan file.

## Sign-in, roles and privacy

![People page, where admins invite people and set roles](docs/people.png)

**Invite only.** There is no sign-up page. An admin adds an email and a role, and the person gets a one-time link to choose their own password. The link works once and expires in 7 days.

| Role | Can do |
|---|---|
| **Viewer** | Read the dashboard, planner and releases. Cannot change anything. |
| **Editor** | Everything a viewer can, plus create and edit releases, sign off, waive, mark checks, post to Slack, pull from Jira. |
| **Admin** | Everything an editor can, plus invite people, change roles, turn people off. |

What is in place:

- Passwords are stored as scrypt hashes. The server never keeps a password it could read back.
- Sessions are signed cookies (HttpOnly, SameSite=Strict, Secure over https) that last 12 hours. Changing a password, or turning a person off, ends their sessions at once.
- Five wrong passwords for one email from one address lock that pair for 15 minutes. The same wrong-password message is given for unknown emails.
- Every page and every API call needs a session, except the sign-in and invite pages. The role is checked on the server for each call, so hiding a button is never the only protection.
- The name on a waiver, a manual check or a Slack post is the signed-in person. It cannot be typed in.
- Two people cannot overwrite each other. Saving a release names the version you started from. If someone saved first, your save is refused and you can load their version or keep yours as a copy.
- There is always at least one active admin.
- Jira and GitHub tokens stay on the server.

Not included yet: single sign-on (Okta, Google, Microsoft), password reset by email (an admin sends a new invite link instead), two-factor sign-in, and a log of every edit to a release (the audit log records creates, deletes, waivers and checks). See "Limits".

## Run it on your computer

Needs Node 20 or newer. No dependencies to install.

```bash
git clone https://github.com/moeramen112/releasedoclogin.git
cd releasedoclogin
npm run try          # demo data, no sign-in, this computer only
```

Open http://localhost:3000. `npm run try` turns sign-in off and refuses to do so on any address except your own computer. It is for looking around.

To run it with sign-in, as your team would:

```bash
# Mac or Linux
ADMIN_EMAIL=you@yourcompany.com npm start
# Windows PowerShell
$env:ADMIN_EMAIL="you@yourcompany.com"; npm start
```

The first start prints a link in the terminal. Open it, choose your password, and you are the admin. Then open **People** to invite everyone else. Add `--demo` to use invented dashboard data.

## Run it for a team

1. Run it on a computer that stays on and that your team can reach: a company server, or a small hosting account your IT approves. Do not put real company data on a personal hosting account without asking IT.
2. Put it behind https. Most hosts do this for you. Set `COOKIE_SECURE=1`, and `TRUST_PROXY=1` if a proxy in front of the server adds `x-forwarded-proto`.
3. Set these before starting:

| Variable | Why |
|---|---|
| `ADMIN_EMAIL` | Creates the first admin on first start. |
| `PUBLIC_URL` | The address people use, so invite links are right. |
| `HOST=0.0.0.0` | Listen on the network. The default is this computer only. |
| `STATE_DIR` | A folder that survives restarts (a persistent disk). Users, releases and audit logs live here. |
| `COOKIE_SECURE=1`, `TRUST_PROXY=1` | For https behind a proxy. |

4. Back up the `STATE_DIR` folder. It holds everything, including the password hashes, so keep it private.
5. Many hosts erase files on every restart unless you attach a persistent disk. Check this first, or people will lose their accounts and releases.

I have run it locally and tested the sign-in, roles and saving with browser tests. I have not deployed it to a hosting service.

The single-file copy (`dist/release-planner.standalone.html`) is separate: it has no sign-in and saves in the browser only.

## Connect your tools

Copy `.env.example` and set what you have. Everything is optional.

| Variable | What it enables |
|---|---|
| `GITHUB_TOKEN` | Higher rate limit and private repositories. Public repositories work without it. |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | Open P0/P1 issues on the dashboard, and **Pull from Jira** in the planner (tickets plus story points). |
| `SLACK_WEBHOOK_URL` | **Post to Slack** sends the current call and what is holding the release. |

Edit `readiness.config.json` to change the repository, release branch, label names, JQL, the Jira story-points field (`customfield_10016` on most sites, but it varies), and the list of criteria.

## How it works

```
GitHub ─┐
Jira ───┼─► snapshot ─► engine ─► verdict + criteria ─► dashboard
Form ───┘   (one shape)  (pure)                         planner, brief, Slack
                          ▲
              waivers and manual checks (the audit log)
```

- **One engine.** Every source is normalised to one snapshot shape, and a pure function turns a snapshot plus the config into criteria and a verdict. The server and the browser run the same file, so the dashboard and the planner cannot disagree.
- **Missing data never passes.** If GitHub rate-limits a call or Jira is down, the affected criterion shows as pending with the reason, and the release cannot read GO.
- **Waivers are accountable.** Accepting a risk needs a named approver and a reason. A waiver stops applying if the criterion gets worse afterwards, and every change goes to an audit log.
- **Criteria are config.** Which checks count, whether they are required, and how strict they are all live in the config, not in code.
- **Tokens stay on the server.** The browser never sees them. Changes require a custom header and a same-origin request, so another web page cannot post to a dashboard running on localhost.

## The risk model

Thirteen factors, weighted to add up to 100. The weights are in `src/risk.js` and each has a test.

| Factor | Max | What drives it |
|---|---|---|
| Open defects | 16 | P0 bugs 10 each, P1 4, P2 1 |
| Unfinished scope | 14 | Share of story points not done, plus a penalty if velocity cannot finish before the freeze or work is open after it |
| Data migration | 9 | In scope and not dry-run on production-size data |
| Rollback readiness | 7 | Not rehearsed, no written plan, or a target over 30 minutes |
| Dependencies between work | 6 | Tickets waiting on other work, work started before its input was done, overdue or blocked handoffs, long chains, circular dependencies |
| Test and security health | 8 | Real failing checks, quarantined failures, coverage, p95 latency, vulnerabilities |
| Size of the change | 7 | Files and lines against a budget |
| Late and unreviewed changes | 7 | Merged after the freeze, merged without an approval |
| Deploy timing | 7 | Friday, weekend, business hours, long windows |
| Payments, auth and data changes | 6 | Open tickets in sensitive areas count most, missing tests count extra |
| Large tickets still open | 5 | Tickets over a point threshold that are not done |
| Rollout strategy | 5 | All-at-once is worst, canary with flags that default off is best |
| Unestimated tickets | 3 | Open work with no story points |

Levels: under 25 Low, under 50 Moderate, under 75 High, otherwise Critical. Each level suggests a rollout ladder: for example Low is 10%, 50%, 100% with a 15 minute bake, and High starts at 1% with an hour at each stage.

## Layout

```
src/engine.js      criteria evaluators, waivers, verdict (pure)
src/risk.js        story points, forecast, risk score (pure)
src/deps.js        what waits on what: blockers, handoffs, cycles, chains (pure)
src/plan.js        the plan, templates, runbook generator, brief (pure)
src/sources/       GitHub, Jira, and demo-data adapters
src/server.js      HTTP server and JSON API
src/auth.js        accounts, sessions, invites, roles (no dependencies)
public/            dashboard, planner, sign-in, people (plain JS, no build step)
test/              99 tests, including a mock GitHub and a mock Jira
scripts/           build-standalone.mjs makes the single-file planner
```

## Limits to know about

- State is JSON files in the data folder. Writes are queued and atomic, which is fine for a team of tens. It is not built for hundreds of people editing at once.
- Sign-in is email and password only. No single sign-on, no two-factor, no password reset by email. A forgotten password means an admin sends a new invite link.
- The server speaks plain HTTP. For anything beyond your own computer, put it behind https.
- A release plan is saved as a whole, so two people editing the same release at the same time get a conflict message, not a merge.
- Someone with view-only access can still change the page in their own browser. The server refuses to save it.
- The Jira search uses the current `/rest/api/3/search/jql` endpoint and the story-points field name must be set for your site. I tested it against a mock, not a live Jira.
- Scores are a starting point for a conversation. The weights are opinions, and they are easy to change.

## Where it goes next

1. Read CI status from the CI provider directly, and map it to the release branch automatically.
2. Learn the weights from history: which factors preceded a rollback or an incident.
3. Post to Slack on a schedule, and when a criterion changes state.
4. Per-team criteria sets, and a record of every release for trend reporting.

## Demo script (three minutes)

1. **The problem (20 seconds).** "Release readiness lives in people's heads and in five tools. Someone assembles it by hand before every go/no-go."
2. **The dashboard (60 seconds).** Open `/` in demo mode. Point at the NO-GO and the three reasons under it. "Everything on the right is computed, nothing is typed in." Click Waive on a failing criterion, show that it demands a named approver and a reason, and show the audit log.
3. **The planner (60 seconds).** Open `/plan.html`. Change the P0 ticket to Done and watch the call and risk score move. Change the deploy time to a Friday afternoon and show the timing risk. Clear all tickets, then Undo.
4. **The brief (20 seconds).** Copy Markdown and show it is a complete release document.
5. **The design choice (20 seconds).** "If a data source is down, that criterion is pending, not passing. A tool that says GO when it cannot see is worse than no tool."

Questions to expect: why these weights (opinions with tests, meant to be tuned), what about monorepos or many services (one release per config today, and the per-team config is the next step), how it would connect to your systems (adapters return one shape, so a new source is one file).


## Auto-refresh and Slack alerts

Open a release, find **What is shipping**, and tick:

- **Refresh from Jira every few minutes**: the server pulls the fix version on its own (every `SYNC_MINUTES`, default 5), even when nobody has the page open. Needs the Jira settings and a fix version.
- **Post to Slack when the go/no-go call changes**: the server checks each release every minute. When the call changes (say GO to HOLD) and stays changed for `ALERT_SETTLE_MINUTES` (default 2), it posts one message naming both calls and what is holding. Needs `SLACK_WEBHOOK_URL`. The first look at a release never alerts, and a call that flips back before the wait ends sends nothing.

The planner shows when the last refresh happened and any error. The dashboard has an **Auto-refresh every minute** box that only re-reads while the page is open.

The jobs run only while the server is running. On your laptop that means while it is on. For always-on alerts, host it (see above).


## Release docs

In the planner, the **Release brief** panel has:

- **Copy for Docs**: paste into Google Docs, Word, Confluence or Notion with headings and tables kept.
- **Word (.doc)**: opens in Word.
- **Printable page**: open it, press Print, choose Save as PDF.
- **Status one-pager**: just the call, dates and risks, for leadership.
- **.md** and **Copy Markdown**: plain text.
