import {
  acknowledgeRun,
  dispatchRun,
  heldStandingRun,
  postComment,
  queueRun,
  type Run,
  updateCard,
} from "@cardigan/domain";
import { afterEach, expect, test, vi } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { Dispatcher } from "./dispatch.js";
import { routeProjectEvents } from "./dispatch-inbox.js";
import { recoverPmSession } from "./pm-recovery.js";

const fixtures: ReturnType<typeof recoveryFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

// Q-792 / attachment-4384: public commands set up two cards sharing one PM.
function setup(withHeld = true, executing = true) {
  const f = recoveryFixture();
  fixtures.push(f);
  const pm = { ...f.pm(), standing_mode: "ops" as const };
  f.store.uow.run((tx) => tx.assignments.put(f.project, pm));
  f.session(pm);
  const system = { kind: "system" as const, project_id: f.project };
  const queue = (card_id: typeof f.target.card.id) => {
    f.apply((s, a, p) =>
      postComment(
        s,
        a,
        { card_id, body: "Synthetic source task", mentions: [pm.id] },
        p,
      ),
    );
    const trigger = f
      .state()
      .events.findLast((e) => e.type === "comment_posted");
    if (!trigger) throw new Error("Missing trigger");
    return f.apply(
      (s, a, p) =>
        queueRun(
          s,
          a,
          {
            assignment_id: pm.id,
            trigger_event_id: trigger.id,
            model: "fixture",
            agent_cli_version: "fixture",
          },
          p,
        ),
      system,
    );
  };
  const waiting = withHeld ? queue(f.target.card.id) : undefined;
  const hold = (value: boolean) =>
    f.apply((s, a, p) =>
      updateCard(
        s,
        a,
        {
          card_id: f.target.card.id,
          hold: value
            ? {
                reason: "Wait for evidence",
                resume_condition: "Evidence available",
              }
            : null,
        },
        p,
      ),
    );
  hold(true);
  const active = executing ? queue(f.create().card.id) : undefined;
  if (active) {
    f.apply(
      (s, a, p) =>
        dispatchRun(s, a, { run_id: active.id, runtime_ref: f.refFor(pm) }, p),
      system,
    );
    f.apply(
      (s, a, p) => acknowledgeRun(s, a, { run_id: active.id }, p),
      f.actorFor(pm),
    );
    // Only the lost observation is synthetic; recovery must independently check exit.
    f.store.uow.run((tx) => {
      const owner = tx.assignments.get(f.project, pm.id);
      const run = tx.runs.get(f.project, active.id);
      if (!owner || !run) throw new Error("Missing active PM");
      tx.assignments.put(f.project, { ...owner, runtime_state: "unknown" });
      tx.runs.put(f.project, { ...run, status: "unknown" });
    });
  }
  const before = f.state();
  const owner = before.assignments.find((a) => a.id === pm.id);
  if (!owner) throw new Error("Missing owner");
  if (waiting) expect(heldStandingRun(owner, waiting, before)).toBe(true);
  vi.mocked(f.runtime.status).mockResolvedValue({
    ok: true,
    value: { process: "exited", agent: "done", observed_seq: 2 },
  });
  return {
    ...f,
    pm,
    waiting,
    active,
    hold,
    recover: () => recoverPmSession(f.store, f.project, f.runtime, f.clock),
    recovered: () =>
      f.state().events.filter((e) => e.type === "standing_pm_recovered"),
    changeWaiting: (patch: Partial<Run>) => {
      if (!waiting) throw new Error("Missing waiting run");
      f.store.uow.run((tx) => tx.runs.put(f.project, { ...waiting, ...patch }));
    },
  };
}

