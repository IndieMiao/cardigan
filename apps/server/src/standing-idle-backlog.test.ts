// C-680: an idle standing session (process alive, its last turn finished) with
// a pending notification must get a Run without waiting for the stall patrol.
// In the incident a project-stream notification was typed into the host-ops
// session while its turn was still running (a continuation bell). The turn then
// finished without acking the project stream, and the bell stayed `belled`
// forever: project-stream bells had no retry time, the maintenance retry
// skipped them and the dispatcher only delivers `pending` rows. Ten minutes
// later the patrol's restart was withdrawn as "upstream not recovered".
import {
  type Assignment,
  acknowledgeRun,
  dispatchRun,
  eventsOfType,
  finishRun,
  type Harness,
} from "@cardigan/domain";
import { HostOpsService, UpstreamHealthMonitor } from "@cardigan/host";
import { parseLaunchConfig } from "@cardigan/roles";
import { PROJECT_EVENT_STREAM } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { setup } from "../test-support/dispatch-stalls.js";
import { Dispatcher } from "./dispatch.js";

const SECOND = 1000;

function idleHostOps(harness: Harness) {
  const f = setup();
  vi.spyOn(console, "info").mockImplementation(() => {});
  const a = f.ops;
  const run = f.session(a, false);
  f.store.uow.run((tx) => {
    const r = tx.runs.get(f.project, run.id);
    if (!r) throw new Error("missing Run");
    tx.runs.put(f.project, { ...r, harness });
  });
  f.skipEvents();
  const runs = () => f.state().runs.filter((r) => r.assignment_id === a.id);
  const finish = (id = run.id) =>
    f.apply(
      (s, actor, p) =>
        finishRun(
          s,
          actor,
          { run_id: id, outcome: "completed", summary: "fixture" },
          p,
        ),
      f.actorFor(a),
    );
  return { f, a, run, runs, finish, dispatcher: new Dispatcher(f.options) };
}

test.each([
  ["pi", "project"],
  ["pi", "card"],
  ["claude-code", "project"],
  ["claude-code", "card"],
] as const)(
  "C-680: %s, %s stream: a bell left unread by the ended turn queues a Run for the idle session within a minute",
  async (harness, stream) => {
    const { f, a, run, runs, finish, dispatcher } = idleHostOps(harness);
    const card = stream === "card" ? f.target.card.id : undefined;
    const notice = f.event("fixture_notice", {}, a, card);
    await dispatcher.tick();
    // Typed into the running turn (continuation), not a new Run.
    expect(f.runtime.wake).toHaveBeenCalledOnce();
    expect(runs().map((r) => r.id)).toEqual([run.id]);
    f.advance(40 * SECOND);
    finish();
    const finishedAt = Date.parse(f.clock.now());
    let queuedAt: number | undefined;
    for (let i = 0; i < 6 && queuedAt === undefined; i++) {
      f.advance(10 * SECOND);
      await dispatcher.tick();
      if (runs().length > 1) queuedAt = Date.parse(f.clock.now());
    }
    expect(queuedAt).toBeDefined();
    expect((queuedAt ?? 0) - finishedAt).toBeLessThanOrEqual(60 * SECOND);
    const next = runs()[1];
    expect(next).toMatchObject({ trigger_event_id: notice.id });
    expect(
      eventsOfType(f.state().events, "run_queued").some(
        (e) => (e.payload as { run_id?: string }).run_id === next?.id,
      ),
    ).toBe(true);
    // The same live session is woken; nothing is stopped or replaced.
    expect(f.runtime.wake).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.runtime.wake).mock.lastCall?.[0]).toEqual(f.refFor(a));
    expect(f.runtime.release).not.toHaveBeenCalled();
    expect(f.runtime.resume_or_replace).not.toHaveBeenCalled();
    // No stall incident ever forms.
    f.advance(11 * 60 * SECOND);
    expect(
      (await f.view()).dispatch_stalls.filter(
        (s) => s.assignment_id === a.id && s.kind === "standing_backlog",
      ),
    ).toEqual([]);
  },
);

