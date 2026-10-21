// Small JSON file store for the things people decide: waivers, manual checks, audit log,
// and a history of snapshots for the trend chart. Writes are serialized and atomic.

import { promises as fs } from "node:fs";
import path from "node:path";

const EMPTY = () => ({ waivers: {}, manual: {}, audit: [], history: [] });

export async function createStore(file, seed) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  let state;
  try {
    state = { ...EMPTY(), ...JSON.parse(await fs.readFile(file, "utf8")) };
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`Could not read ${file}: ${e.message}`);
    state = { ...EMPTY(), ...(seed || {}) };
  }

  let chain = Promise.resolve();
  const persist = async () => {
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.rename(tmp, file);
  };

  return {
    get: () => state,
    /** Run a change, then write it to disk. Changes queue so two requests cannot interleave. */
    mutate(fn) {
      const run = chain.then(async () => {
        const result = fn(state);
        state.audit = state.audit.slice(-499);
        state.history = state.history.slice(-299);
        await persist();
        return result;
      });
      chain = run.catch(() => {});
      return run;
    },
  };
}

export function auditEntry(action, by, detail) {
  return { at: new Date().toISOString(), action, by: by || "unknown", detail };
}

/** A small JSON file store for anything that is not waivers or audit (users, releases).
 *  Writes queue, are atomic, and the file is readable only by the account running the server. */
export async function createJsonStore(file, empty) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  let state;
  try {
    state = { ...empty(), ...JSON.parse(await fs.readFile(file, "utf8")) };
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`Could not read ${file}: ${e.message}`);
    state = empty();
  }
  let chain = Promise.resolve();
  const persist = async () => {
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file);
  };
  return {
    get: () => state,
    /** fn must check everything first and change state last, so a refused change leaves nothing half done. */
    mutate(fn) {
      const run = chain.then(async () => { const result = fn(state); await persist(); return result; });
      chain = run.catch(() => {});
      return run;
    },
  };
}
