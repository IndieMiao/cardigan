import {
  acknowledgeRun,
  dispatchRun,
  type RuntimeRef,
  stopWorkItemAssignment,
} from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { Dispatcher } from "./dispatch.js";

let f: ReturnType<typeof recoveryFixture>;
let ref: RuntimeRef;
beforeEach(() => {
  f = recoveryFixture();
  ref = {
    ...f.refFor(f.target.assignment),
    target: {
      project_id: f.project,
      machine_id: "local",
      session: "fixture",
      generation: "fixture",
      fingerprint: "a".repeat(64),
    },
    launch_generation: { run_id: f.latest().id, generation: "fixture" },
  };
  f.store.uow.run((tx) => {
    tx.cards.put(f.project, { ...f.target.card, flow_version: 6 });
    const a = tx.assignments.get(f.project, f.target.assignment.id);
    if (!a) throw new Error("missing owner");
    tx.assignments.put(f.project, { ...a, runtime_ref: ref });
  });
  if (!f.options.startRun) throw new Error("Missing startRun fixture");
  vi.mocked(f.options.startRun).mockImplementation(async ({ run }) => {
    f.apply((s, a, p) =>
      dispatchRun(s, a, { run_id: run.id, runtime_ref: ref }, p),
    );
  });
});
afterEach(() => f.close());
async function running() {
  f.comment();
  const d = new Dispatcher(f.options);
  await d.tick();
  const run = f.latest();
  f.apply(
    (s, a, p) => acknowledgeRun(s, a, { run_id: run.id }, p),
    f.actorFor(f.target.assignment),
  );
  return { d, run };
}
const gone = () =>
  vi.mocked(f.runtime.status).mockResolvedValue({
    ok: false,
    error: {
      code: "runtime_not_found",
      message: "fixture missing exact terminal",
    },
  });
const recovered = () =>
  f.state().events.filter((e) => e.type === "run_dispatch_recovered");

test("started exit is observed twice, settles through the queue and never calls release", async () => {
  const { d, run } = await running();
  gone();
  await d.tick();
  expect(recovered()).toHaveLength(1);
  expect(f.state().runs.find((r) => r.id === run.id)).toMatchObject({
    status: "cancelled",
    outcome: "failed",
  });
  expect(f.latest().status).toBe("dispatched");
  expect(f.latest().recovery_policy?.root_run_id).toBe(run.id);
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(
    f
      .state()
      .events.filter(
        (e) =>
          e.type === "run_started" &&
          (e.payload as { run_id?: string }).run_id === f.latest().id,
      ),
  ).toHaveLength(0);
  // A restarted controller may settle a second exit, but cannot queue a second successor.
  const other = Store.open({ dataDir: f.dataDir, clock: f.clock });
  try {
    await new Dispatcher({ ...f.options, store: other }).tick();
  } finally {
    other.close();
  }
  expect(recovered()).toHaveLength(1);
  expect(f.state().events.some((e) => e.type === "run_dispatch_stalled")).toBe(
    true,
  );
});

test.each(["unknown", "alive", "timeout"])(
  "%s status does not release, revoke or recover a started Run",
  async (state) => {
    const { d, run } = await running();
    vi.mocked(f.runtime.status).mockResolvedValue(
      state === "timeout"
        ? {
            ok: false,
            error: { code: "runtime_timeout", message: "untrusted error" },
          }
        : {
            ok: true,
            value: {
              process: state as "alive" | "unknown",
              agent: "idle",
              observed_seq: 1,
            },
          },
    );
    await d.tick();
    expect(recovered()).toHaveLength(0);
    expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe("running");
    expect(f.runtime.release).not.toHaveBeenCalled();
  },
);

test.each(["stop", "target", "pause", "finish"])(
  "late %s while querying exit cannot recover the old execution",
  async (change) => {
    const { d, run } = await running();
    vi.mocked(f.runtime.status).mockImplementationOnce(async () => {
      if (change === "stop")
        f.apply((s, _a, p) =>
          stopWorkItemAssignment(
            s,
            { kind: "human", project_id: f.project },
            { assignment_id: run.assignment_id, reason: "human stop" },
            p,
          ),
        );
      else
        f.store.uow.run((tx) => {
          const a = tx.assignments.get(f.project, run.assignment_id);
          const saved = tx.runs.get(f.project, run.id);
          if (!a || !saved) throw new Error("Missing fixture target");
          if (change === "target")
            tx.assignments.put(f.project, {
              ...a,
              runtime_ref: { ...ref, terminal_ref: "new-terminal" },
            });
          if (change === "pause")
            tx.assignments.put(f.project, { ...a, status: "suspended" });
          if (change === "finish")
            tx.runs.put(f.project, {
              ...saved,
              status: "completed",
              outcome: "completed",
            });
        });
      return {
        ok: false,
        error: { code: "runtime_not_found", message: "gone" },
      };
    });
    await d.tick();
    expect(recovered()).toHaveLength(0);
    expect(f.runtime.release).not.toHaveBeenCalled();
  },
);