test.each(["pi", "claude-code"] as const)(
  "C-680: %s: a turn that ends long after the bell is followed on the next pass",
  async (harness) => {
    const { f, a, runs, finish, dispatcher } = idleHostOps(harness);
    f.event("fixture_notice", {}, a);
    await dispatcher.tick();
    // Still running when the first retry falls due: nothing is re-sent.
    f.advance(5 * 60 * SECOND);
    await dispatcher.tick();
    expect(f.runtime.wake).toHaveBeenCalledOnce();
    expect(runs()).toHaveLength(1);
    finish();
    f.advance(SECOND);
    await dispatcher.tick();
    expect(runs()).toHaveLength(2);
    expect(f.runtime.wake).toHaveBeenCalledTimes(2);
  },
);

test.each(["pi", "claude-code"] as const)(
  "C-680: %s: a notification arriving after the turn ended queues a Run on the first pass",
  async (harness) => {
    const { f, a, runs, finish, dispatcher } = idleHostOps(harness);
    finish();
    const notice = f.event("fixture_notice", {}, a);
    await dispatcher.tick();
    expect(runs()[1]).toMatchObject({ trigger_event_id: notice.id });
    expect(f.runtime.wake).toHaveBeenCalledOnce();
  },
);

test("C-680: a read project-stream bell is not re-sent after the turn", async () => {
  const { f, a, runs, finish, dispatcher } = idleHostOps("pi");
  const notice = f.event("fixture_notice", {}, a);
  await dispatcher.tick();
  // The Agent reads and acks the project stream before finishing.
  f.store.uow.run((tx) =>
    tx.cursors.put(f.project, {
      assignment_id: a.id,
      card_id: PROJECT_EVENT_STREAM,
      acked_seq: notice.seq,
    }),
  );
  finish();
  for (let i = 0; i < 6; i++) {
    f.advance(30 * SECOND);
    await dispatcher.tick();
  }
  expect(runs()).toHaveLength(1);
  expect(f.runtime.wake).toHaveBeenCalledOnce();
});

/** The patrol's own backlog with an upstream monitor whose line is healthy. */
function patrolWithMonitor() {
  const f = setup();
  f.ownTerminals();
  vi.spyOn(console, "info").mockImplementation(() => {});
  const a = f.ops;
  const config = parseLaunchConfig({
    providers: {
      deepseek: {
        harness: "pi",
        upstream: {
          group: "deepseek",
          probe_url: "https://gateway.example.invalid",
        },
      },
    },
    profiles: { fixture: { harness: "pi", provider: "deepseek" } },
    upstream_health: {
      probe: { interval_ms: 100, timeout_ms: 20, stale_after_ms: 1_000_000 },
    },
  });
  const monitor = new UpstreamHealthMonitor(
    config,
    f.runtime,
    f.clock,
    async () => ({ status: "reachable" }),
    f.store,
  );
  const service = new HostOpsService({
    ...f.options,
    upstreamMonitor: monitor,
  });
  const run = f.session(a);
  f.store.uow.run((tx) => {
    for (const r of tx.runs.list(f.project))
      if (r.assignment_id === a.id)
        tx.runs.put(f.project, {
          ...r,
          harness: "pi",
          launch_profile_ref: "fixture",
        });
    const owner = tx.assignments.get(f.project, a.id);
    if (owner)
      tx.assignments.put(f.project, { ...owner, runtime_state: "idle" });
  });
  f.skipEvents();
  const events = (type: string) => eventsOfType(f.state().events, type);
  const runs = () => f.state().runs.filter((r) => r.assignment_id === a.id);
  return { f, a, run, monitor, service, events, runs };
}

async function settle(service: HostOpsService, until: () => void) {
  await service.tick();
  await vi.waitFor(async () => {
    await service.tick();
    until();
  });
}

/** The nudged Run is taken and finished, but the backlog note stays unread. */
function ignore(f: ReturnType<typeof setup>, a: Assignment, id: string) {
  f.apply((s, actor, p) =>
    dispatchRun(s, actor, { run_id: id, runtime_ref: f.refFor(a) }, p),
  );
  f.apply(
    (s, actor, p) => acknowledgeRun(s, actor, { run_id: id }, p),
    f.actorFor(a),
  );
  f.apply(
    (s, actor, p) =>
      finishRun(
        s,
        actor,
        { run_id: id, outcome: "completed", summary: "fixture" },
        p,
      ),
    f.actorFor(a),
  );
}

