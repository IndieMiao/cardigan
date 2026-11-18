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
import { assignOrDefer } from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import {
  beginMachineObservation,
  completeMachineObservation,
  MACHINE_OBSERVATION_TTL_MS,
  Store,
} from "@cardigan/store";
import { afterEach, expect, test } from "vitest";
import {
  assignment,
  card,
  id,
  machine,
  now,
  ports,
  role,
  run,
  value,
} from "../../domain/src/commands/test-fixtures.js";
import { configureMachinePlacement } from "./machine-placement.js";
import { loadRunCapacityConfig } from "./run-capacity-config.js";
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
      macosCore: {
        python: "/opt/homebrew/bin/python3",
        retiredLaunchdLabel: "dev.cardigan.fixture",
      },
      mcp: {
        url: "https://control.example-tailnet.ts.net/mcp",
        timeoutMs: 10000,
      },
    },
  });
});
test("macOS retired service labels are validated and Linux never opts into the new entry", () => {
  const base = workerConfig();
  const m = base.machines[0];
  const p = m?.projects[0];
  if (!m || !p) throw new Error("Missing fixture");
  const config = (os: string, retired_launchd_label?: unknown) => ({
    ...base,
    machines: [
      {
        ...m,
        os,
        projects: [
          {
            ...p,
            ...(retired_launchd_label === undefined
              ? {}
              : { retired_launchd_label }),
          },
        ],
      },
    ],
  });
  expect(
    parseRuntimeWorkers(
      config("macos", "dev.cardigan.custom"),
      "/private/data",
    )[0]?.execution.macosCore?.retiredLaunchdLabel,
  ).toBe("dev.cardigan.custom");
  expect(
    parseRuntimeWorkers(config("linux"), "/private/data")[0]?.execution
      .macosCore,
  ).toBeUndefined();
  for (const label of ["../escape", "x/y", "", "has space", 1, null])
    expect(() =>
      parseRuntimeWorkers(config("darwin", label), "/private/data"),
    ).toThrow();
  expect(() =>
    parseRuntimeWorkers(
      config("linux", "dev.cardigan.fixture"),
      "/private/data",
    ),
  ).toThrow();
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

test("placement reads current project opt-in and unexpired observations in the command transaction, with physical occupancy", async () => {
  const root = mkdtempSync(join(tmpdir(), "placement-"));
  roots.push(root);
  const store = Store.open({ dataDir: root });
  const project = "fixture",
    env = { CARDIGAN_CONFIG_DIR: root };
  const config = workerConfig();
  const write = (
    allow_remote_launch: boolean,
    platform: { os?: string; arch?: string } = {},
  ) =>
    writeFileSync(
      join(root, "runtime-workers.yaml"),
      JSON.stringify({
        ...config,
        machines: config.machines.map((m) => ({
          ...m,
          ...platform,
          projects: m.projects.map((p) => ({ ...p, allow_remote_launch })),
        })),
      }),
      { mode: 0o600 },
    );
  try {
    write(true);
    writeFileSync(join(root, "run-capacity.yaml"), "machines: {worker-a: 6}", {
      mode: 0o600,
    });
    for (const p of [project, "other"]) store.createProject({ id: p });
    store.uow.run((tx) => {
      for (const p of [project, "other"])
        tx.machines.put(p, {
          ...machine(),
          label: "Worker A",
          id: "worker-a",
          herdr_machine: "worker-a",
          os: "darwin",
          arch: "arm64",
          tags: ["fixture-only"],
        });
      tx.cards.put(project, { ...card(), project_id: project });
      tx.roles.put(project, { ...role("coder"), worktree: "none" });
      tx.work_items.put(project, {
        id: id("work_item", 1),
        card_id: card().id,
        kind: "produce",
        title: "Build",
        role_id: "coder",
        required: true,
        status: "ready",
        completion_criteria: [],
        depends_on: [],
      });
      tx.assignments.put("other", { ...assignment(), machine_id: "worker-a" });
      tx.runs.put("other", run());
    });
    const actor = { kind: "system", project_id: project } as const;
    beginMachineObservation(store, actor, project, "worker-a", "check", now);
    completeMachineObservation(
      store,
      actor,
      project,
      "worker-a",
      "check",
      { status: "passed", checked_at: now, blockers: [], launch_enabled: true },
      [
        {
          key: "godot",
          version: "4.10",
          verified_at: now,
          evidence_ref: "fixture",
        },
      ],
    );
    configureMachinePlacement(
      store,
      root,
      env,
      await loadRunCapacityConfig({ env }),
    );
    const read = (p = project, t = now) =>
      store.uow.run((tx) =>
        loadCommandState(tx, p).read_machine_placement?.(p, t).get("worker-a"),
      );
    expect(read()).toMatchObject({
      remote_binding: "allowed",
      limit: 6,
      occupied: 1,
      health: { available: true },
      capabilities: [{ key: "godot", available: true }],
    });
    expect(read("other")).toMatchObject({
      remote_binding: "disabled",
      health: null,
      capabilities: [],
    });
    const select = (required_tags: string[]) =>
      store.uow.run((tx) =>
        value(
          assignOrDefer(
            loadCommandState(tx, project),
            { kind: "human", project_id: project },
            {
              work_item_id: id("work_item", 1),
              role_id: "coder",
              required_tags,
            },
            ports(),
          ),
        ),
      );
    expect(select(["fixture-only"]).data).toMatchObject({
      machine_id: "worker-a",
    });
    for (const platform of [{ os: "linux" }, { arch: "x64" }]) {
      write(true, platform);
      expect(read()).toMatchObject({
        remote_binding: "platform_mismatch",
        health: { available: true },
      });
      const fallback = select([]);
      expect(fallback.data).toMatchObject({ machine_id: "local" });
      expect(fallback.events.at(-1)).toMatchObject({
        type: "machine_selected",
        payload: {
          excluded: [
            {
              machine_id: "worker-a",
              reasons: [expect.stringContaining("OS 或架构与机器登记不一致")],
            },
          ],
        },
      });
      const gap = select(["fixture-only"]);
      expect(gap.data).toMatchObject({ deferred: true });
      expect(gap.events).toMatchObject([
        {
          type: "system_assignment_deferred",
          payload: {
            reason: expect.stringContaining("OS 或架构与机器登记不一致"),
          },
        },
      ]);
      expect(gap.token_requests).toEqual([]);
      expect(gap.changes).toEqual([]);
    }
    write(false);
    expect(read()).toMatchObject({
      remote_binding: "disabled",
      health: { available: true },
    });
    expect(
      read(
        project,
        new Date(
          Date.parse(now) + MACHINE_OBSERVATION_TTL_MS + 1,
        ).toISOString(),
      ),
    ).toMatchObject({
      health: { available: false },
      capabilities: [{ available: false }],
    });
  } finally {
    store.close();
  }
});
