// Accounts, sessions and roles. No outside dependencies.
//  - Invite only. An admin adds an email and a role; the person sets their own password from a one-time link.
//  - Passwords are stored as scrypt hashes. Nothing reversible is kept.
//  - A session is a signed cookie (HMAC-SHA256). Changing a password ends every other session.
//  - Repeated wrong passwords lock that email-and-address pair for a while.

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createJsonStore } from "./state.js";

const scrypt = promisify(crypto.scrypt);
export const ROLES = ["admin", "editor", "viewer"];
const RANK = { viewer: 1, editor: 2, admin: 3 };
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const COOKIE = "rr_session";
const SESSION_MS = 12 * 3600_000;
const INVITE_MS = 7 * 24 * 3600_000;
const LOCK_AFTER = 5;
const LOCK_AFTER_ADDRESS = 30;
const LOCK_MS = 15 * 60_000;
const MIN_PASSWORD = 10;

export class AuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const b64u = (b) => Buffer.from(b).toString("base64url");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
export const normEmail = (e) => String(e ?? "").trim().toLowerCase();
export const roleAllows = (role, needed) => (RANK[role] || 0) >= (RANK[needed] || 99);

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return { salt: salt.toString("base64"), hash: key.toString("base64") };
}
async function passwordMatches(pw, rec) {
  const key = await scrypt(pw, Buffer.from(rec.salt, "base64"), 64);
  return same(key.toString("base64"), rec.hash);
}

function checkPassword(pw) {
  if (typeof pw !== "string" || pw.length < MIN_PASSWORD) throw new AuthError(400, `Use a password of at least ${MIN_PASSWORD} characters.`);
  if (pw.length > 200) throw new AuthError(400, "That password is too long.");
}