test.each([false, true])(
  "PM exit recovery preserves held queue without blocking other work (withHeld=%s)",
  async (withHeld) => {
    const f = setup(withHeld);
    await f.recover();
    await f.recover();
    expect(f.runtime.status).toHaveBeenCalledTimes(1);
    expect(f.runtime.status).toHaveBeenCalledWith(f.refFor(f.pm));
    expect(f.recovered()).toHaveLength(1);
    expect(f.state().runs.find((r) => r.id === f.active?.id)?.status).toBe(
      "cancelled",
    );
    if (f.waiting)
      expect(f.state().runs.find((r) => r.id === f.waiting?.id)).toEqual(
        f.waiting,
      );
    routeProjectEvents(f.store, f.project, { clock: f.clock });
    routeProjectEvents(f.store, f.project, { clock: f.clock });
    expect(
      f.store
        .listNotifications({ project_id: f.project })
        .filter((n) => n.event_id === f.recovered()[0]?.id),
    ).toMatchObject([
      { recipient: { kind: "assignment", assignment_id: f.pm.id } },
    ]);
    expect(f.runtime.release).not.toHaveBeenCalled();
  },
);

test.each([false, true])(
  "only a dormant queue does not fabricate PM recovery (held=%s)",
  async (held) => {
    const f = setup(true, false);
    if (!held) f.hold(false);
    const before = f.state();
    await f.recover();
    expect(f.runtime.status).not.toHaveBeenCalled();
    expect(f.recovered()).toHaveLength(0);
    expect(f.state()).toEqual(before);
  },
);

test.each(["alive", "unknown", "unavailable"] as const)(
  "held queues never turn %s into exit evidence",
  async (process) => {
    const f = setup();
    const before = f.state();
    vi.mocked(f.runtime.status).mockResolvedValue(
      process === "unavailable"
        ? {
            ok: false,
            error: { code: "runtime_unavailable", message: "offline" },
          }
        : { ok: true, value: { process, agent: "idle", observed_seq: 2 } },
    );
    await f.recover();
    expect(f.runtime.status).toHaveBeenCalledTimes(1);
    expect(f.recovered()).toHaveLength(0);
    expect(f.state()).toEqual(before);
  },
);

test.each([
  "started",
  "dispatched",
  "dispatch_stop",
  "inactivity_stop",
  "launching",
  "running",
  "paused",
] as const)(
  "%s retains the recovery fence beside a held queue",
  async (scenario) => {
    const f = setup();
    if (!f.waiting) throw new Error("Missing waiting run");
    if (scenario === "started") f.changeWaiting({ started_at: f.clock.now() });
    if (scenario === "dispatched") f.changeWaiting({ status: "dispatched" });
    if (scenario === "dispatch_stop")
      f.changeWaiting({
        dispatch_stop: {
          attempt_id: f.waiting.trigger_event_id,
          runtime_ref: f.refFor(f.pm),
          lease_until: f.clock.now(),
          stopping: true,
          reason: "server_restart",
        },
      });
    if (scenario === "launching")
      f.changeWaiting({
        launch_publication: {
          generation: "pending",
          phase: "preparing",
          target: {
            project_id: f.project,
            machine_id: "local",
            session: "fixture",
            generation: "one",
            fingerprint: "a".repeat(64),
          },
          token_id: "fixture",
          lease_until: f.clock.now(),
          agent_name: "fixture",
          work_dir: "/fixture",
          sha: null,
          runtime_ref: null,
          process: null,
          log_offset: 0,
          artifacts: [],
          wait: false,
          provision_attempted: false,
        },
      });
    if (scenario === "inactivity_stop")
      f.changeWaiting({
        inactivity_stop: {
          attempt_id: "stop",
          runtime_ref: f.refFor(f.pm),
          lease_until: f.clock.now(),
          stopping: true,
        },
      });
    if (scenario === "running" || scenario === "paused")
      f.store.uow.run((tx) => {
        const owner = tx.assignments.get(f.project, f.pm.id);
        if (!owner) throw new Error("Missing owner");
        tx.assignments.put(f.project, {
          ...owner,
          ...(scenario === "running"
            ? { runtime_state: "running" }
            : { status: "suspended" }),
        });
      });
    const before = f.state();
    await f.recover();
    expect(f.runtime.status).not.toHaveBeenCalled();
    expect(f.recovered()).toHaveLength(0);
    expect(f.state()).toEqual(before);
  },
);

