// HTTP server: serves the dashboard and a small JSON API.
// Tokens stay on the server. The browser never sees them.

import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evaluate, openBlockerCount } from "./engine.js";
import { buildSnapshot } from "./snapshot.js";
import { createStore, createJsonStore, auditEntry } from "./state.js";
import { createAuth, roleAllows } from "./auth.js";
import { DEMO_SEED } from "./sources/fixture.js";
import { jiraConfigured, fetchJiraRelease } from "./sources/jira.js";
import { createJobs } from "./jobs.js";
import { buildSlackMessage, sendSlack } from "./notify.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };
const CACHE_MS = 60_000;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const REF_RE = /^[\w./@+-]{1,200}$/;
const RELEASE_RE = /^\/api\/releases\/([a-z0-9-]{3,64})$/;
const PUBLIC_API = new Set(["GET /api/health", "GET /api/auth/status", "POST /api/auth/login", "POST /api/auth/accept"]);
const PUBLIC_FILES = new Set(["/login.html", "/invite.html", "/login.js", "/styles.css"]);
// Who may call what. Anything not listed needs only a signed-in user (viewer).
const NEEDS = { "POST /api/waive": "editor", "POST /api/unwaive": "editor", "POST /api/manual": "editor", "POST /api/notify": "editor", "GET /api/jira/issues": "editor", "GET /api/admin/users": "admin", "POST /api/admin/users": "admin", "POST /api/admin/users/reinvite": "admin", "POST /api/admin/users/update": "admin" };
const SECURITY_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" };
const LOCAL_USER = { email: "local", name: "Local user", role: "admin" };
const MAX_RELEASES = 500;
const PLAN_BYTES = 900_000;