test("two dispatchers racing on one persisted exit create only one successor", async () => {
  await running();
  gone();
  const other = Store.open({ dataDir: f.dataDir, clock: f.clock });
  try {
    await Promise.all([
      new Dispatcher(f.options).tick(),
      new Dispatcher({ ...f.options, store: other }).tick(),
    ]);
  } finally {
    other.close();
  }
  expect(recovered()).toHaveLength(1);
});

test("credential settlement failure rolls back cancellation, successor, both budgets and audit", async () => {
  const { d, run } = await running();
  const token = f.store.issueToken({
    project_id: f.project,
    assignment_id: run.assignment_id,
    role: { role_version: 1, allowed_tools: ["whoami"] },
  });
  gone();
  f.store.database.exec(
    "CREATE TEMP TRIGGER fail_c3_revoke BEFORE UPDATE ON tokens BEGIN SELECT RAISE(ABORT, 'fixture revoke failure'); END;",
  );
  await expect(d.tick()).rejects.toThrow("fixture revoke failure");
  expect(recovered()).toHaveLength(0);
  expect(f.state().runs.find((r) => r.id === run.id)).toMatchObject({
    status: "running",
    dispatch_stop: { stopping: true },
  });
  expect(
    f.store.database
      .prepare("SELECT revoked_at FROM tokens WHERE id = ?")
      .get(token.record.id)?.revoked_at,
  ).toBeNull();
  f.store.database.exec("DROP TRIGGER fail_c3_revoke");
  f.advance(60000);
  await d.tick();
  expect(recovered()).toHaveLength(1);
  expect(
    f.store.database
      .prepare("SELECT revoked_at FROM tokens WHERE id = ?")
      .get(token.record.id)?.revoked_at,
  ).not.toBeNull();
});

test("an uncertain started fence retains its credentials and slot across lease expiry", async () => {
  const { d, run } = await running();
  gone();
  f.store.database.exec(
    "CREATE TEMP TRIGGER fail_c3_settle BEFORE INSERT ON events WHEN NEW.type = 'run_dispatch_stop_finished' BEGIN SELECT RAISE(ABORT, 'fixture settle failure'); END;",
  );
  await expect(d.tick()).rejects.toThrow("fixture settle failure");
  f.store.database.exec("DROP TRIGGER fail_c3_settle");
  vi.mocked(f.runtime.status).mockResolvedValue({
    ok: true,
    value: { process: "unknown", agent: "unknown", observed_seq: 2 },
  });
  f.advance(60000);
  await d.tick();
  expect(recovered()).toHaveLength(0);
  expect(
    f.state().runs.find((r) => r.id === run.id)?.dispatch_stop?.stopping,
  ).toBe(true);
  expect(f.runtime.release).not.toHaveBeenCalled();
});

test("a queued successor whose business becomes blocked is retired and escalated without a new root", async () => {
  await running();
  // A real capacity wait leaves the successor queued without attempting a launch.
  const occupying = f.create();
  f.session(occupying.assignment, false);
  f.skipEvents();
  const d = new Dispatcher({ ...f.options, runLimit: () => 1 });
  gone();
  await d.tick();
  const successor = f.latest();
  expect(successor.status).toBe("queued");
  f.store.uow.run((tx) => {
    const item = tx.work_items.get(f.project, f.target.item.id);
    if (!item) throw new Error("Missing item");
    tx.work_items.put(f.project, { ...item, status: "blocked" });
  });
  await d.tick();
  expect(f.state().runs.find((r) => r.id === successor.id)?.status).toBe(
    "cancelled",
  );
  expect(recovered()).toHaveLength(1);
  expect(
    f.store
      .listNotifications({ project_id: f.project })
      .some(
        (n) =>
          n.recipient.kind === "needs_you" &&
          f
            .state()
            .events.some(
              (e) => e.id === n.event_id && e.type === "run_recovery_abandoned",
            ),
      ),
  ).toBe(true);
});