test.each([
  "held",
  "released_before",
  "released_during",
  "released_after",
] as const)(
  "fresh PM recovery safely settles old execution and dispatches the original queue: %s",
  async (mode) => {
    const f = setup();
    if (!f.waiting || !f.active) throw new Error("Missing runs");
    if (mode === "released_before") f.hold(false);
    if (mode === "released_during")
      vi.mocked(f.runtime.status).mockImplementationOnce(async () => {
        f.hold(false);
        return {
          ok: true,
          value: { process: "exited", agent: "done", observed_seq: 2 },
        };
      });
    await f.recover();
    if (mode === "released_during") {
      expect(f.recovered()).toHaveLength(0);
      expect(f.state().runs.find((r) => r.id === f.active?.id)?.status).toBe(
        "unknown",
      );
      expect(f.state().runs.find((r) => r.id === f.waiting?.id)).toEqual(
        f.waiting,
      );
    }
    if (mode === "released_after") f.hold(false);
    await f.recover();
    expect(f.runtime.status).toHaveBeenCalledTimes(
      mode === "released_during" ? 2 : 1,
    );
    expect(f.runtime.status).toHaveBeenCalledWith(f.refFor(f.pm));
    expect(f.recovered()).toHaveLength(1);
    expect(f.state().runs.find((r) => r.id === f.active?.id)?.status).toBe(
      "cancelled",
    );
    expect(f.state().runs.find((r) => r.id === f.waiting?.id)).toEqual(
      f.waiting,
    );
    const dispatcher = new Dispatcher({
      ...f.options,
      pmRecoveryIntervalMs: 1,
    });
    await dispatcher.tick();
    f.advance(1000);
    await dispatcher.tick();
    const starts = vi
      .mocked(f.options.startRun)
      .mock.calls.filter(([job]) => job.assignment.id === f.pm.id);
    expect(starts).toHaveLength(1);
    expect(f.recovered()).toHaveLength(1);
    expect(
      f.state().cards.find((c) => c.id === f.target.card.id)?.hold !==
        undefined,
    ).toBe(mode === "held");
    expect(f.state().runs.find((r) => r.id === f.waiting?.id)).toMatchObject({
      ...f.waiting,
      status: mode === "held" ? "queued" : "dispatched",
    });
    if (mode !== "held") expect(starts[0]?.[0].run.id).toBe(f.waiting.id);
  },
);

test.each(["session", "started", "stopping"] as const)(
  "a concurrent %s change prevents stale recovery beside dormant work",
  async (change) => {
    const f = setup();
    if (!f.waiting) throw new Error("Missing waiting run");
    const waiting = f.waiting;
    let changed = f.state();
    vi.mocked(f.runtime.status).mockImplementationOnce(async () => {
      if (change === "session")
        f.store.uow.run((tx) => {
          const owner = tx.assignments.get(f.project, f.pm.id);
          if (!owner) throw new Error("Missing owner");
          tx.assignments.put(f.project, {
            ...owner,
            runtime_ref: { ...f.refFor(f.pm), terminal_ref: "replacement" },
          });
        });
      else if (change === "started")
        f.changeWaiting({ started_at: f.clock.now() });
      else
        f.changeWaiting({
          dispatch_stop: {
            attempt_id: waiting.trigger_event_id,
            runtime_ref: f.refFor(f.pm),
            lease_until: f.clock.now(),
            stopping: true,
            reason: "server_restart",
          },
        });
      changed = f.state();
      return {
        ok: true,
        value: { process: "exited", agent: "done", observed_seq: 2 },
      };
    });
    await f.recover();
    expect(f.runtime.status).toHaveBeenCalledWith(f.refFor(f.pm));
    expect(f.recovered()).toHaveLength(0);
    expect(f.state()).toEqual(changed);
  },
);
