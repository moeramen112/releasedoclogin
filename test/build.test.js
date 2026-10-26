import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import vm from "node:vm";

test("standalone build: no leftover import/export, and every script parses", () => {
  execFileSync(process.execPath, ["scripts/build-standalone.mjs"], { stdio: "pipe" });
  for (const f of ["release-planner.html", "release-planner.standalone.html", "release-planner.readonly.html"]) {
    const html = readFileSync(`dist/${f}`, "utf8");
    const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
    assert.ok(js.length > 1000, f);
    assert.doesNotMatch(js, /^\s*(export|import)\s/m, `${f} still has a module statement`);
    assert.doesNotThrow(() => new vm.Script(js), `${f} does not parse`);
  }
});
