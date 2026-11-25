import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireMergeCheckCapacity,
  effectiveRunLimit,
  loadRunCapacityConfig,
} from "@cardigan/host";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import {
  assignment,
  fixture,
  run,
} from "../../../../packages/domain/src/commands/test-fixtures.js";
import { m5Cross, TEST_PASSWORD } from "../../test-support/m5-cross.js";
import {
  CAPACITY_REFRESH_MS,
  ExecutionCapacityCache,
  executionCapacity,
  executionCapacityInputs,
  executionCapacityRevision,
} from "./execution-capacity.js";

test("MC-5 exposes configured resource slots per machine, sorted, without unconfigured keys", () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    store.createProject({ id: "first" });
    store.uow.run((tx) => {
      const item = fixture().work_items[0];
      if (!item) throw new Error("Missing fixture");
      tx.work_items.put("first", item);
      const owner = assignment(1);
      tx.assignments.put("first", owner);
      tx.runs.put("first", {
        ...run(1),
        status: "running",
        resource_keys: ["godot", "blender", "unconfigured"],
      });
    });
    const limits = (machine: string) =>
      machine === "local"
        ? new Map([
            ["ios.simulator", 1],
            ["blender", 2],
          ])
        : new Map<string, number>();
    const result = executionCapacity(
      store,
      () => 4,
      undefined,
      () => 24,
      undefined,
      limits,
    );
    expect(
      result.agents.map(({ machine_id, resources }) => ({
        machine_id,
        resources,
      })),
    ).toEqual([
      {
        machine_id: "local",
        resources: [
          { key: "blender", occupied: 1, limit: 2 },
          { key: "ios.simulator", occupied: 0, limit: 1 },
        ],
      },
    ]);
    // Without trusted limits nothing is configured, so nothing is shown.
    expect(executionCapacity(store).agents[0]?.resources).toEqual([]);
  } finally {
    store.close();
  }
});

test("legacy assignments without machine registration fall back to configured name, then ID", () => {
  const store = Store.open({ dbPath: ":memory:" });
  const project = "legacy-capacity";
  const created_at = "2026-01-01T00:00:00.000Z";
  try {
    // Model already-persisted legacy data, not a new project with automatic local registration.
    store.uow.run((tx) => {
      store.database
        .prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)")
        .run(project, "Legacy fixture", created_at);
      tx.assignments.put(project, {
        id: "A-1",
        scope: "standing",
        role_id: "pm",
        role_version: 1,
        status: "active",
        runtime_state: "not_provisioned",
        machine_id: "local",
        runtime_ref: null,
        mcp_token_id: "fixture-token-reference",
        created_at,
      });
    });
    const machine = {
      machine_id: "local",
      running: 0,
      total_running: 0,
      limit: 4,
      max_limit: 24,
      queued: 0,
      merge_check_slots: 0,
    };
    for (const configured of ["Workstation", undefined]) {
      const result = executionCapacity(
        store,
        () => 4,
        undefined,
        () => 24,
        () => configured,
      );
      expect(result.agents).toEqual([
        { ...machine, label: configured ?? "local", resources: [] },
      ]);
      expect(store.uow.read((tx) => tx.machines.list(project))).toEqual([]);
    }
  } finally {
    store.close();
  }
});

