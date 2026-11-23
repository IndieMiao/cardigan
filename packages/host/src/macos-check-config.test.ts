import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  loadMacosCheckProfiles,
  parseMacosCheckProfiles,
} from "./macos-check-config.js";

const root = mkdtempSync(join(tmpdir(), "macos-config-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("only bounded limits and an executor name are configurable", () => {
  expect(
    parseMacosCheckProfiles(
      "projects:\n  sample:\n    max_runs_per_candidate: 5\n    executor: github\n    enabled: false\n",
    ),
  ).toEqual({
    sample: { max_runs_per_candidate: 5, executor: "github", enabled: false },
  });
  expect(parseMacosCheckProfiles("")).toEqual({});
  for (const bad of [
    "projects:\n  sample:\n    workflow: x.yml\n",
    "projects:\n  sample:\n    max_runs_per_candidate: 0\n",
    "projects:\n  sample:\n    max_runs_per_candidate: 21\n",
    "projects:\n  sample:\n    timeout_ms: 1000\n",
    "projects:\n  sample:\n    executor: ../x\n",
    "projects:\n  __proto__:\n    enabled: true\n",
    "other: 1\n",
  ])
    expect(() => parseMacosCheckProfiles(bad)).toThrow("macOS 检查配置无效");
});

test("a missing file keeps defaults; an unsafe or invalid file disables checks", () => {
  const path = join(root, "macos-checks.yaml");
  expect(loadMacosCheckProfiles(path)).toEqual({});
  writeFileSync(path, "projects:\n  sample:\n    max_concurrent: 1\n", {
    mode: 0o600,
  });
  expect(loadMacosCheckProfiles(path)).toEqual({
    sample: { max_concurrent: 1 },
  });
  writeFileSync(path, "projects: [", { mode: 0o600 });
  expect(loadMacosCheckProfiles(path)).toBeUndefined();
  const open = join(root, "open.yaml");
  writeFileSync(open, "projects: {}\n", { mode: 0o644 });
  expect(loadMacosCheckProfiles(open)).toBeUndefined();
});