test("C-680: without a line fault a withdrawn patrol restart names the condition that held it, then queues bounded Runs in the original session", async () => {
  const { f, a, monitor, service, events, runs } = patrolWithMonitor();
  try {
    // The terminal is idle for the stall evidence, but the upstream check
    // sees the harness working: agent_busy, with no upstream incident.
    vi.spyOn(monitor, "observe").mockImplementation(async () => ({
      [a.id]: "working" as const,
    }));
    f.event("host_ops_patrol_due", { assignment_id: a.id }, a);
    f.advance(11 * 60 * SECOND);
    await settle(service, () =>
      expect(events("host_ops_action_finished")).toHaveLength(1),
    );
    expect(events("upstream_incident_started")).toEqual([]);
    const [withdrawn] = events("host_ops_action_finished");
    expect(withdrawn?.payload).toMatchObject({
      result: "withdrawn_stall_changed",
      reason: "agent_busy",
      blocked_by: {
        cause: "agent_busy",
        action: "none",
        evidence: ["harness_working"],
      },
    });
    expect(
      (withdrawn?.payload as { reason?: string } | undefined)?.reason,
    ).not.toBe("upstream_recovery_not_ready");
    expect(f.runtime.retire_idle).not.toHaveBeenCalled();
    const [row] = (await f.view()).dispatch_stalls.filter(
      (s) => s.assignment_id === a.id,
    );
    expect(row).toMatchObject({
      kind: "standing_backlog",
      withdrawn_reason: "agent_busy",
      withdrawn_blocked_by: { cause: "agent_busy" },
    });
    expect((row as { next_step?: string }).next_step).toContain(
      "harness_working",
    );
    // Not before the retry interval.
    await service.tick();
    expect(runs().filter((r) => r.status === "queued")).toEqual([]);
    // Lightest recovery: a Run for the same live session, like
    // `assignment start`. Nothing is stopped or released.
    const ref = f.state().assignments.find((v) => v.id === a.id)?.runtime_ref;
    const nudged: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      f.advance(attempt === 1 ? 60 * SECOND : 11 * 60 * SECOND);
      await settle(service, () =>
        expect(events("dispatch_stall_nudged")).toHaveLength(attempt),
      );
      const queued = runs().filter((r) => r.status === "queued");
      expect(queued).toMatchObject([{ kind: "initial" }]);
      expect(events("dispatch_stall_nudged").at(-1)?.payload).toMatchObject({
        assignment_id: a.id,
        dispatch_stall_id: row?.cause_id,
        run_id: queued[0]?.id,
        attempt,
      });
      nudged.push(queued[0]?.id as string);
      ignore(f, a, queued[0]?.id as string);
    }
    expect(
      f.state().assignments.find((v) => v.id === a.id)?.runtime_ref,
    ).toEqual(ref);
    expect(f.runtime.release).not.toHaveBeenCalled();
    expect(f.runtime.retire_idle).not.toHaveBeenCalled();
    expect(events("host_ops_action_taken")).toHaveLength(1);
    // Bounded per incident and visible in diagnostics.
    f.advance(11 * 60 * SECOND);
    await service.tick();
    await service.tick();
    expect(events("dispatch_stall_nudged")).toHaveLength(3);
    expect(runs().filter((r) => r.status === "queued")).toEqual([]);
    const [after] = (await f.view()).dispatch_stalls.filter(
      (s) => s.assignment_id === a.id,
    );
    expect(after).toMatchObject({
      cause_id: row?.cause_id,
      light_recovery: { attempts: 3, limit: 3 },
    });
    expect((after as { next_step?: string }).next_step).toContain("3/3");
    expect(new Set(nudged).size).toBe(3);
  } finally {
    await service.close();
  }
});

test("C-680: a human stop is never nudged", async () => {
  const { f, a, monitor, service, events } = patrolWithMonitor();
  try {
    vi.spyOn(monitor, "observe").mockImplementation(async () => ({
      [a.id]: "working" as const,
    }));
    f.event("host_ops_patrol_due", { assignment_id: a.id }, a);
    f.advance(11 * 60 * SECOND);
    await settle(service, () =>
      expect(events("host_ops_action_finished")).toHaveLength(1),
    );
    f.event("assignment_stopped", { assignment_id: a.id, hold: true });
    for (let i = 0; i < 3; i++) {
      f.advance(60 * SECOND);
      await service.tick();
      await service.tick();
    }
    expect(events("dispatch_stall_nudged")).toEqual([]);
  } finally {
    await service.close();
  }
});
