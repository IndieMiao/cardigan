import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveRunLimit, loadRunCapacityConfig } from "@cardigan/host";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { m5Cross, TEST_PASSWORD } from "../../test-support/m5-cross.js";
import { executionCapacity } from "./execution-capacity.js";

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
        { ...machine, label: configured ?? "local" },
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
