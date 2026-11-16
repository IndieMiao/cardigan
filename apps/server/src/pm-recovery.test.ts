import type {
  Assignment,
  Runtime,
  RuntimeObservation,
  RuntimeResult,
} from "@cardigan/domain";
import { notices } from "@cardigan/domain";
import { tryHostOpsLock } from "@cardigan/host";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { m3Fixture } from "../test-support/m3-acceptance.js";
import { Dispatcher } from "./dispatch.js";
import { InactiveRunReaper } from "./dispatch-inactive.js";
import { routeProjectEvents } from "./dispatch-inbox.js";
import { recoverPmSession } from "./pm-recovery.js";
import { runSystemRules } from "./system-rules.js";

let f: ReturnType<typeof m3Fixture>;
let ops: Assignment;
let runtime: Runtime;
beforeEach(() => {
  f = m3Fixture();
  ops = f.store.uow.run((tx) => {
    const a: Assignment = {
      ...f.pm,
      id: tx.ids.next(f.id, "assignment"),
      scope: "standing",
      standing_mode: "ops",
      runtime_state: "idle",
      runtime_ref: {
        machine_id: "local",
        runtime_machine: "local",
        terminal_ref: "old-pm",
        agent_name: "pm",
      },
    };
    tx.assignments.put(f.id, a);
    return a;
  });
  runtime = {
    status: vi.fn(async () => ({
      ok: true,
      value: { process: "exited", agent: "done", observed_seq: 1 },
    })),
    release: vi.fn(),
    wake: vi.fn(),
    provision: vi.fn(),
    interrupt: vi.fn(),
    resume_or_replace: vi.fn(),
    human_entry: vi.fn(),
  };
});
afterEach(() => f.close());
const recover = () => recoverPmSession(f.store, f.id, runtime, f.clock);

test("confirmed exit preserves PM identity, revokes old credentials, and routes exactly one recovery", async () => {
  runSystemRules(f.store, f.id, f.clock);
  const token = f.store.issueToken({
    project_id: f.id,
    assignment_id: ops.id,
    role: { role_version: ops.role_version, allowed_tools: ["get_updates"] },
  });
  await recover();
  await recover();
  routeProjectEvents(f.store, f.id, { clock: f.clock });
  routeProjectEvents(f.store, f.id, { clock: f.clock });
  expect(f.state().assignments.find((a) => a.id === ops.id)).toMatchObject({
    status: "active",
    runtime_ref: null,
  });
  expect(
    f.state().events.filter((e) => e.type === "standing_pm_recovered"),
  ).toHaveLength(1);
  expect(
    f.store.uow.run(
      (tx) =>
        tx
          .tokensForAssignment(f.id, ops.id)
          .find((t) => t.id === token.record.id)?.revoked_at,
    ),
  ).not.toBeNull();
  const source = f
    .state()
    .events.find((e) => e.type === "standing_pm_recovered");
  expect(
    f.store
      .listNotifications({ project_id: f.id })
      .filter((n) => n.event_id === source?.id),
  ).toMatchObject([
    { recipient: { kind: "assignment", assignment_id: ops.id } },
  ]);
  expect(
    notices(f.state()).some((n) => n.option === "常驻 PM 已安排自动恢复"),
  ).toBe(true);
  expect(runtime.release).not.toHaveBeenCalled();
  f.start(ops);
  runSystemRules(f.store, f.id, f.clock);
  runSystemRules(f.store, f.id, f.clock);
  expect(notices(f.state()).map((n) => n.option)).toEqual([
    "常驻 PM 已恢复执行",
  ]);
  expect(
    f.state().events.filter((e) => e.type === "standing_pm_recovery_started"),
  ).toHaveLength(1);
});