/** Demo mode: DEMO=1 in the environment, or the --demo flag, which also works on Windows. */
const isDemo = () => process.env.DEMO === "1" || process.argv.includes("--demo");

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function createApp({ configPath = path.join(ROOT, "readiness.config.json"), stateDir = process.env.STATE_DIR || path.join(ROOT, "data"), defaultMode = isDemo() ? "demo" : "live", env = process.env, deps = {}, auth: authOn = true } = {}) {
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const auth = authOn === false ? null : await createAuth({ dir: stateDir, env });
  const relDb = await createJsonStore(path.join(stateDir, "releases.json"), () => ({ releases: {}, audit: [] }));
  const jobsDb = await createJsonStore(path.join(stateDir, "jobs.json"), () => ({ releases: {} }));
  const jobs = createJobs({ relDb, jobsDb, config, env, deps, log: (m) => console.error(m) });
  const stores = {};
  // Waivers, manual checks and the audit log belong to one release, so each repo and release branch gets its own file.
  const storeKey = ({ mode, release }) => (mode === "demo" ? "demo" : `live.${release.repo}@${release.headRef}`.toLowerCase().replace(/\//g, "__").replace(/[^a-z0-9@._-]+/g, "-"));
  const getStore = async (t) => {
    const key = storeKey(t);
    return (stores[key] ||= await createStore(path.join(stateDir, key === "demo" ? "state.demo.json" : `state.${key}.json`), t.mode === "demo" ? DEMO_SEED : undefined));
  };
  const cache = new Map();
  const manualIds = new Set(config.criteria.filter((c) => c.type === "manual").map((c) => c.params.checkId));

  /** Work out which release and mode a request is about. Overrides are validated. */
  function target(query) {
    const mode = query.get("demo") === "1" ? "demo" : query.get("demo") === "0" ? "live" : defaultMode;
    const release = { ...config.release };
    const repo = query.get("repo"), base = query.get("base"), head = query.get("head");
    if (repo) { if (!REPO_RE.test(repo)) throw new HttpError(400, "Repository must look like owner/name."); release.repo = repo; }
    if (base) { if (!REF_RE.test(base)) throw new HttpError(400, "Base ref has unsupported characters."); release.baseRef = base; }
    if (head) { if (!REF_RE.test(head)) throw new HttpError(400, "Head ref has unsupported characters."); release.headRef = head; }
    return { mode, release };
  }

  async function snapshotFor({ mode, release }, refresh) {
    const key = JSON.stringify([mode, release.repo, release.baseRef, release.headRef]);
    const hit = cache.get(key);
    if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.snapshot;
    const snapshot = await buildSnapshot({ release, config, mode, env, deps });
    cache.set(key, { at: Date.now(), snapshot });
    return snapshot;
  }

  async function payload(t, refresh = false) {
    const store = await getStore(t);
    const snapshot = await snapshotFor(t, refresh);
    const result = evaluate(snapshot, config, store.get());
    const key = `${t.mode}:${t.release.repo}@${t.release.headRef}`;
    const open = openBlockerCount(snapshot);
    await store.mutate((s) => {
      const last = [...s.history].reverse().find((h) => h.key === key);
      if (!last || last.call !== result.verdict.call || last.open !== open || Date.now() - Date.parse(last.t) > 600_000) {
        s.history.push({ key, t: new Date().toISOString(), call: result.verdict.call, open });
      }
    });
    const state = store.get();
    return {
      mode: t.mode,
      snapshot,
      result,
      history: state.history.filter((h) => h.key === key).slice(-60),
      audit: state.audit.slice(-25).reverse(),
      integrations: { github: Boolean(env.GITHUB_TOKEN), jira: jiraConfigured(env), slack: Boolean(env.SLACK_WEBHOOK_URL) },
    };
  }

  async function readBody(req, limit = 65536) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new HttpError(413, "Request body too large.");
      chunks.push(c);
    }
    try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; }
    catch { throw new HttpError(400, "Body must be JSON."); }
  }

  // Mutating routes need a custom header and a same-origin request, which blocks
  // a random web page from posting to a dashboard running on localhost.
  function guard(req) {
    if (req.headers["x-requested-with"] !== "release-readiness") throw new HttpError(403, "Missing X-Requested-With header.");
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, "Cross-origin request refused.");
  }

  const text = (v, max = 500) => String(v ?? "").trim().slice(0, max);
  // With sign-in on, the name on a waiver or a check is the signed-in person, never something typed.
  const who = (user, typed) => (auth ? user.name || user.email : text(typed, 80));
  const isSecure = (req) => Boolean(req.socket.encrypted) || env.COOKIE_SECURE === "1" || (env.TRUST_PROXY === "1" && req.headers["x-forwarded-proto"] === "https");
  const ipOf = (req) => (env.TRUST_PROXY === "1" && req.headers["x-forwarded-for"] ? String(req.headers["x-forwarded-for"]).split(",")[0].trim() : req.socket.remoteAddress) || "unknown";
  const originOf = (req) => (env.PUBLIC_URL ? env.PUBLIC_URL.replace(/\/+$/, "") : `${isSecure(req) ? "https" : "http"}://${req.headers.host}`);
  const inviteUrl = (req, { email, token }) => `${originOf(req)}/invite.html?email=${encodeURIComponent(email)}&token=${token}`;

  const routes = {
    "GET /api/config": async (req, url, user) => ({
      authEnabled: Boolean(auth),
      me: user,
      release: config.release,
      defaultMode,
      criteria: config.criteria.map(({ id, name, type, source, required, params }) => ({ id, name, type, source: source || "github", required: required !== false, checkId: type === "manual" ? params.checkId : undefined })),
      integrations: { github: Boolean(env.GITHUB_TOKEN), jira: jiraConfigured(env), slack: Boolean(env.SLACK_WEBHOOK_URL) },
    }),

    "GET /api/readiness": async (req, url) => payload(target(url.searchParams), url.searchParams.get("refresh") === "1"),

    // Tickets and story points for the planner. Needs JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN on the server.
    "GET /api/jira/issues": async (req, url) => {
      if (!jiraConfigured(env)) throw new HttpError(400, "Jira is not configured. Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN on the server.");
      const version = text(url.searchParams.get("version"), 80);
      if (!version) throw new HttpError(400, "Enter the Jira fix version first.");
      try {
        const issues = await (deps.fetchJiraRelease || fetchJiraRelease)({ version, config, env });
        return { version, issues };
      } catch (e) {
        throw new HttpError(502, e.message);
      }
    },

    "POST /api/waive": async (req, url, user) => {
      guard(req);
      const body = await readBody(req);
      const t = target(url.searchParams);
      const store = await getStore(t);
      const current = evaluate(await snapshotFor(t, false), config, store.get());
      const crit = current.criteria.find((c) => c.id === body.id);
      if (!crit) throw new HttpError(404, "Unknown criterion.");
      if (crit.status === "pass") throw new HttpError(400, "That criterion is passing, so there is nothing to waive.");
      const approver = who(user, body.approver), reason = text(body.reason, 400);
      if (!approver) throw new HttpError(400, "Name the person who approves this waiver.");
      if (reason.length < 8) throw new HttpError(400, "Give a reason of at least a few words.");
      await store.mutate((s) => {
        s.waivers[crit.id] = { approver, reason, at: new Date().toISOString(), statusAtWaive: crit.status };
        s.audit.push(auditEntry("waive", approver, `${crit.name} (${crit.status}): ${reason}`));
      });
      return payload(t);
    },

    "POST /api/unwaive": async (req, url, user) => {
      guard(req);
      const body = await readBody(req);
      const t = target(url.searchParams);
      const store = await getStore(t);
      const by = who(user, body.by);
      if (!by) throw new HttpError(400, "Say who is removing this waiver.");
      await store.mutate((s) => {
        if (!s.waivers[body.id]) throw new HttpError(404, "No waiver on that criterion.");
        delete s.waivers[body.id];
        s.audit.push(auditEntry("unwaive", by, `Removed waiver on ${body.id}`));
      });
      return payload(t);
    },

    "POST /api/manual": async (req, url, user) => {
      guard(req);
      const body = await readBody(req);
      const t = target(url.searchParams);
      const store = await getStore(t);
      if (!manualIds.has(body.checkId)) throw new HttpError(404, "Unknown manual check.");
      if (!["pass", "fail", "unset"].includes(body.state)) throw new HttpError(400, "State must be pass, fail or unset.");
      const by = who(user, body.by);
      if (body.state !== "unset" && !by) throw new HttpError(400, "Say who is confirming this check.");
      await store.mutate((s) => {
        if (body.state === "unset") delete s.manual[body.checkId];
        else s.manual[body.checkId] = { state: body.state, by, note: text(body.note, 300), at: new Date().toISOString() };
        s.audit.push(auditEntry("manual", by || "unknown", `${body.checkId} set to ${body.state}${body.note ? ": " + text(body.note, 300) : ""}`));
      });
      return payload(t);
    },

    // ---- accounts ----
    "GET /api/auth/status": async () => ({ authEnabled: Boolean(auth), hasUsers: auth ? auth.hasUsers() : true }),
    "GET /api/auth/me": async (req, url, user) => ({ signedIn: true, authEnabled: Boolean(auth), ...user }),
    "POST /api/auth/login": async (req, url, user, ctx) => {
      guard(req);
      if (!auth) throw new HttpError(400, "Sign-in is turned off.");
      const b = await readBody(req);
      const r = await auth.login({ email: b.email, password: b.password, ip: ipOf(req), secure: isSecure(req) });
      ctx.cookie = r.cookie;
      return { ok: true, user: r.user };
    },
    "POST /api/auth/accept": async (req, url, user, ctx) => {
      guard(req);
      if (!auth) throw new HttpError(400, "Sign-in is turned off.");
      const b = await readBody(req);
      const r = await auth.accept({ email: b.email, token: b.token, password: b.password, name: b.name, secure: isSecure(req) });
      ctx.cookie = r.cookie;
      return { ok: true, user: r.user };
    },
    "POST /api/auth/logout": async (req, url, user, ctx) => {
      guard(req);
      if (auth) ctx.cookie = auth.clearCookie(isSecure(req));
      return { ok: true };
    },
    "POST /api/auth/password": async (req, url, user, ctx) => {
      guard(req);
      if (!auth) throw new HttpError(400, "Sign-in is turned off.");
      const b = await readBody(req);
      ctx.cookie = await auth.changePassword(user, { current: b.current, next: b.next, secure: isSecure(req) });
      return { ok: true };
    },
    "GET /api/admin/users": async () => ({ users: auth ? auth.admin.list() : [] }),
    "POST /api/admin/users": async (req, url, user) => {
      guard(req);
      const b = await readBody(req);
      const r = await auth.admin.invite({ email: b.email, name: b.name, role: b.role }, user.email);
      return { email: r.email, inviteUrl: inviteUrl(req, r), users: auth.admin.list() };
    },
    "POST /api/admin/users/reinvite": async (req, url, user) => {
      guard(req);
      const b = await readBody(req);
      const r = await auth.admin.reinvite(b.email, user.email);
      return { email: r.email, inviteUrl: inviteUrl(req, r), users: auth.admin.list() };
    },
    "POST /api/admin/users/update": async (req, url, user) => {
      guard(req);
      const b = await readBody(req);
      if (String(b.email).toLowerCase() === user.email && (b.active === false || (b.role && b.role !== user.role))) throw new HttpError(400, "Ask another admin to change your own role or access.");
      await auth.admin.update(b.email, { role: b.role, active: b.active });
      return { users: auth.admin.list() };
    },

    // ---- releases (kept on the server so everyone sees the same ones) ----
    "GET /api/releases": async (req, url, user) => {
      const rels = Object.values(relDb.get().releases).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return { me: user, authEnabled: Boolean(auth), releases: rels };
    },

    // For the host to check the server is alive. Says nothing about your data.
    "GET /api/health": async () => ({ ok: true }),

    // When each release was last refreshed from Jira, and the last go/no-go call seen. Any signed-in person can read it.
    "GET /api/sync": async () => jobs.status(),

    "POST /api/notify": async (req, url, user) => {
      guard(req);
      const body = await readBody(req);
      if (!env.SLACK_WEBHOOK_URL) throw new HttpError(400, "Slack is not configured. Set SLACK_WEBHOOK_URL.");
      const t = target(url.searchParams);
      const data = await payload(t);
      const dashboardUrl = env.PUBLIC_URL || undefined;
      await (deps.sendSlack || sendSlack)(env.SLACK_WEBHOOK_URL, buildSlackMessage({ release: data.snapshot.release, result: data.result, dashboardUrl }));
      const store = await getStore(t);
      await store.mutate((s) => { s.audit.push(auditEntry("notify", who(user, body.by), `Posted ${data.result.verdict.call} to Slack`)); });
      return payload(t);
    },
  };

  // The browser runs the same pure modules as the server, so the planner and the dashboard cannot disagree.
  const SHARED = { "/engine.js": "engine.js", "/risk.js": "risk.js", "/plan.js": "plan.js", "/deps.js": "deps.js" };

  async function serveStatic(pathname, res) {
    const rel = pathname === "/" ? "/index.html" : pathname;
    const file = SHARED[rel] ? path.join(ROOT, "src", SHARED[rel]) : path.join(PUBLIC, path.normalize(rel));
    if (!SHARED[rel] && !file.startsWith(PUBLIC + path.sep)) throw new HttpError(404, "Not found.");
    try {
      const buf = await fs.readFile(file);
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache", ...SECURITY_HEADERS });
      res.end(buf);
    } catch { throw new HttpError(404, "Not found."); }
  }

  const validPlan = (p) => Boolean(p && typeof p === "object" && !Array.isArray(p) && Array.isArray(p.tickets) && p.release && typeof p.release === "object");

  /** GET, PUT and DELETE on one release. PUT carries the version the editor started from, so two people cannot silently overwrite each other. */
  function releaseHandler(method, id) {
    if (method === "GET") return async () => {
      const r = relDb.get().releases[id];
      if (!r) throw new HttpError(404, "No such release.");
      return r;
    };
    if (method === "PUT") return async (req, url, user) => {
      guard(req);
      const body = await readBody(req, PLAN_BYTES);
      if (!validPlan(body.plan)) throw new HttpError(400, "That is not a release plan.");
      const base = Number(body.baseVersion ?? 0);
      const by = user.name || user.email;
      return relDb.mutate((s) => {
        const cur = s.releases[id];
        if (!cur && Object.keys(s.releases).length >= MAX_RELEASES) throw new HttpError(400, "Too many releases. Delete old ones first.");
        if (cur && cur.version !== base) {
          const e = new HttpError(409, `${cur.updatedBy} changed this release after you opened it.`);
          e.current = { version: cur.version, updatedBy: cur.updatedBy, updatedAt: cur.updatedAt };
          throw e;
        }
        if (!cur && base !== 0) throw new HttpError(409, "This release was deleted by someone else.");
        const now = new Date().toISOString();
        const rec = { id, plan: { ...body.plan, id }, version: (cur?.version || 0) + 1, createdAt: cur?.createdAt || now, createdBy: cur?.createdBy || by, updatedAt: now, updatedBy: by };
        s.releases[id] = rec;
        if (!cur) s.audit.push(auditEntry("create", by, `Created ${rec.plan.release?.name || "Untitled release"}`));
        s.audit = s.audit.slice(-499);
        return { id, version: rec.version, updatedAt: rec.updatedAt, updatedBy: rec.updatedBy };
      });
    };
    if (method === "DELETE") return async (req, url, user) => {
      guard(req);
      const by = user.name || user.email;
      return relDb.mutate((s) => {
        const cur = s.releases[id];
        if (!cur) return { ok: true };
        delete s.releases[id];
        s.audit.push(auditEntry("delete", by, `Deleted ${cur.plan.release?.name || "Untitled release"}`));
        s.audit = s.audit.slice(-499);
        return { ok: true };
      });
    };
    return null;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const ctx = {};
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...(ctx.cookie ? { "Set-Cookie": ctx.cookie } : {}) });
      res.end(JSON.stringify(body));
    };
    try {
      const user = auth ? auth.userFor(req) : LOCAL_USER;
      const key = `${req.method} ${url.pathname}`;
      if (url.pathname.startsWith("/api/")) {
        const dyn = RELEASE_RE.exec(url.pathname);
        const isPublic = PUBLIC_API.has(key);
        if (!isPublic && !user) throw new HttpError(401, "Sign in required.");
        const handler = dyn ? releaseHandler(req.method, dyn[1]) : routes[key];
        if (!handler) throw new HttpError(404, "Not found.");
        const needed = dyn ? (req.method === "GET" ? "viewer" : "editor") : NEEDS[key] || "viewer";
        if (!isPublic && !roleAllows(user.role, needed)) throw new HttpError(403, "Your role does not allow that.");
        return send(200, await handler(req, url, user, ctx));
      }
      if (req.method === "GET") {
        if (!user && !PUBLIC_FILES.has(url.pathname)) {
          if (url.pathname === "/" || url.pathname.endsWith(".html")) {
            res.writeHead(302, { Location: "/login.html?next=" + encodeURIComponent(url.pathname), ...SECURITY_HEADERS });
            return res.end();
          }
          throw new HttpError(401, "Sign in required.");
        }
        return await serveStatic(url.pathname, res);
      }
      throw new HttpError(404, "Not found.");
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (url.pathname.startsWith("/api/")) return send(status, { error: status === 500 ? "Something went wrong on the server." : e.message, ...(e.current ? { current: e.current } : {}) });
      res.writeHead(status, { "Content-Type": "text/plain", ...SECURITY_HEADERS });
      res.end(e.message);
    }
  });

  return { server, config, auth, jobs };
}

