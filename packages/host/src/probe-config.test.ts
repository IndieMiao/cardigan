import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { loadProbeProfiles, parseProbeProfiles } from "./probe-config.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const valid = {
  projects: {
    sample: {
      github: {
        executor: "github",
        operations: ["smoke", "status", "cleanup"],
      },
      config: { operations: ["smoke"] },
    },
  },
};
test("private profiles default off and contain only named operations and bounded host policy", () => {
  const root = mkdtempSync(join(tmpdir(), "probe-profile-"));
  roots.push(root);
  const path = join(root, "probes.yaml");
  expect(loadProbeProfiles(path)).toEqual({});
  writeFileSync(path, JSON.stringify(valid), { mode: 0o600 });
  expect(loadProbeProfiles(path).sample?.github).toMatchObject({
    timeout_ms: 900000,
    rest_budget_per_hour: 120,
  });
  chmodSync(path, 0o644);
  expect(() => loadProbeProfiles(path)).toThrow("配置无效");
  chmodSync(path, 0o600);
  symlinkSync(path, join(root, "link"));
  expect(() => loadProbeProfiles(join(root, "link"))).toThrow("配置无效");
});
test.each([
  { command: "echo secret" },
  { path: "/private" },
  { token: "secret" },
  { branch: "main" },
  { operations: ["push"] },
  { operations: ["smoke", "smoke"] },
  { executor: "../other" },
  { rest_budget_per_hour: 0 },
  { rest_budget_per_hour: 2001 },
  { timeout_ms: 3600001 },
  { timeout_ms: 1.5 },
])("rejects unbounded or executable profile fields: %j", (patch) => {
  expect(() =>
    parseProbeProfiles(
      JSON.stringify({
        projects: {
          sample: { github: { ...valid.projects.sample.github, ...patch } },
        },
      }),
    ),
  ).toThrow();
});
test("unknown targets and YAML aliases cannot expand probe authority", () => {
  expect(() =>
    parseProbeProfiles("projects: {sample: {model: {operations: [smoke]}}}"),
  ).toThrow();
  expect(() =>
    parseProbeProfiles("projects: &p {sample: {config: *p}}"),
  ).toThrow();
});