export async function createAuth({ dir, env = process.env, now = Date.now } = {}) {
  const db = await createJsonStore(path.join(dir, "users.json"), () => ({ users: {} }));

  let secret = env.SESSION_SECRET;
  if (!secret) {
    const f = path.join(dir, "session.secret");
    try { secret = (await fs.readFile(f, "utf8")).trim(); }
    catch { secret = crypto.randomBytes(32).toString("hex"); await fs.writeFile(f, secret, { mode: 0o600 }); }
  }
  const dummy = await hashPassword("not-a-real-password"); // so an unknown email takes as long as a known one

  const sign = (payload) => crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const users = () => db.get().users;
  const pub = (u) => ({ email: u.email, name: u.name, role: u.role });
  const fails = new Map();

  function lockState(keys) {
    for (const k of keys) { const f = fails.get(k); if (f && f.until > now()) return Math.ceil((f.until - now()) / 60_000); }
    return 0;
  }
  // 5 wrong passwords for one email from one address locks that pair; 30 from one address locks the address.
  // The address limit is higher so one mistyped password does not lock out a whole office behind one connection.
  function noteFail(keys) {
    keys.forEach((k, i) => {
      const limit = i === 0 ? LOCK_AFTER : LOCK_AFTER_ADDRESS;
      const f = fails.get(k) || { n: 0, until: 0 };
      if (f.until && f.until <= now()) { f.n = 0; f.until = 0; }
      f.n++;
      if (f.n >= limit) { f.until = now() + LOCK_MS; f.n = 0; }
      fails.set(k, f);
    });
  }

  function cookieFor(u, secure) {
    const payload = b64u(JSON.stringify({ e: u.email, x: now() + SESSION_MS, v: u.pwVersion || 0 }));
    return `${COOKIE}=${payload}.${sign(payload)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure ? "; Secure" : ""}`;
  }
  const clearCookie = (secure) => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`;

  /** The signed-in user for a request, or null. */
  function userFor(req) {
    const m = /(?:^|;\s*)rr_session=([^;]+)/.exec(req.headers.cookie || "");
    if (!m) return null;
    const [payload, sig] = m[1].split(".");
    if (!payload || !sig || !same(sig, sign(payload))) return null;
    let s;
    try { s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
    if (!s || s.x < now()) return null;
    const u = users()[s.e];
    if (!u || !u.active || !u.hash || (u.pwVersion || 0) !== s.v) return null;
    return pub(u);
  }

  async function login({ email, password, ip, secure }) {
    email = normEmail(email);
    const keys = [`${ip}|${email}`, `ip|${ip}`];
    const wait = lockState(keys);
    if (wait) throw new AuthError(429, `Too many wrong passwords. Try again in ${wait} minute${wait === 1 ? "" : "s"}.`);
    const u = users()[email];
    const ok = await passwordMatches(String(password ?? "").slice(0, 200), u?.hash ? u : dummy);
    if (!u || !u.active || !u.hash || !ok) { noteFail(keys); throw new AuthError(401, "Email or password is wrong."); }
    fails.delete(keys[0]);
    return { user: pub(u), cookie: cookieFor(u, secure) };
  }

  const makeInvite = () => {
    const token = crypto.randomBytes(32).toString("base64url");
    return { token, inviteHash: sha256(token), inviteExpires: now() + INVITE_MS };
  };

  async function accept({ email, token, password, name, secure }) {
    email = normEmail(email);
    checkPassword(password);
    const u = users()[email];
    if (!u || !u.inviteHash || u.inviteExpires < now() || !same(sha256(String(token ?? "")), u.inviteHash)) {
      throw new AuthError(400, "This invite link is not valid or has expired. Ask an admin for a new one.");
    }
    const h = await hashPassword(password);
    const cleanName = String(name ?? "").trim().slice(0, 80);
    await db.mutate(() => {
      Object.assign(u, h, { name: cleanName || u.name, active: true, pwVersion: (u.pwVersion || 0) + 1 });
      delete u.inviteHash; delete u.inviteExpires;
    });
    return { user: pub(u), cookie: cookieFor(u, secure) };
  }

  async function changePassword(user, { current, next, secure }) {
    const u = users()[user.email];
    if (!u || !(await passwordMatches(String(current ?? "").slice(0, 200), u))) throw new AuthError(400, "Your current password is not right.");
    checkPassword(next);
    const h = await hashPassword(next);
    await db.mutate(() => { Object.assign(u, h, { pwVersion: (u.pwVersion || 0) + 1 }); });
    return cookieFor(u, secure); // other sessions end; this one continues
  }

  const activeAdmins = () => Object.values(users()).filter((u) => u.active && u.role === "admin" && u.hash);

  const admin = {
    list: () => Object.values(users()).map((u) => ({ ...pub(u), active: u.active, joined: Boolean(u.hash), invitePending: Boolean(u.inviteHash && u.inviteExpires > now()), createdAt: u.createdAt, createdBy: u.createdBy })),

    async invite({ email, name, role }, by) {
      email = normEmail(email);
      if (!EMAIL_RE.test(email)) throw new AuthError(400, "That does not look like an email address.");
      if (!ROLES.includes(role)) throw new AuthError(400, "Role must be admin, editor or viewer.");
      if (users()[email]?.hash) throw new AuthError(409, "That person already has an account.");
      const inv = makeInvite();
      await db.mutate((s) => {
        s.users[email] = { ...(s.users[email] || {}), email, name: String(name ?? "").trim().slice(0, 80), role, active: true, createdAt: new Date().toISOString(), createdBy: by, inviteHash: inv.inviteHash, inviteExpires: inv.inviteExpires };
      });
      return { email, token: inv.token };
    },

    async reinvite(email, by) {
      const u = users()[normEmail(email)];
      if (!u) throw new AuthError(404, "No such person.");
      const inv = makeInvite();
      await db.mutate(() => { Object.assign(u, { inviteHash: inv.inviteHash, inviteExpires: inv.inviteExpires, reinvitedBy: by }); });
      return { email: u.email, token: inv.token };
    },

    async update(email, { role, active }) {
      const u = users()[normEmail(email)];
      if (!u) throw new AuthError(404, "No such person.");
      const nextRole = role ?? u.role, nextActive = active ?? u.active;
      if (!ROLES.includes(nextRole)) throw new AuthError(400, "Role must be admin, editor or viewer.");
      const losesAdmin = u.active && u.role === "admin" && (nextRole !== "admin" || !nextActive);
      if (losesAdmin && activeAdmins().length <= 1) throw new AuthError(400, "There must always be one active admin.");
      await db.mutate(() => {
        u.role = nextRole; u.active = Boolean(nextActive);
        if (!nextActive) u.pwVersion = (u.pwVersion || 0) + 1; // ends their sessions now
      });
      return pub(u);
    },
  };

  /** First start: create the first admin from ADMIN_EMAIL and return a one-time link. */
  async function bootstrap() {
    if (Object.keys(users()).length) return null;
    const email = normEmail(env.ADMIN_EMAIL);
    if (!EMAIL_RE.test(email)) return { missing: true };
    const { token } = await admin.invite({ email, name: "", role: "admin" }, "setup");
    return { email, token };
  }

  return { userFor, login, accept, changePassword, admin, bootstrap, cookieFor, clearCookie, hasUsers: () => Object.keys(users()).length > 0 };
}
