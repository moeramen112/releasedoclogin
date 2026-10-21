import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../src/engine.js";

const config = {
  ci: { quarantine: ["flaky"] },
  criteria: [
    { id: "p0", name: "No P0", type: "blockers_none", required: true, params: { severity: "P0" } },
    { id: "p1", name: "No P1", type: "blockers_none", required: true, params: { severity: "P1", failAs: "warn" } },
    { id: "ci", name: "CI", type: "ci_green", required: true },
    { id: "rb", name: "Rollback", type: "manual", source: "manual", required: true, params: { checkId: "rb" } },
    { id: "notes", name: "Notes", type: "draft_release", required: false },
  ],
};

const healthy = () => ({
  release: { freezeDate: "2026-10-15T00:00:00Z" },
  sources: { github: "ok", jira: "off" },
  errors: {},
  data: {
    blockers: [],
    ci: { total: 10, passed: 10, failed: [], pending: [] },
    draftRelease: { exists: true },
  },
});
const confirmed = { manual: { rb: { state: "pass", by: "Hiro" } } };
const by = (res, id) => res.criteria.find((c) => c.id === id);

test("GO when every required criterion passes", () => {
  const res = evaluate(healthy(), config, confirmed);
  assert.equal(res.verdict.call, "GO");
});

test("an open P0 gives NO-GO", () => {
  const s = healthy();
  s.data.blockers = [{ key: "#1", sev: "P0" }];
  assert.equal(evaluate(s, config, confirmed).verdict.call, "NO-GO");
});

test("an open P1 only gives HOLD because the config downgrades it to a warning", () => {
  const s = healthy();
  s.data.blockers = [{ key: "#2", sev: "P1" }];
  const res = evaluate(s, config, confirmed);
  assert.equal(by(res, "p1").status, "warn");
  assert.equal(res.verdict.call, "HOLD");
});

test("failing quarantined checks warn, real failures fail", () => {
  const s = healthy();
  s.data.ci = { total: 10, passed: 9, failed: ["e2e / flaky-checkout"], pending: [] };
  assert.equal(by(evaluate(s, config, confirmed), "ci").status, "warn");
  s.data.ci = { total: 10, passed: 9, failed: ["unit / orders"], pending: [] };
  assert.equal(by(evaluate(s, config, confirmed), "ci").status, "fail");
});

test("missing data is pending, never a pass", () => {
  const s = healthy();
  s.errors.ci = "GitHub returned 502";
  delete s.data.ci;
  const res = evaluate(s, config, confirmed);
  assert.equal(by(res, "ci").status, "pending");
  assert.notEqual(res.verdict.call, "GO");
});

test("an unconfirmed manual check holds the release", () => {
  const res = evaluate(healthy(), config, {});
  assert.equal(by(res, "rb").status, "pending");
  assert.equal(res.verdict.call, "HOLD");
});

test("sources that are switched off drop their criteria", () => {
  const c = { criteria: [{ id: "j", name: "Jira", type: "blockers_none", source: "jira", params: {} }] };
  const res = evaluate(healthy(), c, {});
  assert.equal(res.criteria.length, 0);
});

test("a waiver with approver and reason clears a failure", () => {
  const s = healthy();
  s.data.blockers = [{ key: "#1", sev: "P0" }];
  const state = { ...confirmed, waivers: { p0: { approver: "VP Eng", reason: "Fix ships in hotfix 4.12.1", statusAtWaive: "fail" } } };
  const res = evaluate(s, config, state);
  assert.equal(by(res, "p0").effective, "waived");
  assert.equal(res.verdict.call, "GO");
});

test("a waiver without a named approver or a reason does nothing", () => {
  const s = healthy();
  s.data.blockers = [{ key: "#1", sev: "P0" }];
  for (const w of [{ approver: "", reason: "ok" }, { approver: "VP", reason: "  " }]) {
    const res = evaluate(s, config, { ...confirmed, waivers: { p0: { ...w, statusAtWaive: "fail" } } });
    assert.equal(by(res, "p0").effective, "fail");
    assert.equal(res.verdict.call, "NO-GO");
  }
});

test("a waiver goes stale when the criterion gets worse", () => {
  const s = healthy();
  s.data.blockers = [{ key: "#2", sev: "P1" }];
  const state = { ...confirmed, waivers: { p1: { approver: "QA lead", reason: "Known, low impact", statusAtWaive: "warn" } } };
  assert.equal(by(evaluate(s, config, state), "p1").effective, "waived");
  // Same criterion now fails instead of warns: use a config that fails on P1.
  const strict = { ...config, criteria: config.criteria.map((c) => (c.id === "p1" ? { ...c, params: { severity: "P1" } } : c)) };
  const res = evaluate(s, strict, state);
  assert.equal(by(res, "p1").effective, "fail");
  assert.equal(by(res, "p1").waiver.stale, true);
});

test("late changes compare merge time against the freeze date", () => {
  const c = { criteria: [{ id: "late", name: "Late", type: "late_changes", required: false, params: {} }] };
  const s = healthy();
  s.data.mergedPrs = [{ number: 1, mergedAt: "2026-10-14T10:00:00Z" }, { number: 2, mergedAt: "2026-10-16T10:00:00Z" }];
  const res = evaluate(s, c, {});
  assert.equal(res.criteria[0].status, "warn");
  assert.match(res.criteria[0].detail, /#2/);
});
