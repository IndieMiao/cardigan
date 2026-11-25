import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Runtime } from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { defaultRoleDefinition } from "@cardigan/roles";
import { HC_RELEASE, HerdrRuntime } from "@cardigan/runtime-herdr";
import { Store, writeRole } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import {
  fixture,
  human,
  run,
} from "../../domain/src/commands/test-fixtures.js";
import { upgradeIdleAssignmentRoles } from "./assignment-role-upgrade.js";
import { issueAssignmentToken, launchEntities } from "./commands.js";
import {
  deploymentRolePolicyHash,
  upgradeDeployedRoles,
} from "./deployment-roles.js";
import { recordDefault } from "./role-provenance.js";

test.each([false, true])(
  "maintenance upgrades an exited owner after confirming its fence; manual conflict=%s",
  async (manual) => {
    const dir = await mkdtemp("/tmp/cg-role-upgrade-");
    const store = Store.open({ dbPath: join(dir, "test.db") });
    let time = Date.parse("2030-01-01T00:00:00Z");
    const clock = { now: () => new Date(time).toISOString() };
    try {
      const state = fixture(),
        owner = {
          ...state.assignments[0]!,
          worktree_path: dir,
          branch: "agent/keep",
          session_ref: "old-session",
          employee_id: "E-1" as never,
          runtime_ref: {
            runtime_machine: "local",
            terminal_ref: "t-old",
            agent_name: "fixture",
            worktree_path: dir,
          },
        };
      store.createProject({ id: human.project_id });
      await writeFile(join(dir, "dirty.txt"), "uncommitted work");
      const source = defaultRoleDefinition("coder", {
        harness: "codex",
        launch_profile_ref: "fixture",
      });
      const token = store.uow.run((tx) => {
        tx.cards.put(human.project_id, state.cards[0]!);
        tx.work_items.put(human.project_id, state.work_items[0]!);
        tx.assignments.put(human.project_id, owner);
        tx.runs.put(human.project_id, state.runs[0]!);
        const previous = {
          ...source,
          allowed_tools: source.allowed_tools.filter(
            (t) => t !== "request_check",
          ),
        };
        writeRole(
          tx,
          human.project_id,
          { ...previous, version: 1 },
          { mode: "add" },
        );
        // An earlier deployment recorded v1 as its default.
        recordDefault(
          tx,
          human.project_id,
          "coder",
          previous,
          "pack",
          clock.now(),
        );
        writeRole(
          tx,
          human.project_id,
          {
            ...source,
            version: 2,
            ...(manual ? { instructions: "Local manual rule" } : {}),
          },
          { mode: "update" },
        );
        return tx.issueToken({
          project_id: human.project_id,
          assignment_id: owner.id,
          role: { role_version: 1, allowed_tools: ["get_card"] },
        });
      });
      // A stable, completed publication is required before declaring a manual conflict.
      upgradeDeployedRoles(
        store,
        human.project_id,
        [],
        {
          coder: deploymentRolePolicyHash(source),
        },
        new Set(["fixture"]),
      );
      let exited = false;
      let confirmExit!: () => void;
      const release = vi.fn();
      let observations = 0;
      const runtime = {
        release,
        status: vi.fn(async () => {
          if (exited && !manual && ++observations === 2)
            await new Promise<void>((resolve) => {
              confirmExit = resolve;
            });
          return {
            ok: true as const,
            value: {
              process: exited ? "exited" : "alive",
              agent: "idle",
              observed_seq: 1,
            },
          };
        }),
      } as unknown as Runtime;
      // Running work stays pinned and its token stays valid.
      await upgradeIdleAssignmentRoles(store, human.project_id, runtime, clock);
      expect(release).not.toHaveBeenCalled();
      expect(store.verifyToken(token.token)).toBeTruthy();
      store.uow.run((tx) =>
        tx.runs.put(human.project_id, {
          ...state.runs[0]!,
          status: "completed",
          outcome: "completed",
        }),
      );
      // Even an idle live terminal is retained, including its token.
      await upgradeIdleAssignmentRoles(store, human.project_id, runtime, clock);
      expect(store.verifyToken(token.token)).toBeTruthy();
      expect(release).not.toHaveBeenCalled();
      exited = true;
      if (manual) {
        await upgradeIdleAssignmentRoles(
          store,
          human.project_id,
          runtime,
          clock,
        );
        expect(release).not.toHaveBeenCalled();
        expect(store.verifyToken(token.token)).toBeTruthy();
        await upgradeIdleAssignmentRoles(
          store,
          human.project_id,
          runtime,
          clock,
        );
        expect(
          store.uow.read((tx) => tx.human_actions.list(human.project_id)),
        ).toHaveLength(1);
        return;
      }
      const first = upgradeIdleAssignmentRoles(
        store,
        human.project_id,
        runtime,
        clock,
      );
      await vi.waitFor(() => expect(confirmExit).toBeDefined());
      expect(store.verifyToken(token.token)).toBeUndefined();
      expect(() =>
        issueAssignmentToken(
          store,
          human.project_id,
          launchEntities(store, human.project_id, owner.id),
        ),
      ).toThrow("upgrade is pending");
      await upgradeIdleAssignmentRoles(store, human.project_id, runtime, clock);
      expect(observations).toBe(2); // The host lock excludes another controller.
      expect(release).not.toHaveBeenCalled();
      // Contradictory evidence keeps the fence; it never triggers kill/rm.
      exited = false;
      confirmExit();
      await first;
      expect(
        store.uow.read(
          (tx) => tx.assignments.get(human.project_id, owner.id)?.role_upgrade,
        ),
      ).toBeDefined();
      time += 60_000;
      exited = true;
      await upgradeIdleAssignmentRoles(store, human.project_id, runtime, clock);
      await upgradeIdleAssignmentRoles(store, human.project_id, runtime, clock);
      const after = store.uow.read((tx) =>
        loadCommandState(tx, human.project_id),
      );
      expect(after.assignments).toMatchObject([
        {
          id: owner.id,
          employee_id: owner.employee_id,
          branch: owner.branch,
          worktree_path: dir,
          role_version: 2,
          runtime_ref: null,
        },
      ]);
      expect(after.assignments[0]?.session_ref).toBeUndefined();
      const refreshed = issueAssignmentToken(
        store,
        human.project_id,
        launchEntities(store, human.project_id, owner.id),
      );
      expect(refreshed.record.role_version).toBe(2);
      expect(refreshed.record.allowed_tools).toContain("request_check");
      expect(refreshed.record.allowed_tools).toContain("get_check_log");
      const repeated = issueAssignmentToken(
        store,
        human.project_id,
        launchEntities(store, human.project_id, owner.id),
      );
      expect(repeated.record.allowed_tools).toEqual(
        refreshed.record.allowed_tools,
      );
      expect(
        after.events.filter((e) => e.type === "session_replaced"),
      ).toHaveLength(1);
      expect(await readFile(join(dir, "dirty.txt"), "utf8")).toBe(
        "uncommitted work",
      );
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("unaudited version changes and same-version token replacement retain the existing tool ceiling", () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    const state = fixture(),
      owner = { ...state.assignments[0]!, role_version: 2 };
    const source = defaultRoleDefinition("coder", {
      harness: "codex",
      launch_profile_ref: "fixture",
    });
    store.createProject({ id: human.project_id });
    store.uow.run((tx) => {
      tx.assignments.put(human.project_id, owner);
      tx.issueToken({
        project_id: human.project_id,
        assignment_id: owner.id,
        role: { role_version: 1, allowed_tools: ["get_card"] },
      });
    });
    const entities = { assignment: owner, role: { ...source, version: 2 } };
    const first = issueAssignmentToken(store, human.project_id, entities);
    expect(first.record.allowed_tools).toEqual(["get_card"]);
    const next = issueAssignmentToken(store, human.project_id, entities);
    expect(next.record.allowed_tools).toEqual(["get_card"]);
  } finally {
    store.close();
  }
});

function batchFixture() {
  const store = Store.open({ dbPath: ":memory:" });
  const state = fixture(),
    source = defaultRoleDefinition("coder", {
      harness: "codex",
      launch_profile_ref: "fixture",
    });
  store.createProject({ id: human.project_id });
  store.uow.run((tx) => {
    writeRole(
      tx,
      human.project_id,
      { ...source, version: 1, allowed_tools: ["get_card"] },
      { mode: "add" },
    );
    writeRole(
      tx,
      human.project_id,
      { ...source, version: 2 },
      { mode: "update" },
    );
    for (let i = 1; i <= 5; i++) {
      const card = { ...state.cards[0]!, id: `C-${i}` as never };
      const item = {
        ...state.work_items[0]!,
        id: `W-${i}` as never,
        card_id: card.id,
        assignment_id: `A-${i}` as never,
      };
      tx.cards.put(human.project_id, card);
      tx.work_items.put(human.project_id, item);
      tx.assignments.put(human.project_id, {
        ...state.assignments[0]!,
        id: item.assignment_id,
        scope: "work_item",
        work_item_id: item.id,
        runtime_ref: {
          machine_id: "local",
          runtime_machine: "local",
          terminal_ref: `t${i}`,
          agent_name: `fixture-${i}`,
        },
      });
    }
  });
  const gone = new Set<string>();
  const release = vi.fn(async (ref: { terminal_ref: string }) => {
    gone.add(ref.terminal_ref);
    return { ok: true as const, value: undefined };
  });
  const runtime = {
    release,
    status: vi.fn(async (ref: { terminal_ref: string }) =>
      gone.has(ref.terminal_ref)
        ? {
            ok: false as const,
            error: { code: "runtime_not_found" as const, message: "gone" },
          }
        : {
            ok: true as const,
            value: {
              process: "exited" as const,
              agent: "idle" as const,
              observed_seq: 1,
            },
          },
    ),
  } as unknown as Runtime;
  return {
    store,
    runtime,
    release,
    gone,
    clock: { now: () => "2030-01-01T00:00:00Z" },
  };
}

test.each(["unknown", "idle", "done", "error", "working", "blocked"] as const)(
  "a live %s terminal keeps its token even after long control-plane silence",
  async (agent) => {
    const f = batchFixture();
    const owner = f.store.uow.read((tx) =>
      tx.assignments.get(human.project_id, "A-1"),
    )!;
    f.store.uow.run((tx) => {
      for (const a of tx.assignments.list(human.project_id))
        tx.assignments.put(human.project_id, {
          ...a,
          status: a.id === owner.id ? "active" : "released",
          last_mcp_activity_at: "2029-12-01T00:00:00Z",
        });
      tx.runs.put(human.project_id, {
        ...run(),
        status: "completed",
        finished_at: "2029-12-01T00:00:00Z",
      });
    });
    const token = f.store.issueToken({
      project_id: human.project_id,
      assignment_id: owner.id,
      role: { role_version: 1, allowed_tools: ["get_card"] },
    });
    let now = f.clock.now();
    let finished = false;
    let assignment = owner.id;
    const terminal = () => ({
      address: owner.runtime_ref!.terminal_ref,
      state: finished ? "finished" : "live",
      status: agent === "unknown" ? null : { state: agent },
      keep: true,
      labels: { project: human.project_id, assignment },
    });
    const client = {
      available: async () => true,
      exec: vi.fn(async (args: readonly string[]) =>
        args[0] === "--version"
          ? `hc ${HC_RELEASE.version}`
          : JSON.stringify(terminal()),
      ),
      async *lines() {
        yield JSON.stringify({ seq: 100, terminals: [terminal()] });
      },
    };
    const created = await HerdrRuntime.create({ client, session: "fixture" });
    if (!created.ok) throw new Error(created.error.message);
    const tick = () =>
      upgradeIdleAssignmentRoles(f.store, human.project_id, created.value, {
        now: () => now,
      });
    const current = () =>
      f.store.uow.read((tx) => tx.assignments.get(human.project_id, owner.id))!;
    const retry = () => {
      const at = current().idle_retirement?.retry_at;
      if (!at) throw new Error("Missing retirement retry time");
      expect(Date.parse(at)).toBeGreaterThan(Date.parse(now));
      now = at;
      return tick();
    };
    try {
      client.exec.mockClear();
      await tick();
      expect(client.exec.mock.calls.map(([args]) => args[0])).toEqual(["get"]);
      expect(f.store.verifyToken(token.token)).toBeTruthy();
      expect(current()).toMatchObject({
        role_version: 1,
        runtime_ref: owner.runtime_ref,
        idle_retirement: {
          phase: "waiting",
          evidence: { reason: "kept_terminal" },
        },
      });
      expect(current().role_upgrade).toBeUndefined();

      // Neither an early tick nor another owner's finished terminal proves exit.
      finished = true;
      client.exec.mockClear();
      await tick();
      expect(client.exec).not.toHaveBeenCalled();
      expect(f.store.verifyToken(token.token)).toBeTruthy();
      assignment = "A-2";
      await retry();
      expect(f.store.verifyToken(token.token)).toBeTruthy();
      expect(current().runtime_ref).toEqual(owner.runtime_ref);

      assignment = owner.id;
      await retry();
      expect(f.store.verifyToken(token.token)).toBeUndefined();
      expect(current()).toMatchObject({ role_version: 2, runtime_ref: null });
      expect(client.exec.mock.calls.map(([args]) => args[0])).toEqual([
        "get",
        "get",
      ]);
    } finally {
      f.store.close();
    }
  },
);

test("new work observed during the exit probe prevents fencing and token revocation", async () => {
  const f = batchFixture();
  const token = f.store.issueToken({
    project_id: human.project_id,
    assignment_id: "A-1",
    role: { role_version: 1, allowed_tools: ["get_card"] },
  });
  const status = vi.mocked(f.runtime.status).getMockImplementation()!;
  vi.mocked(f.runtime.status).mockImplementationOnce(async (ref) => {
    f.store.uow.run((tx) => tx.runs.put(human.project_id, run()));
    return status(ref);
  });
  try {
    await upgradeIdleAssignmentRoles(
      f.store,
      human.project_id,
      f.runtime,
      f.clock,
    );
    expect(f.store.verifyToken(token.token)).toBeTruthy();
    expect(
      f.store.uow.read((tx) => tx.assignments.get(human.project_id, "A-1")),
    ).toMatchObject({ role_version: 1 });
    expect(
      f.store.uow.read(
        (tx) => tx.assignments.get(human.project_id, "A-1")?.role_upgrade,
      ),
    ).toBeUndefined();
    expect(f.release).not.toHaveBeenCalled();
  } finally {
    f.store.close();
  }
});

test("a failed backoff write retains its fence and does not block the next candidate", async () => {
  const f = batchFixture();
  const uow = f.store.uow;
  let failBackoff = false;
  const write = vi.spyOn(f.store, "uow", "get").mockReturnValue({
    ...uow,
    run: (work) => {
      if (failBackoff) {
        failBackoff = false;
        throw new Error("Injected backoff write failure");
      }
      return uow.run(work);
    },
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const status = vi.mocked(f.runtime.status).getMockImplementation()!;
  vi.mocked(f.runtime.status)
    .mockImplementationOnce(status)
    .mockImplementationOnce(async () => {
      failBackoff = true;
      throw new Error("Injected exit confirmation failure");
    });
  try {
    await upgradeIdleAssignmentRoles(
      f.store,
      human.project_id,
      f.runtime,
      f.clock,
    );
    expect(log).toHaveBeenCalledOnce();
    expect(f.release).not.toHaveBeenCalled();
    const owners = f.store.uow.read((tx) =>
      tx.assignments.list(human.project_id),
    );
    expect(owners.find((a) => a.id === "A-1")).toMatchObject({
      role_version: 1,
      role_upgrade: { role_version: 2 },
    });
    expect(owners.find((a) => a.id === "A-2")).toMatchObject({
      role_version: 2,
      runtime_ref: null,
    });
  } finally {
    write.mockRestore();
    log.mockRestore();
    f.store.close();
  }
});

test("a maintenance pass replaces at most two sessions and leaves later owners for subsequent passes", async () => {
  const f = batchFixture();
  try {
    for (const expected of [2, 4, 5]) {
      await upgradeIdleAssignmentRoles(
        f.store,
        human.project_id,
        f.runtime,
        f.clock,
      );
      expect(
        f.store.uow.read((tx) =>
          tx.assignments
            .list(human.project_id)
            .filter((a) => a.role_version === 2),
        ),
      ).toHaveLength(expected);
      expect(f.release).not.toHaveBeenCalled();
    }
  } finally {
    f.store.close();
  }
});

test("concurrent maintenance controllers share the two-session reservation limit", async () => {
  const f = batchFixture(),
    finish: (() => void)[] = [];
  const probes = new Map<string, number>();
  const status = vi.mocked(f.runtime.status).getMockImplementation()!;
  vi.mocked(f.runtime.status).mockImplementation(async (ref) => {
    const count = (probes.get(ref.terminal_ref) ?? 0) + 1;
    probes.set(ref.terminal_ref, count);
    if (count === 2) await new Promise<void>((resolve) => finish.push(resolve));
    return status(ref);
  });
  const first = upgradeIdleAssignmentRoles(
    f.store,
    human.project_id,
    f.runtime,
    f.clock,
  );
  await vi.waitFor(() => expect(finish).toHaveLength(1));
  const second = upgradeIdleAssignmentRoles(
    f.store,
    human.project_id,
    f.runtime,
    f.clock,
  );
  await vi.waitFor(() => expect(finish).toHaveLength(2));
  try {
    await upgradeIdleAssignmentRoles(
      f.store,
      human.project_id,
      f.runtime,
      f.clock,
    );
    expect(f.release).not.toHaveBeenCalled();
    expect(f.runtime.status).toHaveBeenCalledTimes(4);
    expect(
      f.store.uow.read((tx) =>
        tx.assignments.list(human.project_id).filter((a) => a.role_upgrade),
      ),
    ).toHaveLength(2);
    f.store.uow.run((tx) => {
      for (const a of tx.assignments.list(human.project_id))
        if (!a.role_upgrade)
          tx.assignments.put(human.project_id, { ...a, status: "released" });
    });
  } finally {
    for (const done of finish) done();
    await Promise.all([first, second]);
    f.store.close();
  }
});
