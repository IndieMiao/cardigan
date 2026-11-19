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
import { assignOrDefer, saveMachine } from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import { parseLaunchConfig } from "@cardigan/roles";
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
import { refreshMachineObservations } from "./machine-capabilities.js";
import { BUILTIN_MACHINE_CAPABILITIES } from "./machine-capability-catalog.js";
import { configureMachinePlacement } from "./machine-placement.js";
import { loadRunCapacityConfig } from "./run-capacity-config.js";
import { RuntimeTargets } from "./runtime-targets.js";
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
    generation = "one",
    user = "project_a",
  ) =>
    writeFileSync(
      join(root, "runtime-workers.yaml"),
      JSON.stringify({
        ...config,
        machines: config.machines.map((m) => ({
          ...m,
          ...platform,
          projects: m.projects.map((p) => ({
            ...p,
            allow_remote_launch,
            generation,
            user,
            publication: {
              header_max_bytes: 4096,
              file_max_bytes: 2048,
              batch_max_bytes: 8192,
              timeout_ms: 2000,
            },
            python: "/usr/bin/python3",
            git_helper: "/opt/worker/worker-git.py",
            file_helper: "/opt/worker/worker-files.py",
          })),
        })),
      }),
      { mode: 0o600 },
    );
  try {
    write(true);
    writeFileSync(
      join(root, "run-capacity.yaml"),
      "machines: {worker-a: {limit: 6, resources: {godot: 2}}}",
      {
        mode: 0o600,
      },
    );
    for (const p of [project, "other"]) store.createProject({ id: p });
    store.uow.run((tx) => {
      tx.machines.put(project, {
        ...machine(),
        label: "Worker A",
        id: "worker-a",
        herdr_machine: "worker-a",
        os: "darwin",
        arch: "arm64",
        tags: ["fixture-only"],
      });
      tx.cards.put(project, { ...card(), project_id: project });
      tx.roles.put(project, {
        ...role("coder"),
        launch_profile_ref: "role-profile",
        worktree: "none",
      });
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
          key: "harness.codex",
          version: "1.2.3",
          verified_at: now,
          evidence_ref: "fixture",
        },
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
      () =>
        parseLaunchConfig({
          providers: {},
          profiles: {
            "role-profile": { harness: "codex" },
            personal: { harness: "claude-code" },
          },
        }),
    );
    const read = (p = project, t = now) =>
      store.uow.run((tx) =>
        loadCommandState(tx, p)
          .read_machine_placement?.(p, t)
          .machines.get("worker-a"),
      );
    expect(read()).toMatchObject({
      remote_binding: "allowed",
      limit: 6,
      occupied: 0,
      health: { available: true },
      capabilities: [
        { key: "godot", available: true },
        { key: "harness.codex", available: true },
      ],
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
    // Legacy observations have no binding, even if the TTL and version are valid.
    expect(select(["fixture-only"]).data).toMatchObject({
      deferred: true,
      reason: expect.stringContaining("绑定"),
    });
    const runtime = await RuntimeTargets.create({
      execution: { mode: "local", dataDir: root },
      store,
      env,
    });
    if (!runtime.ok) throw new Error("Invalid fixture runtime");
    const refresh = (hasCodex = true) =>
      refreshMachineObservations({
        store,
        project,
        machine: "worker-a",
        now: () => now,
        target: () => runtime.value.resolve(project, "worker-a"),
        check: async () => ({ blockers: [], launch_enabled: true }),
        catalog: () =>
          BUILTIN_MACHINE_CAPABILITIES.filter((c) =>
            ["harness.codex", "godot"].includes(c.key),
          ),
        probe: async (_exec, _os, command) => ({
          ok: hasCodex || command[0] !== "codex",
          output: "4.10",
        }),
      });
    await refresh();
    expect(select(["fixture-only"]).data).toMatchObject({
      machine_id: "worker-a",
    });
    // Change the registry and private config together. Neither a shared machine ID
    // nor the current registry/config agreement proves what was actually probed.
    for (const platform of [
      { os: "darwin", arch: "x64" }, // architecture only
      { os: "linux", arch: "x64" }, // OS only
      { os: "darwin", arch: "arm64" },
    ]) {
      write(true, platform);
      store.uow.run((tx) => {
        const machine = tx.machines.get(project, "worker-a");
        if (!machine) throw new Error("Missing worker fixture");
        persistEffect(
          tx,
          project,
          value(
            saveMachine(
              loadCommandState(tx, project),
              { kind: "human", project_id: project },
              { operation: "update", machine: { ...machine, ...platform } },
              { clock: ports().clock, ids: tx.ids },
            ),
          ),
        );
      });
      expect(read()).toMatchObject({
        remote_binding: "allowed",
        health: { available: true },
      });
      expect(select(["fixture-only"]).data).toMatchObject({
        deferred: true,
        reason: expect.stringContaining("harness.codex"),
      });
      expect(select([]).events.at(-1)).toMatchObject({
        type: "machine_selected",
        payload: {
          excluded: [
            {
              machine_id: "worker-a",
              reasons: [expect.stringContaining("平台")],
            },
          ],
        },
      });
      await refresh(false);
      expect(select(["fixture-only"]).data).toMatchObject({
        deferred: true,
        reason: expect.stringContaining("harness.codex：未验证"),
      });
      await refresh();
      expect(select(["fixture-only"]).data).toMatchObject({
        machine_id: "worker-a",
      });
    }
    store.uow.run((tx) => {
      const shared = tx.machines.get(project, "worker-a");
      if (!shared) throw new Error("Missing worker fixture");
      tx.machines.put("other", shared);
      tx.assignments.put("other", { ...assignment(), machine_id: "worker-a" });
      tx.runs.put("other", { ...run(), resource_keys: ["godot"] });
    });
    expect(read()).toMatchObject({
      occupied: 1,
      resources: new Map([["godot", { limit: 2, occupied: 1 }]]),
    });
    // The same physical worker serves both projects. A queued owner is forecast once;
    // moving into a real Run slot replaces (not adds to) that forecast.
    store.uow.run((tx) => {
      const item = tx.work_items.get(project, id("work_item", 1));
      if (!item) throw new Error("Missing work item");
      tx.work_items.put("other", { ...item, assignment_id: assignment().id });
      tx.runs.put("other", { ...run(), status: "queued" });
    });
    expect(read()).toMatchObject({ occupied: 1, pending_assignments: 1 });
    store.uow.run((tx) => tx.runs.put("other", run()));
    expect(read()).toMatchObject({ occupied: 1, pending_assignments: 0 });
    store.uow.run((tx) =>
      tx.runs.put("other", { ...run(), status: "completed" }),
    );
    expect(read()).toMatchObject({ occupied: 0, pending_assignments: 0 });
    expect(read("other")).toMatchObject({
      remote_binding: "disabled",
      health: null,
      capabilities: [],
    });
    // Exercise the actual transaction reader and employee-over-role profile precedence.
    const employee = {
      id: id("employee", 1),
      name: "Worker",
      title: "Coder",
      bio: "",
      avatar: null,
      role_id: "coder",
      status: "active" as const,
      created_at: now,
      updated_at: now,
    };
    store.uow.run((tx) =>
      tx.employees.put({ ...employee, launch_profile_ref: "personal" }),
    );
    expect(select([]).events.at(-1)).toMatchObject({
      type: "machine_selected",
      payload: {
        machine_id: "local",
        excluded: [
          { machine_id: "worker-a", reasons: ["harness.claude-code：未验证"] },
        ],
      },
    });
    store.uow.run((tx) =>
      tx.employees.put({ ...employee, launch_profile_ref: "unknown" }),
    );
    expect(select(["fixture-only"]).data).toMatchObject({
      deferred: true,
      reason: expect.stringContaining("启动配置未知"),
    });
    store.uow.run((tx) =>
      tx.employees.put({ ...employee, launch_profile_ref: null }),
    );
    expect(select(["fixture-only"]).data).toMatchObject({
      machine_id: "worker-a",
    });
    // Same project, machine ID and platform: account and generation each invalidate launch proof.
    for (const [generation, user] of [
      ["one", "project_b"],
      ["two", "project_b"],
    ] as const) {
      write(true, {}, generation, user);
      expect(select([]).events.at(-1)).toMatchObject({
        type: "machine_selected",
        payload: {
          machine_id: "local",
          excluded: [
            {
              machine_id: "worker-a",
              reasons: [expect.stringContaining("绑定")],
            },
          ],
        },
      });
      await refresh();
      expect(select(["fixture-only"]).data).toMatchObject({
        machine_id: "worker-a",
      });
    }
    write(true);
    await refresh();
    const setPolicy = (worktree: "none" | "write") =>
      store.uow.run((tx) => {
        tx.roles.put(project, {
          ...role("coder"),
          launch_profile_ref: "role-profile",
          worktree,
        });
      });
    setPolicy("write");
    expect(select(["fixture-only"]).data).toMatchObject({ deferred: true });
    const proof = {
      target_fingerprint: runtime.value.resolve(project, "worker-a").execution
        .target?.fingerprint,
      os: "darwin",
      arch: "arm64",
      evidence_ref: "fixture-acceptance",
      verified_at: now,
      expires_at: "2026-01-01T01:00:00.000Z",
    };
    const file = join(root, "worktree-preparation.yaml");
    const attest = (key: string, patch: object = {}) =>
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          bindings: { [key]: { ...proof, ...patch } },
        }),
        { mode: 0o600 },
      );
    const key = `${project}/worker-a`;
    for (const other of [`${project}/worker-b`, "other/worker-a"]) {
      attest(other);
      expect(read()?.worktree_preparation).toBe("missing");
    }
    attest(key);
    expect(select(["fixture-only"]).data).toMatchObject({
      machine_id: "worker-a",
    });
    expect(read(project, proof.expires_at)?.worktree_preparation).toBe(
      "expired",
    );
    expect(
      read(project, "2025-12-31T23:59:59.999Z")?.worktree_preparation,
    ).toBe("invalid");
    write(true, {}, "two");
    expect(read()?.worktree_preparation).toBe("invalid");
    write(true);
    for (const patch of [
      { os: "linux" },
      { arch: "x64" },
      { target_fingerprint: "wrong" },
      { evidence_ref: " " },
      { expires_at: "invalid" },
      { verified_at: "2026-02-30" },
      { enabled: false },
    ]) {
      attest(key, patch);
      expect(read()?.worktree_preparation).toBe("invalid");
    }
    attest(key);
    chmodSync(file, 0o644);
    expect(select(["fixture-only"]).data).toMatchObject({ deferred: true });
    rmSync(file);
    expect(read()?.worktree_preparation).toBe("missing");
    setPolicy("none");
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
      capabilities: [
        { key: "godot", available: false },
        { key: "harness.codex", available: false },
      ],
    });
  } finally {
    store.close();
  }
});
