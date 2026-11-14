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
import {
  loadRuntimeWorkers,
  parseRuntimeWorkers,
} from "./runtime-workers-config.js";

export const workerConfig = () => ({
  version: 1,
  machines: [
    {
      id: "worker-a",
      os: "darwin",
      arch: "arm64",
      host: "worker-a.invalid",
      port: 22,
      identity_file: "/private/identity",
      known_hosts_file: "/private/known_hosts",
      host_key_alias: "worker-a",
      projects: [
        {
          project_id: "fixture",
          user: "project_a",
          gid: 2001,
          alias: "fixture-a",
          session: "fixture-a",
          root: "/workers/a",
          path: "/usr/local/bin:/usr/bin:/bin",
          generation: "one",
        },
      ],
    },
  ],
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("trusted workers carry physical identity and project-specific endpoint/account/PATH", () => {
  const [target] = parseRuntimeWorkers(workerConfig(), "/private/data");
  expect(target).toMatchObject({
    machine_id: "worker-a",
    project_id: "fixture",
    session: "fixture-a",
    generation: "one",
    execution: {
      host: "worker-a.invalid",
      user: "project_a",
      machine: "fixture-a",
      path: "/usr/local/bin:/usr/bin:/bin",
    },
  });
});
test("invalid, duplicate, shared-account and overlapping target configuration fail closed without exposing values", () => {
  const base = workerConfig();
  const machine = base.machines[0];
  const project = machine?.projects[0];
  if (!machine || !project) throw new Error("Missing fixture worker");
  const invalids = [
    { ...base, enabled: true },
    { ...base, version: 2 },
    { ...base, machines: [{ ...machine, id: "local" }] },
    { ...base, machines: [machine, machine] },
    {
      ...base,
      machines: [machine, { ...machine, id: "alias-of-same-machine" }],
    },
    ...[
      { user: "root" },
      { user: "bad;SECRET" },
      { alias: "local" },
      { session: "bad/socket" },
      { path: "/usr/bin:." },
      { root: "/workers/../private" },
      { root: "/private" },
      { gid: 0 },
      { generation: "" },
      { command: "SECRET" },
    ].map((patch) => ({
      ...base,
      machines: [{ ...machine, projects: [{ ...project, ...patch }] }],
    })),
    {
      ...base,
      machines: [
        {
          ...machine,
          projects: [
            project,
            {
              ...project,
              project_id: "other",
              alias: "other",
              root: "/workers/b",
            },
          ],
        },
      ],
    },
    {
      ...base,
      machines: [
        {
          ...machine,
          projects: [
            project,
            {
              ...project,
              project_id: "other",
              user: "other",
              root: "/workers/b",
            },
          ],
        },
      ],
    },
    { ...base, machines: [{ ...machine, host: "SECRET;evil" }] },
    { ...base, machines: [{ ...machine, port: 65536 }] },
  ];
  for (const raw of invalids)
    expect(() => parseRuntimeWorkers(raw, "/private/data")).toThrow(
      /^Runtime worker configuration invalid$/u,
    );
});
test("missing config is compatible; malformed, permissive and symlink files are not", () => {
  const root = mkdtempSync(join(tmpdir(), "cg-workers-"));
  roots.push(root);
  const file = join(root, "workers.yaml");
  expect(loadRuntimeWorkers("/private/data", file)).toEqual([]);
  writeFileSync(file, JSON.stringify(workerConfig()), { mode: 0o600 });
  expect(loadRuntimeWorkers("/private/data", file)).toHaveLength(1);
  chmodSync(file, 0o644);
  expect(() => loadRuntimeWorkers("/private/data", file)).toThrow(
    "configuration invalid",
  );
  chmodSync(file, 0o600);
  const link = join(root, "link");
  symlinkSync(file, link);
  expect(() => loadRuntimeWorkers("/private/data", link)).toThrow(
    "configuration invalid",
  );
  writeFileSync(file, "version: 1\nversion: 2\nmachines: []\n");
  expect(() => loadRuntimeWorkers("/private/data", file)).toThrow(
    "configuration invalid",
  );
});
