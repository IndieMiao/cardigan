import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { runScenario } from "./git-model.mjs";

const mode = process.env.GIT_SPIKE_MODE ?? "local";
test(`${mode}: delivery validation, backup, takeover, central merge, cleanup`, { timeout: 90000 }, async () => {
  const result = await runScenario(mode);
  assert.deepEqual(result.decisions, ["accepted", "missing-object", "not-in-branch"]);
  assert.deepEqual(result.files, ["README.md", "first.txt", "second.txt", "takeover.txt"]);
  assert.equal(result.content, "resumed from last fetched checkpoint");
  assert.deepEqual(result.faults.map((fault) => fault.kind), mode === "ssh" ? ["refused", "timeout"] : ["missing-path"]);
  await assert.rejects(access(result.root), { code: "ENOENT" });
});