test.each([undefined, 8, 24])(
  "HTTP enforces the host ceiling %s and exposes it to the input",
  async (maximum) => {
    const configDir = await mkdtemp(join(tmpdir(), "execution-capacity-"));
    await writeFile(
      join(configDir, "run-capacity.yaml"),
      maximum === undefined
        ? "machines: {}\n"
        : `machines: { local: { limit: 4, max_limit: ${maximum}, display_name: Workstation } }\n`,
      { mode: 0o600 },
    );
    const config = await loadRunCapacityConfig({ configDir });
    const f = await m5Cross({
      runLimit: config.forMachine,
      runLimitMaximum: config.maxForMachine,
      machineDisplayName: config.displayNameForMachine,
    });
    try {
      await f.password(TEST_PASSWORD);
      await f.login();
      const cap = maximum ?? 16;
      const path = f.projectPath("/execution/capacity");
      const save = (limit: number, extra = {}) =>
        f.call(path, {
          method: "POST",
          body: { machine_id: "local", limit, ...extra },
          headers: { "idempotency-key": `cap-${limit}` },
        });
      // New projects have a real local registration, which takes precedence over YAML display_name.
      expect(
        f
          .store()
          .uow.read((tx) => tx.machines.get(f.project.project_id, "local")),
      ).toMatchObject({ id: "local", label: "local" });
      expect((await f.call(path)).json).toMatchObject({
        agents: [
          {
            machine_id: "local",
            label: "local",
            limit: 4,
            max_limit: cap,
          },
        ],
      });
      const rejected = await save(cap + 1);
      expect(rejected.status).toBe(400);
      expect(rejected.json).toMatchObject({
        error: { message: `并发上限不能超过 ${cap}。` },
      });
      expect((await save(cap + 1, { max_limit: cap + 1 })).status).toBe(400);
      expect(
        f
          .store()
          .uow.read((tx) =>
            tx.global_events
              .listAfter(0)
              .filter((e) => e.type === "run_capacity_updated"),
          ),
      ).toHaveLength(0);
      expect((await save(cap)).status).toBe(200);
      expect((await f.call(path)).json).toMatchObject({
        agents: [{ limit: cap }],
      });
      expect(
        effectiveRunLimit(f.store(), "local", config.forMachine, () => 2),
      ).toBe(2);
      expect(
        effectiveRunLimit(
          f.store(),
          "local",
          config.forMachine,
          config.maxForMachine,
        ),
      ).toBe(cap);

      f.store().uow.run((tx) =>
        tx.machines.put(f.project.project_id, {
          id: "local",
          label: "Registered workstation",
          status: "online",
          herdr_machine: "local",
          os: "linux",
          arch: "x64",
          tags: [],
          max_assignments: 4,
          last_seen: "2026-11-12T00:00:00.000Z",
        }),
      );
      expect((await f.call(path)).json).toMatchObject({
        agents: [{ label: "Registered workstation" }],
      });
    } finally {
      await f.close();
      await rm(configDir, { recursive: true, force: true });
    }
  },
);

test("C-145 human session alone edits capacity, with validation, idempotency and global audit", async () => {
  const f = await m5Cross();
  try {
    const path = f.projectPath("/execution/capacity");
    const write = (
      body: unknown,
      key?: string,
      headers: Record<string, string> = {},
      anonymous = false,
    ) =>
      f.call(path, {
        method: "POST",
        body,
        headers: { ...headers, ...(key ? { "idempotency-key": key } : {}) },
        anonymous,
      });
    expect((await f.call(path)).status).toBe(401);
    await f.password(TEST_PASSWORD);
    await f.login();
    const input = { machine_id: "local", limit: 6 };
    expect((await write(input)).status).toBe(400);
    for (const role_id of ["coder", "pm", "host_ops"]) {
      // Credential scope does not matter: even a broadly granted Agent token is not a human session.
      const assignment_id = `A-${100 + ["coder", "pm", "host_ops"].indexOf(role_id)}`;
      const { work_item_id: _item, ...base } = f.primary.owner;
      f.store().uow.run((tx) =>
        tx.assignments.put(f.project.project_id, {
          ...base,
          id: assignment_id as never,
          role_id,
          scope: "standing",
          standing_mode: "ops",
        }),
      );
      const token = f.store().issueToken({
        project_id: f.project.project_id,
        assignment_id: assignment_id as never,
        role: {
          role_version: 1,
          allowed_tools: ["whoami", "assign", "host_ops_cancel_run"],
        },
      });
      expect(
        (
          await write(
            input,
            role_id,
            { authorization: `Bearer ${token.token}` },
            true,
          )
        ).status,
      ).toBe(401);
    }
    expect(
      (await write({ ...input, actor: { kind: "human" } }, "spoof")).status,
    ).toBe(400);
    expect(
      (await write({ ...input, max_concurrent: 6 }, "executor")).status,
    ).toBe(400);
    expect(
      (await write({ machine_id: "remote-check-only", limit: 3 }, "unknown"))
        .status,
    ).toBe(404);
    for (const limit of [0, -1, 1.5, "6", null, Number.MAX_SAFE_INTEGER + 1])
      expect(
        (await write({ machine_id: "local", limit }, `invalid-${limit}`))
          .status,
      ).toBe(400);
    const first = await write(input, "first");
    expect(first.status).toBe(200);
    expect((await write(input, "first")).json).toEqual(first.json);
    expect((await write({ ...input, limit: 7 }, "first")).status).toBe(409);
    expect((await write({ ...input, limit: 2 }, "lower")).status).toBe(200);
    expect((await f.call(path)).json).toMatchObject({
      agents: [{ machine_id: "local", limit: 2 }],
      merge_checks: [],
    });
    f.store().createProject({ id: "other" });
    expect(
      (await f.call("/api/projects/other/execution/capacity")).json,
    ).toMatchObject({ agents: [{ machine_id: "local", limit: 2 }] });
    expect(effectiveRunLimit(f.store(), "local", () => 4)).toBe(2);
    expect(effectiveRunLimit(f.store(), "local", () => 0)).toBe(0);
    expect(
      f
        .store()
        .uow.read((tx) =>
          tx.global_events
            .listAfter(0)
            .filter((event) => event.type === "run_capacity_updated"),
        ),
    ).toMatchObject([
      {
        actor: { kind: "human" },
        created_at: expect.any(String),
        payload: {
          machine_id: "local",
          member_id: "M-1",
          old_value: 4,
          new_value: 6,
        },
      },
      { actor: { kind: "human" }, payload: { old_value: 6, new_value: 2 } },
    ]);
  } finally {
    await f.close();
  }
});

