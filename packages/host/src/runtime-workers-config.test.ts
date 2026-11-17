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
  runtimeWorkerMcpHosts,
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
          mcp_url: "https://control.example-tailnet.ts.net/mcp",
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
      mcp: {
        url: "https://control.example-tailnet.ts.net/mcp",
        timeoutMs: 10000,
      },
    },
  });
});
test("remote MCP requires a tailnet HTTPS endpoint and valid explicit timeouts; local stays unchanged", () => {
  const config = workerConfig();
  const machine = config.machines[0];
  const project = machine?.projects[0];
  if (!machine || !project) throw new Error("Missing fixture");
  const configured = (patch: object, local = false) => ({
    ...config,
    machines: [
      {
        ...machine,
        ...(local ? { id: "local", host: "localhost" } : {}),
        projects: [{ ...project, ...patch }],
      },
    ],
  });
  expect(() =>
    parseRuntimeWorkers(configured({ mcp_url: undefined }), "/private/data"),
  ).toThrow("mcp_config_missing");
  for (const mcp_url of [
    "",
    "http://control.example-tailnet.ts.net/mcp",
    "https://example.com/mcp",
    "https://ts.net/mcp",
    "https://control.ts.net/mcp",
    "https://control.example-tailnet.ts.net.evil/mcp",
    "https://user:secret@control.example-tailnet.ts.net/mcp",
    "https://control.example-tailnet.ts.net/mcp?token=secret",
    "https://control.example-tailnet.ts.net/mcp#x",
    "https://127.0.0.1/mcp",
    "https://control.example-tailnet.ts.net/other",
    "https://control.example-tailnet.ts.net:65536/mcp",
    "https://control.example-tailnet.ts.net:0/mcp",
  ])
    expect(() =>
      parseRuntimeWorkers(configured({ mcp_url }), "/private/data"),
    ).toThrow(/^mcp_config_invalid$/);
  for (const mcp_timeout_ms of [0, -1, 1.5, "1000", 2147483648, null])
    expect(() =>
      parseRuntimeWorkers(configured({ mcp_timeout_ms }), "/private/data"),
    ).toThrow("mcp_config_invalid");
  expect(
    parseRuntimeWorkers(
      configured({ mcp_timeout_ms: 5000 }),
      "/private/data",
    )[0]?.execution.mcp?.timeoutMs,
  ).toBe(5000);
  expect(
    parseRuntimeWorkers(
      configured({ mcp_url: undefined }, true),
      "/private/data",
    )[0]?.execution.mcp,
  ).toBeUndefined();
  expect(() =>
    parseRuntimeWorkers(configured({}, true), "/private/data"),
  ).toThrow("configuration invalid");
});
test.each([
  ["443", ""],
  ["0443", ""],
  ["8443", ":8443"],
  ["08443", ":8443"],
])(
  "canonical port %s is shared by target configuration and proxy Host",
  (port, suffix) => {
    const config = workerConfig();
    const project = config.machines[0]?.projects[0];
    if (!project) throw new Error("Missing fixture");
    project.mcp_url = `https://control.example-tailnet.ts.net:${port}/mcp`;
    const workers = parseRuntimeWorkers(config, "/private/data");
    expect(workers[0]?.execution.mcp?.url).toBe(
      `https://control.example-tailnet.ts.net${suffix}/mcp`,
    );
    expect(runtimeWorkerMcpHosts(workers, "fixture")).toEqual([
      `control.example-tailnet.ts.net${suffix}`,
    ]);
  },
);
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
  expect(runtimeWorkerMcpHosts(workers, "fixture")).toEqual([
    "control.example-tailnet.ts.net",
  ]);
  expect(runtimeWorkerMcpHosts(workers, "unknown")).toEqual([]);
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
