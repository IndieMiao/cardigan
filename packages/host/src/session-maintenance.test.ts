import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runtime } from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { defaultRoleDefinition } from "@cardigan/roles";
import { Store, writeRole } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { fixture, human } from "../../domain/src/commands/test-fixtures.js";
import { upgradeIdleAssignmentRoles } from "./assignment-role-upgrade.js";
import { readAttention } from "./attention.js";
import {
  defaultRolePackHash,
  deploymentRolePolicyHash,
  upgradeDeployedRoles,
} from "./deployment-roles.js";
import { tryHostOpsLock } from "./host-ops-lock.js";
import {
  sessionIdleMinutes,
  sessionMaintenanceScan,
} from "./session-maintenance.js";

function setup(dbPath = ":memory:", version = 1, manual = false) {
  const store = Store.open({ dbPath }),
    state = fixture(),
    project = human.project_id;
  const a = {
    ...state.assignments[0]!,
    role_version: version,
    last_mcp_activity_at: "2030-01-01T00:00:00Z",
    runtime_ref: {
      machine_id: "local",
      runtime_machine: "fixture",
      terminal_ref: "t1",
      agent_name: "fixture",
      launch_generation: { run_id: state.runs[0]!.id, generation: "g1" },
    },
  };
  const source = defaultRoleDefinition("coder", {
    harness: "codex",
    launch_profile_ref: "fixture",
  });
  store.createProject({ id: project });
  store.uow.run((tx) => {
    tx.cards.put(project, state.cards[0]!);
    tx.work_items.put(project, state.work_items[0]!);
    tx.assignments.put(project, a);
    tx.runs.put(project, {
      ...state.runs[0]!,
      status: "completed",
      finished_at: "2030-01-01T00:00:00Z",
    });
    writeRole(tx, project, { ...source, version: 1 }, { mode: "add" });
    writeRole(
      tx,
      project,
      {
        ...source,
        version: 2,
        ...(manual ? { instructions: "Manual rule" } : {}),
      },
      { mode: "update" },
    );
  });
  const token = store.issueToken({
    project_id: project,
    assignment_id: a.id,
    role: { role_version: version, allowed_tools: ["get_card"] },
  });
  let at = "2030-01-01T02:00:00Z";
  const runtime = {
    release: vi.fn(),
    observe_retirement: vi
      .fn<NonNullable<Runtime["observe_retirement"]>>()
      .mockResolvedValue({ ok: true, value: "alive" }),
    status: vi.fn(async () => ({
      ok: true as const,
      value: {
        process: "alive" as "alive" | "exited",
        agent: "idle" as const,
        observed_seq: 1,
      },
    })),
  };
  return {
    store,
    a,
    project,
    token,
    runtime,
    source,
    setTime: (value: string) => {
      at = value;
    },
    tick: () =>
      upgradeIdleAssignmentRoles(
        store,
        project,
        runtime as unknown as Runtime,
        { now: () => at },
      ),
    state: () => store.uow.read((tx) => loadCommandState(tx, project)),
  };
}
test("latest-role live sessions get durable diagnostics without new runtime probes; repeated processes dedupe notifications", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cg-maintenance-")),
    dbPath = join(dir, "state.db");
  const f = setup(dbPath, 2);
  try {
    await f.tick();
    expect(f.state().assignments[0]?.session_maintenance).toMatchObject({
      reason: "unsupported_capability",
      candidate: true,
    });
    f.setTime("2030-01-01T02:16:00Z");
    await f.tick();
    await f.tick();
    expect(f.store.listNotifications({ project_id: f.project })).toHaveLength(
      1,
    );
    expect(f.runtime.status).not.toHaveBeenCalled();
    expect(f.runtime.release).not.toHaveBeenCalled();
    expect(f.store.verifyToken(f.token.token)).toBeTruthy();
    f.store.close();
    const reopened = Store.open({ dbPath });
    try {
      await upgradeIdleAssignmentRoles(
        reopened,
        f.project,
        f.runtime as unknown as Runtime,
        { now: () => "2030-01-01T02:17:00Z" },
      );
      expect(
        reopened.listNotifications({ project_id: f.project }),
      ).toHaveLength(1);
      const view = readAttention(reopened, f.project, "2030-01-01T02:17:00Z")
        .session_maintenance[0];
      expect(view).toMatchObject({
        assignment_id: f.a.id,
        evaluated_at: "2030-01-01T02:17:00Z",
      });
      expect(view).not.toHaveProperty("basis");
    } finally {
      reopened.close();
    }
  } finally {
    if (f.store.database.isOpen) f.store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("unknown publication defers a suspected conflict; no-op publication restores real conflict handling without clearing the action", async () => {
  const f = setup(":memory:", 1, true);
  f.runtime.status.mockResolvedValue({
    ok: true,
    value: { process: "exited", agent: "idle", observed_seq: 1 },
  });
  try {
    await f.tick();
    expect(f.state().human_actions).toHaveLength(0);
    expect(f.state().assignments[0]?.session_maintenance?.reason).toBe(
      "publication_pending",
    );
    upgradeDeployedRoles(
      f.store,
      f.project,
      [],
      {
        coder: deploymentRolePolicyHash(f.source),
      },
      new Set(["fixture"]),
    );
    upgradeDeployedRoles(
      f.store,
      f.project,
      [],
      {
        coder: deploymentRolePolicyHash(f.source),
      },
      new Set(["fixture"]),
    );
    expect(
      f.state().events.filter((e) => e.type === "host_role_pack_published"),
    ).toHaveLength(1);
    expect(
      f.state().events.filter((e) => e.type === "host_role_upgraded"),
    ).toHaveLength(0);
    await f.tick();
    await f.tick();
    expect(f.state().human_actions).toHaveLength(1);
    expect(f.state().human_actions[0]?.status).toBe("open");
    expect(f.store.verifyToken(f.token.token)).toBeTruthy();
    expect(f.runtime.release).not.toHaveBeenCalled();
  } finally {
    f.store.close();
  }
});
test("an old process or interrupted publication cannot decide conflicts, even when its own defaults match", async () => {
  const f = setup();
  f.runtime.status.mockResolvedValue({
    ok: true,
    value: { process: "exited", agent: "idle", observed_seq: 1 },
  });
  try {
    f.store.uow.run((tx) =>
      tx.events.append(f.project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(f.project),
        type: "host_role_pack_published",
        actor: { kind: "system", project_id: f.project },
        created_at: "2030-01-01T00:00:00Z",
        payload: { pack_hash: "other-process-pack" },
      }),
    );
    await f.tick();
    await f.tick();
    expect(f.state().assignments[0]?.role_version).toBe(1);
    expect(f.state().assignments[0]?.session_maintenance?.reason).toBe(
      "publication_pending",
    );
    expect(f.store.verifyToken(f.token.token)).toBeTruthy();
    upgradeDeployedRoles(
      f.store,
      f.project,
      [],
      {
        coder: deploymentRolePolicyHash(f.source),
      },
      new Set(["fixture"]),
    );
    expect(
      f
        .state()
        .events.filter((e) => e.type === "host_role_pack_published")
        .sort((a, b) => a.seq - b.seq)
        .at(-1)?.payload,
    ).toMatchObject({
      pack_hash: defaultRolePackHash(),
    });
    await f.tick();
    expect(f.state().assignments[0]?.role_version).toBe(2);
    expect(f.state().assignments[0]?.session_maintenance?.reason).toBe(
      "no_session",
    );
  } finally {
    f.store.close();
  }
});
test("a fresh role snapshot after an awaited observation cannot create a stale conflict", async () => {
  const f = setup(":memory:", 1, true);
  try {
    upgradeDeployedRoles(
      f.store,
      f.project,
      [],
      {
        coder: deploymentRolePolicyHash(f.source),
      },
      new Set(["fixture"]),
    );
    f.runtime.status.mockImplementation(async () => {
      f.store.uow.run((tx) => {
        if (
          !loadCommandState(tx, f.project).roles.some(
            (r) => r.role_version === 3,
          )
        )
          writeRole(
            tx,
            f.project,
            { ...f.source, version: 3 },
            { mode: "update" },
          );
      });
      return {
        ok: true,
        value: { process: "exited", agent: "idle", observed_seq: 1 },
      };
    });
    await f.tick();
    expect(f.state().human_actions).toHaveLength(0);
    expect(f.state().assignments[0]?.role_version).toBe(3);
  } finally {
    f.store.close();
  }
});
test("candidate threshold is configurable and invalid values fail closed", () => {
  expect(sessionIdleMinutes("90")).toBe(90);
  for (const value of ["", "0", "-1", "1.5", "NaN", "2147483648"])
    expect(() => sessionIdleMinutes(value)).toThrow("positive integer");
});

test("unsupported older sessions back off and cannot starve an untried eligible session", async () => {
  const f = setup(":memory:", 2);
  f.store.uow.run((tx) => {
    for (const number of [2, 3]) {
      const id = `A-${number}` as typeof f.a.id;
      const work = {
        ...fixture().work_items[0]!,
        id: `W-${number}` as never,
        assignment_id: id,
      };
      tx.work_items.put(f.project, work);
      tx.assignments.put(f.project, {
        ...f.a,
        id,
        scope: "work_item",
        work_item_id: work.id,
        runtime_ref: { ...f.a.runtime_ref, terminal_ref: `t${number}` },
      });
      tx.runs.put(f.project, {
        ...fixture().runs[0]!,
        id: `R-${number}` as never,
        assignment_id: id,
        status: "completed",
        finished_at: "2030-01-01T00:00:00Z",
      });
    }
  });
  const retire = vi.fn(async (ref) => ({
    ok: true as const,
    value:
      ref.terminal_ref === "t3"
        ? { outcome: "exited" }
        : {
            outcome: "withdrawn",
            evidence: {
              stage: "get",
              reason: "hc_failed",
              hc_kind: "blocked",
              runtime_code: "runtime_conflict",
            },
          },
  }));
  Object.assign(f.runtime, { retire_idle: retire });
  try {
    await f.tick();
    expect(retire.mock.calls.map(([ref]) => ref.terminal_ref)).toEqual([
      "t1",
      "t2",
    ]);
    expect(f.state().assignments[0]?.idle_retirement).toMatchObject({
      phase: "waiting",
      last_failure: "unavailable",
    });
    f.setTime("2030-01-01T02:01:00Z");
    await f.tick();
    expect(retire.mock.calls[2]?.[0].terminal_ref).toBe("t3");
    expect(
      f.state().assignments.find((a) => a.id === "A-3")?.runtime_ref,
    ).toBeNull();
    expect(f.store.verifyToken(f.token.token)).toBeTruthy();
  } finally {
    f.store.close();
  }
});

test("idle retirement preserves the Assignment and only revokes credentials after exit", async () => {
  const f = setup(":memory:", 2);
  const retire = vi.fn(async (_ref, options) => ({
    ok: true as const,
    value: { outcome: options.before_signal() ? "exited" : "withdrawn" },
  }));
  Object.assign(f.runtime, { retire_idle: retire });
  try {
    await f.tick();
    await f.tick();
    expect(retire).toHaveBeenCalledOnce();
    expect(f.store.verifyToken(f.token.token)).toBeUndefined();
    expect(f.state().assignments[0]).toMatchObject({
      id: f.a.id,
      role_version: 2,
      runtime_ref: null,
    });
    expect(
      f.state().events.filter((e) => e.type === "session_replaced"),
    ).toHaveLength(1);
    expect(f.runtime.release).not.toHaveBeenCalled();
  } finally {
    f.store.close();
  }
});
test.each(["host-ops", "launch"] as const)(
  "%s lock and the final new-work check protect the session",
  async (scope) => {
    const f = setup(":memory:", 2);
    const retire = vi.fn(async (_ref, options) => {
      f.store.uow.run((tx) =>
        tx.runs.put(f.project, { ...fixture().runs[0]!, status: "queued" }),
      );
      expect(options.before_signal()).toBe(false);
      return {
        ok: true as const,
        value: {
          outcome: "withdrawn",
          evidence: {
            stage: "get",
            reason: "hc_failed",
            hc_kind: "blocked",
            runtime_code: "runtime_conflict",
          },
        },
      };
    });
    Object.assign(f.runtime, { retire_idle: retire });
    try {
      const unlock = await tryHostOpsLock(f.store, f.project, f.a.id, scope);
      try {
        await f.tick();
        expect(retire).not.toHaveBeenCalled();
      } finally {
        await unlock?.();
      }
      await f.tick();
      expect(retire).toHaveBeenCalledOnce();
      expect(f.store.verifyToken(f.token.token)).toBeTruthy();
      expect(f.state().assignments[0]?.idle_retirement?.phase).toBe("waiting");
      expect(f.state().assignments[0]?.runtime_ref).toEqual(f.a.runtime_ref);
    } finally {
      f.store.close();
    }
  },
);
test("timeout retains the session and retries with durable backoff and one failure notice", async () => {
  const f = setup(":memory:", 2);
  const retire = vi.fn(async () => ({
    ok: true as const,
    value: {
      outcome: "timeout",
      evidence: {
        stage: "confirm",
        reason: "still_live",
        terminal_state: "live",
      },
    },
  }));
  Object.assign(f.runtime, { retire_idle: retire });
  try {
    await f.tick();
    await f.tick();
    expect(retire).toHaveBeenCalledTimes(1);
    f.setTime("2030-01-01T02:01:00Z");
    await f.tick();
    f.setTime("2030-01-01T02:03:00Z");
    await f.tick();
    f.setTime("2030-01-01T02:07:00Z");
    await f.tick();
    expect(retire).toHaveBeenCalledTimes(4);
    expect(f.store.listNotifications({ project_id: f.project })).toHaveLength(
      1,
    );
    expect(f.store.verifyToken(f.token.token)).toBeTruthy();
    expect(f.state().assignments[0]?.idle_retirement?.phase).toBe("waiting");
    const alert = f
      .state()
      .events.filter((e) => e.type === "session_maintenance_attention");
    expect(alert).toHaveLength(1);
    expect(alert[0]?.payload).toMatchObject({
      evidence: { terminal_state: "live" },
      notice: expect.stringContaining(
        `cardigan assignment stop ${f.a.id} --project ${f.project}`,
      ),
    });
    Object.assign(f.runtime, {
      retire_idle: async () => ({ ok: true, value: { outcome: "exited" } }),
    });
    f.setTime("2030-01-01T02:12:00Z");
    await f.tick();
    expect(f.store.listNotifications({ project_id: f.project })).toMatchObject([
      { status: "resolved" },
    ]);
    expect(f.state().assignments[0]?.idle_retirement).toBeUndefined();
  } finally {
    f.store.close();
  }
});
test("lost acknowledgements preserve the fence; restart only observes exit and never repeats a signal", async () => {
  const f = setup(":memory:", 2);
  const retire = vi.fn(async () => {
    throw new Error("lost response");
  });
  Object.assign(f.runtime, { retire_idle: retire });
  try {
    await f.tick();
    expect(f.state().assignments[0]?.idle_retirement?.phase).toBe("stopping");
    f.runtime.status.mockResolvedValue({
      ok: true,
      value: { process: "exited", agent: "idle", observed_seq: 1 },
    });
    f.runtime.observe_retirement.mockResolvedValue({
      ok: false,
      error: { code: "runtime_not_found", message: "snapshot missing" },
    });
    f.setTime("2030-01-01T02:01:00Z");
    await f.tick();
    expect(retire).toHaveBeenCalledOnce();
    expect(f.store.verifyToken(f.token.token)).toBeTruthy();
    f.runtime.observe_retirement.mockResolvedValue({
      ok: true,
      value: "exited",
    });
    f.setTime("2030-01-01T02:03:00Z");
    await f.tick();
    expect(f.state().assignments[0]?.runtime_ref).toBeNull();
    expect(f.store.verifyToken(f.token.token)).toBeUndefined();
    expect(retire).toHaveBeenCalledOnce();
  } finally {
    f.store.close();
  }
});

test.each(["alive", "runtime_conflict"] as const)(
  "no pidfd: %s recheck retains credentials and gives ownership-safe guidance until exit",
  async (observation) => {
    const f = setup(":memory:", 2);
    const evidence = {
      stage: "probe",
      reason: "pidfd_unavailable",
      terminal_state: "live",
      exit_code: 20,
    };
    const retire = vi.fn(async () => ({
      ok: true,
      value: { outcome: "withdrawn", evidence },
    }));
    Object.assign(f.runtime, { retire_idle: retire });
    if (observation === "runtime_conflict")
      f.runtime.observe_retirement.mockResolvedValue({
        ok: false,
        error: { code: "runtime_conflict", message: "owner changed" },
      });
    try {
      for (const minute of [0, 1, 3, 7]) {
        f.setTime(`2030-01-01T02:0${minute}:00Z`);
        await f.tick();
      }
      expect(retire).toHaveBeenCalledOnce();
      expect(f.runtime.observe_retirement).toHaveBeenCalledTimes(3);
      expect(f.runtime.status).not.toHaveBeenCalled();
      expect(f.state().assignments[0]?.idle_retirement).toMatchObject({
        phase: "waiting",
        evidence,
      });
      expect(f.store.verifyToken(f.token.token)).toBeTruthy();
      expect(
        f
          .state()
          .events.filter((e) => e.type === "session_maintenance_attention"),
      ).toMatchObject([
        {
          payload: { evidence, notice: expect.stringContaining("只复查退出") },
        },
      ]);
      const notice = f
        .state()
        .events.find((e) => e.type === "session_maintenance_attention")
        ?.payload.notice;
      expect(notice).toContain("只读核对终端地址、项目、指派和启动代次");
      if (observation === "runtime_conflict") {
        expect(notice).toContain("runtime_conflict");
        expect(notice).not.toContain("cardigan assignment stop");
      }
      expect(
        f.store.listNotifications({ project_id: f.project }),
      ).toMatchObject([{ status: "pending" }]);
      f.runtime.observe_retirement.mockResolvedValue({
        ok: true,
        value: "exited",
      });
      f.setTime("2030-01-01T02:12:00Z");
      await f.tick();
      expect(
        f.store.listNotifications({ project_id: f.project }),
      ).toMatchObject([{ status: "resolved" }]);
      expect(f.store.verifyToken(f.token.token)).toBeUndefined();
      expect(retire).toHaveBeenCalledOnce();
    } finally {
      f.store.close();
    }
  },
);

test("a published role waits for retirement of the same ref; neither missing status nor another session can revoke its token", async () => {
  const f = setup(":memory:", 1);
  const retire = vi.fn(async () => ({
    ok: true,
    value: {
      outcome: "withdrawn",
      evidence: { stage: "probe", reason: "pidfd_unavailable" },
    },
  }));
  Object.assign(f.runtime, {
    retire_idle: retire,
    status: vi.fn(async () => ({
      ok: false,
      error: { code: "runtime_not_found", message: "missing" },
    })),
  });
  try {
    upgradeDeployedRoles(
      f.store,
      f.project,
      [],
      { coder: deploymentRolePolicyHash(f.source) },
      new Set(["fixture"]),
    );
    f.runtime.observe_retirement.mockResolvedValue({
      ok: false,
      error: { code: "runtime_conflict", message: "wrong owner" },
    });
    await f.tick();
    f.setTime("2030-01-01T02:01:00Z");
    await f.tick();
    expect(f.runtime.status).not.toHaveBeenCalled();
    expect(f.state().assignments[0]).toMatchObject({
      role_version: 1,
      runtime_ref: f.a.runtime_ref,
      idle_retirement: { phase: "waiting" },
    });
    expect(
      f
        .state()
        .events.some((e) => e.type === "assignment_role_upgrade_started"),
    ).toBe(false);
    expect(f.store.verifyToken(f.token.token)).toBeTruthy();
    f.runtime.observe_retirement.mockResolvedValue({
      ok: true,
      value: "exited",
    });
    f.setTime("2030-01-01T02:03:00Z");
    await f.tick();
    expect(
      f
        .state()
        .events.filter((e) => e.type === "session_replaced")
        .map((e) => e.payload),
    ).toMatchObject([
      { reason: "idle_session_retired" },
      { reason: "default_role_upgraded" },
    ]);
    expect(f.state().assignments[0]).toMatchObject({
      role_version: 2,
      runtime_ref: null,
    });
    expect(f.store.verifyToken(f.token.token)).toBeUndefined();
    expect(retire).toHaveBeenCalledOnce();
  } finally {
    f.store.close();
  }
});

test("a retirement claim appearing while locks are acquired is recovered, never signalled twice", async () => {
  const f = setup(":memory:", 2);
  const retire = vi.fn();
  Object.assign(f.runtime, { retire_idle: retire });
  try {
    const tick = f.tick();
    f.store.uow.run((tx) =>
      tx.assignments.put(f.project, {
        ...f.a,
        idle_retirement: {
          phase: "stopping",
          runtime_ref: f.a.runtime_ref,
          started_at: "2030-01-01T02:00:00Z",
          threshold_minutes: 60,
          failures: 0,
          evidence: { stage: "HUP", reason: "pidfd_unavailable" },
          activity_at: f.a.last_mcp_activity_at,
        },
      }),
    );
    await tick;
    expect(retire).not.toHaveBeenCalled();
    expect(f.runtime.observe_retirement).toHaveBeenCalledOnce();
    expect(f.state().assignments[0]?.idle_retirement).toMatchObject({
      phase: "stopping",
      last_failure: "uncertain",
    });
    expect(f.store.verifyToken(f.token.token)).toBeTruthy();
  } finally {
    f.store.close();
  }
});

test("an interrupted earlier publication stays unverified even when the next package has no role changes", async () => {
  const f = setup(":memory:", 1, true);
  f.runtime.status.mockResolvedValue({
    ok: true,
    value: { process: "exited", agent: "idle", observed_seq: 1 },
  });
  try {
    const oldHash = deploymentRolePolicyHash(f.source);
    // The DB still contains the previous default, rather than a human edit.
    const previousDefault = { ...f.source, instructions: "Manual rule" };
    expect(oldHash).not.toBe(deploymentRolePolicyHash(previousDefault));
    upgradeDeployedRoles(
      f.store,
      f.project,
      [],
      {
        coder: deploymentRolePolicyHash(previousDefault),
      },
      new Set(["fixture"]),
    );
    await f.tick();
    expect(f.state().human_actions).toHaveLength(0);
    expect(f.state().assignments[0]?.session_maintenance?.reason).toBe(
      "publication_pending",
    );
    expect(f.store.verifyToken(f.token.token)).toBeTruthy();
    // A later successful publication fixes the DB and receipt atomically.
    upgradeDeployedRoles(
      f.store,
      f.project,
      ["coder"],
      {
        coder: deploymentRolePolicyHash(previousDefault),
      },
      new Set(["fixture"]),
    );
    await f.tick();
    expect(f.state().assignments[0]?.role_version).toBe(3);
  } finally {
    f.store.close();
  }
});

test("failure to persist the publication receipt rolls back role writes", () => {
  const f = setup(":memory:", 1, true);
  try {
    f.store.database.exec(`CREATE TRIGGER fail_pack BEFORE INSERT ON events
      WHEN NEW.type = 'host_role_pack_published' BEGIN SELECT RAISE(ABORT, 'publication interrupted'); END`);
    const before = f.state();
    expect(() =>
      upgradeDeployedRoles(
        f.store,
        f.project,
        ["coder"],
        {
          coder: deploymentRolePolicyHash({
            ...f.source,
            instructions: "Manual rule",
          }),
        },
        new Set(["fixture"]),
      ),
    ).toThrow("publication interrupted");
    expect(f.state().roles).toEqual(before.roles);
    expect(f.state().events).toEqual(before.events);
  } finally {
    f.store.close();
  }
});

test("a commit between maintenance slices invalidates the remaining owners' observations", async () => {
  const f = setup(":memory:", 2);
  const sibling = { ...f.a, id: "A-9999" as typeof f.a.id };
  try {
    f.store.uow.run((tx) => tx.assignments.put(f.project, sibling));
    const scan = sessionMaintenanceScan(
      f.store,
      f.project,
      { now: () => "2030-01-01T02:00:00Z" },
      60,
      false,
    );
    // Force the time slice to expire after one owner without sleeping or spinning.
    let t = 0;
    const timer = vi
      .spyOn(performance, "now")
      .mockImplementation(() => (t += 100));
    try {
      const between = new Promise<void>((resolve) =>
        setImmediate(() => {
          f.store.uow.run((tx) =>
            tx.assignments.put(f.project, { ...sibling, status: "released" }),
          );
          resolve();
        }),
      );
      await scan.finish();
      await between;
      expect(
        f.state().assignments.find((a) => a.id === f.a.id)?.session_maintenance,
      ).toBeDefined();
      expect(
        f.state().assignments.find((a) => a.id === sibling.id),
      ).toMatchObject({ status: "released" });
      expect(
        f
          .state()
          .events.some(
            (e) =>
              e.type === "session_maintenance_changed" &&
              (e.payload as { assignment_id?: string }).assignment_id ===
                sibling.id,
          ),
      ).toBe(false);
    } finally {
      timer.mockRestore();
    }
  } finally {
    f.store.close();
  }
});

test("kept shells are observed without operator requests or repeated signals", async () => {
  const f = setup(":memory:", 2);
  const retire = vi.fn(async () => ({
    ok: true,
    value: {
      outcome: "withdrawn",
      evidence: {
        stage: "get",
        reason: "kept_terminal",
        terminal_state: "live",
      },
    },
  }));
  Object.assign(f.runtime, { retire_idle: retire });
  try {
    for (const minute of [0, 1, 3, 7]) {
      f.setTime(`2030-01-01T02:0${minute}:00Z`);
      await f.tick();
    }
    expect(
      f
        .state()
        .events.filter((e) => e.type === "idle_session_retirement_started"),
    ).toHaveLength(1);
    expect(retire).toHaveBeenCalledOnce();
    expect(f.runtime.observe_retirement).toHaveBeenCalledTimes(3);
    expect(f.store.listNotifications({ project_id: f.project })).toHaveLength(
      0,
    );
    expect(
      f
        .state()
        .events.filter((e) => e.type === "session_maintenance_attention"),
    ).toHaveLength(0);
    expect(f.store.verifyToken(f.token.token)).toBeTruthy();
    f.runtime.observe_retirement.mockResolvedValue({
      ok: true,
      value: "exited",
    });
    f.setTime("2030-01-01T02:12:00Z");
    await f.tick();
    expect(f.state().assignments[0]?.runtime_ref).toBeNull();
  } finally {
    f.store.close();
  }
});
