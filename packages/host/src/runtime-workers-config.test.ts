import {
  chmodSync,
  linkSync,
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

test("remote launch requires an explicit boolean opt-in in the private project binding", () => {
  const base = workerConfig();
  const machine = base.machines[0];
  const project = machine?.projects[0];
  if (!machine || !project) throw new Error("Missing fixture");
  const config = (allow_remote_launch: unknown) => ({
    ...base,
    machines: [{ ...machine, projects: [{ ...project, allow_remote_launch }] }],
  });
  for (const enabled of [undefined, false, true])
    expect(
      parseRuntimeWorkers(config(enabled), "/private/data")[0]
        ?.allow_remote_launch,
    ).toBe(enabled === true);
  for (const enabled of ["true", 1, null, {}, []])
    expect(() => parseRuntimeWorkers(config(enabled), "/private/data")).toThrow(
      "configuration invalid",
    );
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
test("two project accounts retain one physical machine and may use the same terminal session name", () => {
  const config = workerConfig();
  const machine = config.machines[0];
  const project = machine?.projects[0];
  if (!machine || !project) throw new Error("Missing fixture");
  machine.projects.push({
    ...project,
    project_id: "other",
    user: "project_b",
    gid: 2002,
    root: "/workers/b",
    alias: "fixture-b",
  });
  const workers = parseRuntimeWorkers(config, "/private/data");
  expect(workers).toHaveLength(2);
  expect(new Set(workers.map((w) => w.machine_id))).toEqual(
    new Set(["worker-a"]),
  );
  expect(workers[0]?.session).toBe(workers[1]?.session);
});
test("publication has no implicit limits; only complete trusted limits and helper paths are accepted", () => {
  const base = workerConfig();
  const machine = base.machines[0];
  const project = machine?.projects[0];
  if (!machine || !project) throw new Error("Missing fixture worker");
  const publication = {
    header_max_bytes: 4096,
    file_max_bytes: 2048,
    batch_max_bytes: 8192,
    timeout_ms: 2000,
  };
  const configured = (patch: object) => ({
    ...base,
    machines: [{ ...machine, projects: [{ ...project, ...patch }] }],
  });
  expect(
    parseRuntimeWorkers(base, "/private/data")[0]?.execution.publication,
  ).toBeUndefined();
  const parsed = parseRuntimeWorkers(
    configured({
      publication,
      python: "/usr/bin/python3",
      file_helper: "/opt/worker/worker-files.py",
    }),
    "/private/data",
  )[0];
  expect(parsed?.execution.publication).toEqual(publication);
  expect(parsed?.execution.fileHelper).toEqual({
    python: "/usr/bin/python3",
    path: "/opt/worker/worker-files.py",
  });
  for (const patch of [
    { publication: {} },
    { publication: { ...publication, timeout_ms: 0 } },
    { publication: { ...publication, file_max_bytes: 8193 } },
    { publication: { ...publication, header_max_bytes: "4096" } },
    { publication: { ...publication, unknown: 1 } },
    { python: "/usr/bin/python3" },
    { python: "python3", file_helper: "/opt/worker/worker-files.py" },
    { python: "/usr/bin/python3", file_helper: "/opt/worker/../escape.py" },
  ])
    expect(() =>
      parseRuntimeWorkers(configured(patch), "/private/data"),
    ).toThrow(/^Runtime worker configuration invalid$/u);
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
  const hardlink = join(root, "hardlink");
  linkSync(file, hardlink);
  expect(() => loadRuntimeWorkers("/private/data", file)).toThrow(
    "configuration invalid",
  );
  rmSync(hardlink);
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

test("loopback spellings cannot split the same physical machine into separate buckets", () => {
  const original = workerConfig().machines[0];
  for (const host of ["127.0.0.1", "::1", "LOCALHOST"])
    expect(() =>
      parseRuntimeWorkers(
        {
          version: 1,
          machines: [
            { ...original, id: "local", host: "localhost" },
            { ...original, id: "other", host, projects: [] },
          ],
        },
        "/private/data",
      ),
    ).toThrow("configuration invalid");
});