// Run directly: node src/server.js
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || "127.0.0.1";
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  const authOff = process.env.AUTH === "off" || process.argv.includes("--no-auth");
  if (authOff && !loopback) {
    console.error("Turning sign-in off is only allowed when HOST is 127.0.0.1 (your own computer). Refusing to start without sign-in on a network address.");
    process.exit(1);
  }
  const { server, auth, jobs } = await createApp({ auth: !authOff });
  jobs.start();
  server.listen(port, host, async () => {
    const mode = isDemo() ? "demo data" : "live data";
    console.log(`Release readiness running on http://${host}:${port} (${mode}, ${authOff ? "sign-in OFF" : "sign-in on"})`);
    if (!isDemo() && !process.env.GITHUB_TOKEN) console.log("No GITHUB_TOKEN set: public repositories only, with GitHub's low anonymous rate limit.");
    if (auth) {
      const b = await auth.bootstrap();
      const origin = (process.env.PUBLIC_URL || `http://${host}:${port}`).replace(/\/+$/, "");
      if (b?.missing) console.log("\nNo accounts yet. Set ADMIN_EMAIL=you@yourcompany.com and restart to create the first admin.");
      else if (b) console.log(`\nFirst admin created for ${b.email}. Open this link once to set a password (valid 7 days):\n${origin}/invite.html?email=${encodeURIComponent(b.email)}&token=${b.token}\n`);
    }
  });
}