test("C-634 rebuilds the shared capacity view only when its counted inputs change or the refresh interval passes", () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    store.createProject({ id: "first" });
    const item = fixture().work_items[0];
    if (!item) throw new Error("Missing fixture");
    store.uow.run((tx) => {
      tx.work_items.put("first", item);
      tx.assignments.put("first", assignment(1));
    });
    let clock = 0;
    let builds = 0;
    const now = "2030-01-01T00:00:00.000Z";
    const cache = new ExecutionCapacityCache({
      now: () => now,
      monotonicMs: () => clock,
      inputs: (at) => executionCapacityInputs(store, at),
      build: (project, at) => {
        builds++;
        return executionCapacity(
          store,
          () => 4,
          undefined,
          undefined,
          undefined,
          undefined,
          project,
          at,
        );
      },
    });
    const idle = cache.read("first");
    expect(idle.revision).toBe(executionCapacityRevision(store, () => 4));
    expect(idle.view.agents).toMatchObject([{ running: 0 }]);
    // Polls without a write share the built view.
    for (let i = 0; i < 5; i++) expect(cache.read("first")).toBe(idle);
    expect(builds).toBe(1);
    // Each project keeps its own view (lease labels name "this project").
    cache.read("second");
    expect(builds).toBe(2);
    // A Run write moves the counters: rebuilt once, then shared again.
    store.uow.run((tx) =>
      tx.runs.put("first", { ...run(1), status: "running" }),
    );
    const running = cache.read("first");
    expect(builds).toBe(3);
    expect(running.revision).not.toBe(idle.revision);
    expect(running.view.agents).toMatchObject([{ running: 1 }]);
    expect(cache.read("first")).toBe(running);
    expect(builds).toBe(3);
    // A human run limit lives outside the counted collections.
    store.database
      .prepare(
        "INSERT INTO run_capacity_limits (machine_id, doc) VALUES (?, ?)",
      )
      .run("local", JSON.stringify({ machine_id: "local", limit: 2 }));
    const limited = cache.read("first");
    expect(builds).toBe(4);
    expect(limited.view.agents).toMatchObject([{ limit: 2 }]);
    // Clock- and process-driven inputs are re-read after the refresh interval;
    // an unchanged view keeps its revision, so clients do not refetch.
    clock += CAPACITY_REFRESH_MS;
    const refreshed = cache.read("first");
    expect(builds).toBe(5);
    expect(refreshed).not.toBe(limited);
    expect(refreshed.revision).toBe(limited.revision);
  } finally {
    store.close();
  }
});

test("C-634 counted capacity inputs follow active leases at the read time and running checks", () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    store.createProject({ id: "first" });
    const before = executionCapacityInputs(store, "2030-01-01T00:00:00.000Z");
    store.database
      .prepare(
        "INSERT INTO machine_resource_leases (generation, machine, resource, project, starts_at, ends_at, endpoints) VALUES ('g1', 'local', 'godot', 'first', '2030-01-01T00:00:00.000Z', '2030-01-01T01:00:00.000Z', '[]')",
      )
      .run();
    const leased = executionCapacityInputs(store, "2030-01-01T00:00:00.000Z");
    expect(leased).not.toBe(before);
    // Once the reservation has ended the inputs match the empty calendar again.
    expect(executionCapacityInputs(store, "2030-01-01T02:00:00.000Z")).toBe(
      before,
    );
    const release = acquireMergeCheckCapacity(store, "first", "check");
    try {
      expect(
        executionCapacityInputs(store, "2030-01-01T02:00:00.000Z"),
      ).not.toBe(before);
    } finally {
      release();
    }
    expect(executionCapacityInputs(store, "2030-01-01T02:00:00.000Z")).toBe(
      before,
    );
  } finally {
    store.close();
  }
});
