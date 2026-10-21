import test from "node:test";
import assert from "node:assert/strict";
import { reportModel as _rm, reportWord as _rw, statusModel as _sm, reportDocument as _rd, defaultPlan as _dp, planToSnapshot as _ps, planConfig as _pc, planState as _st } from "../src/plan.js";
import { evaluate as _ev } from "../src/engine.js";
import { computeRisk as _cr } from "../src/risk.js";

test("release docs: Word file and one-page status", () => {
  const now = Date.now(), p = _dp(now);
  const m = _rm(p, _ev(_ps(p, now), _pc(p), _st(p)), _cr(p, now), now);
  const w = _rw(m);
  assert.match(w, /xmlns:w="urn:schemas-microsoft-com:office:word"/);
  assert.match(w, /<h1>/);
  const s = _sm(m);
  assert.match(s.title, /status update/);
  assert.ok(s.sections.length >= 2 && s.sections.length < m.sections.length);
  assert.ok(s.sections.some((x) => x.title === "Summary"));
  assert.ok(!_rd(s).includes("Runbook"));
});