test.each([
  "alive",
  "unknown",
  "unavailable",
  "paused",
  "external",
  "lock",
  "shutdown",
])("%s does not infer exit or restart a PM", async (scenario) => {
  if (scenario === "alive" || scenario === "unknown")
    vi.mocked(runtime.status).mockResolvedValue({
      ok: true,
      value: { process: scenario, agent: "idle", observed_seq: 2 },
    });
  if (scenario === "unavailable")
    vi.mocked(runtime.status).mockResolvedValue({
      ok: false,
      error: { code: "runtime_unavailable", message: "offline" },
    });
  if (scenario === "paused")
    f.store.uow.run((tx) =>
      tx.assignments.put(f.id, { ...ops, status: "suspended" }),
    );
  if (scenario === "external")
    f.store.uow.run((tx) => {
      tx.assignments.put(f.id, { ...ops, status: "released" });
      tx.assignments.put(f.id, {
        ...ops,
        id: tx.ids.next(f.id, "assignment"),
        standing_mode: "office",
        external: true,
      });
    });
  const unlock =
    scenario === "lock"
      ? await tryHostOpsLock(f.store, f.id, ops.id, "launch")
      : undefined;
  try {
    await recoverPmSession(
      f.store,
      f.id,
      runtime,
      f.clock,
      () => scenario !== "shutdown",
    );
  } finally {
    await unlock?.();
  }
  expect(f.state().events.some((e) => e.type === "standing_pm_recovered")).toBe(
    false,
  );
  expect(runtime.release).not.toHaveBeenCalled();
});

test("late exit observation cannot cancel a newer PM session", async () => {
  let complete:
    | ((value: RuntimeResult<RuntimeObservation>) => void)
    | undefined;
  const observation = new Promise<RuntimeResult<RuntimeObservation>>(
    (resolve) => {
      complete = resolve;
    },
  );
  vi.mocked(runtime.status).mockImplementation(async () => {
    f.store.uow.run((tx) =>
      tx.assignments.put(f.id, {
        ...ops,
        session_ref: "replacement",
        runtime_ref: {
          machine_id: "local",
          runtime_machine: "local",
          terminal_ref: "new-pm",
          agent_name: "pm",
        },
      }),
    );
    complete?.({
      ok: true,
      value: { process: "exited", agent: "done", observed_seq: 2 },
    });
    return observation;
  });
  await recover();
  expect(f.state().events.some((e) => e.type === "standing_pm_recovered")).toBe(
    false,
  );
  expect(
    f.state().assignments.find((a) => a.id === ops.id)?.runtime_ref
      ?.terminal_ref,
  ).toBe("new-pm");
});

test.each([true, false])(
  "inactive PM restarts only after the existing stop workflow proves exit (%s)",
  async (confirmed) => {
    f.start(ops);
    f.advance(2000);
    let stopped = false;
    vi.mocked(runtime.status).mockImplementation(async () => ({
      ok: true,
      value: {
        process: stopped ? (confirmed ? "exited" : "unknown") : "alive",
        agent: "idle",
        observed_seq: 2,
      },
    }));
    vi.mocked(runtime.release).mockImplementation(async () => {
      stopped = true;
      return { ok: true, value: undefined };
    });
    await new InactiveRunReaper({
      store: f.store,
      runtime,
      clock: f.clock,
      afterMs: 1000,
      alert: vi.fn(),
    }).tick([f.id]);
    await recover();
    expect(
      f.state().events.filter((e) => e.type === "standing_pm_recovered"),
    ).toHaveLength(confirmed ? 1 : 0);
    if (!confirmed)
      expect(
        f
          .state()
          .runs.some((r) => r.assignment_id === ops.id && r.inactivity_stop),
      ).toBe(true);
  },
);

test("an explicit standing resolver exclusion prevents automatic PM startup", async () => {
  f.store.uow.run((tx) =>
    tx.assignments.put(f.id, {
      ...ops,
      runtime_ref: null,
      runtime_state: "not_provisioned",
    }),
  );
  const startRun = vi.fn();
  await new Dispatcher({
    store: f.store,
    runtime,
    clock: f.clock,
    standing: () => undefined,
    snapshot: async () => ({ model: "fixture", agent_cli_version: "1" }),
    startRun,
  }).tick();
  expect(startRun).not.toHaveBeenCalled();
  expect(runtime.status).not.toHaveBeenCalled();
  expect(f.state().events.some((e) => e.type === "standing_pm_recovered")).toBe(
    false,
  );
});

test("a standing recovery exclusion during observation is rechecked before settlement", async () => {
  let allowed = true;
  vi.mocked(runtime.status).mockImplementation(async () => {
    allowed = false;
    return {
      ok: true,
      value: { process: "exited", agent: "done", observed_seq: 3 },
    };
  });
  await recoverPmSession(f.store, f.id, runtime, f.clock, () => allowed);
  expect(
    f.state().assignments.find((a) => a.id === ops.id)?.runtime_ref,
  ).toEqual(ops.runtime_ref);
  expect(f.state().events.some((e) => e.type === "standing_pm_recovered")).toBe(
    false,
  );
});
