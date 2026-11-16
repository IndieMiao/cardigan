import {
  acknowledgeRun,
  claimDispatchStop,
  dispatchRun,
  finishRun,
  postComment,
  queueRun,
  recoverDispatch,
  startDispatchStop,
  updateCard,
} from "@cardigan/domain";
import {
  launchRun,
  RunTargetDeferred,
  refreshTargetWait,
  runCapacitySnapshot,
} from "@cardigan/host";
import { parseLaunchConfig } from "@cardigan/roles";
import { routeEvent } from "@cardigan/router";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { Dispatcher } from "./dispatch.js";

const hold = { reason: "等待现场", resume_condition: "证据齐备" };

test("hold retains pending notifications and resumes through the same incremental candidate cache", async () => {
  const f = recoveryFixture();
  try {
    f.comment();
    const dispatcher = new Dispatcher(f.options);
    f.apply((s, a, p) =>
      updateCard(s, a, { card_id: f.target.card.id, hold }, p),
    );
    await dispatcher.tick();
    expect(f.runtime.wake).not.toHaveBeenCalled();
    expect(f.state().runs.every((r) => r.status === "completed")).toBe(true);
    expect(f.notes().some((n) => n.status === "pending")).toBe(true);
    f.apply((s, a, p) =>
      updateCard(s, a, { card_id: f.target.card.id, hold: null }, p),
    );
    await dispatcher.tick();
    expect(f.runtime.wake).toHaveBeenCalledTimes(1);
  } finally {
    f.close();
  }
});

test("hold committed during runtime observation wins before queue/dispatch claim", async () => {
  const f = recoveryFixture();
  try {
    f.comment();
    vi.mocked(f.runtime.status).mockImplementationOnce(async () => {
      f.apply((s, a, p) =>
        updateCard(s, a, { card_id: f.target.card.id, hold }, p),
      );
      return {
        ok: true,
        value: { process: "alive", agent: "idle", observed_seq: 1 },
      };
    });
    await new Dispatcher(f.options).tick();
    expect(f.runtime.wake).not.toHaveBeenCalled();
    expect(f.state().runs.every((r) => r.status === "completed")).toBe(true);
  } finally {
    f.close();
  }
});

test("queued holds remain durable but leave the capacity queue; host startup and cross-connection cache recheck them", () => {
  const f = recoveryFixture();
  const other = Store.open({ dataDir: f.dataDir });
  try {
    const run = f.apply((s, a, p) =>
      queueRun(
        s,
        a,
        {
          assignment_id: f.target.assignment.id,
          model: "fixture",
          agent_cli_version: "fixture",
        },
        p,
      ),
    );
    f.store.uow.run((tx) =>
      tx.runs.put(f.project, { ...run, queue_reason: "concurrency_limit" }),
    );
    expect(
      f.store.uow.read((tx) => runCapacitySnapshot(f.store, tx).queue).length,
    ).toBe(1);
    expect(() =>
      f.store.uow.run((tx) => {
        tx.cards.put(f.project, {
          ...f.target.card,
          hold: { ...hold, set_by: "human", set_at: f.clock.now() },
        });
        expect(runCapacitySnapshot(f.store, tx).queue).toEqual([]);
        throw new Error("synthetic rollback");
      }),
    ).toThrow("synthetic rollback");
    expect(
      f.store.uow.read((tx) => runCapacitySnapshot(f.store, tx).queue),
    ).toHaveLength(1);
    expect(
      f.state().cards.find((c) => c.id === f.target.card.id)?.hold,
    ).toBeUndefined();
    // A separate connection must invalidate both cached card and queue projections.
    other.uow.run((tx) =>
      tx.cards.put(f.project, {
        ...f.target.card,
        hold: { ...hold, set_by: "human", set_at: f.clock.now() },
      }),
    );
    expect(refreshTargetWait(f.store, f.project, run.id, f.clock)).toBe(true);
    expect(
      f.store.uow.read((tx) => runCapacitySnapshot(f.store, tx).queue),
    ).toEqual([]);
    expect(f.state().runs.find((r) => r.id === run.id)).toMatchObject({
      id: run.id,
      status: "queued",
      assignment_id: run.assignment_id,
    });
    f.apply((s, a, p) =>
      updateCard(s, a, { card_id: f.target.card.id, hold: null }, p),
    );
    expect(refreshTargetWait(f.store, f.project, run.id, f.clock)).toBe(false);
    expect(
      f.store.uow.read((tx) => runCapacitySnapshot(f.store, tx).queue).length,
    ).toBe(1);
  } finally {
    other.close();
    f.close();
  }
});

test("host launch rejects a held queued Run before runtime or credential side effects", async () => {
  const f = recoveryFixture();
  try {
    const run = f.apply((s, a, p) =>
      queueRun(
        s,
        a,
        {
          assignment_id: f.target.assignment.id,
          model: "fixture",
          agent_cli_version: "fixture",
        },
        p,
      ),
    );
    f.apply((s, a, p) =>
      updateCard(s, a, { card_id: f.target.card.id, hold }, p),
    );
    const tokens = f.store.uow.run((tx) =>
      tx.tokensForAssignment(f.project, f.target.assignment.id),
    );
    await expect(
      launchRun(
        {
          store: f.store,
          runtime: f.runtime,
          clock: f.clock,
          dataDir: f.dataDir,
          mcpUrl: "http://127.0.0.1:7780/mcp",
          launch: {
            config: parseLaunchConfig({
              profiles: { fixture: { harness: "pi", model: "fixture" } },
            }),
            secrets: {},
          },
        },
        {
          project: f.project,
          assignment_id: f.target.assignment.id,
          run,
          actor: { kind: "human", project_id: f.project },
        },
      ),
    ).rejects.toBeInstanceOf(RunTargetDeferred);
    expect(f.runtime.provision).not.toHaveBeenCalled();
    expect(f.runtime.wake).not.toHaveBeenCalled();
    expect(
      f.store.uow.run((tx) =>
        tx.tokensForAssignment(f.project, f.target.assignment.id),
      ),
    ).toEqual(tokens);
    expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe("queued");
  } finally {
    f.close();
  }
});

test("a standing PM retains held queued work while dispatching another card, then resumes the original Run", async () => {
  const f = recoveryFixture();
  try {
    const pm = f.pm();
    f.session(pm);
    const pmWakes = () =>
      vi
        .mocked(f.runtime.wake)
        .mock.calls.filter(
          ([ref]) => ref.terminal_ref === f.refFor(pm).terminal_ref,
        );
    const second = f.create();
    f.skipEvents();
    const comment = (card_id: typeof f.target.card.id) =>
      f.apply((s, a, p) =>
        postComment(
          s,
          a,
          { card_id, body: `@${pm.id} Please inspect`, mentions: [pm.id] },
          p,
        ),
      );
    comment(f.target.card.id);
    const trigger = f
      .state()
      .events.findLast(
        (e) => e.card_id === f.target.card.id && e.type === "comment_posted",
      );
    if (!trigger) throw new Error("Missing trigger");
    const queued = f.apply((s, a, p) =>
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
    );
    f.store.uow.run((tx) =>
      tx.runs.put(f.project, { ...queued, queue_reason: "concurrency_limit" }),
    );
    f.apply((s, a, p) =>
      updateCard(s, a, { card_id: f.target.card.id, hold }, p),
    );
    comment(second.card.id);
    const dispatcher = new Dispatcher(f.options);
    await dispatcher.tick();
    const current = f
      .state()
      .runs.find((r) => r.assignment_id === pm.id && r.status === "dispatched");
    expect(current).toBeDefined();
    expect(current?.id).not.toBe(queued.id);
    expect(f.state().runs.find((r) => r.id === queued.id)).toMatchObject({
      status: "queued",
      assignment_id: pm.id,
      trigger_event_id: trigger.id,
    });
    expect(pmWakes()).toHaveLength(1);
    f.apply((s, a, p) =>
      updateCard(s, a, { card_id: f.target.card.id, hold: null }, p),
    );
    await dispatcher.tick();
    expect(pmWakes()).toHaveLength(1);
    if (!current) throw new Error("Missing dispatched Run");
    f.apply(
      (s, a, p) => acknowledgeRun(s, a, { run_id: current.id }, p),
      f.actorFor(pm),
    );
    f.apply(
      (s, a, p) =>
        finishRun(
          s,
          a,
          {
            run_id: current.id,
            outcome: "completed",
            summary: "Second card checked",
          },
          p,
        ),
      f.actorFor(pm),
    );
    await dispatcher.tick();
    expect(f.state().runs.find((r) => r.id === queued.id)?.status).toBe(
      "dispatched",
    );
    expect(pmWakes()).toHaveLength(2);
  } finally {
    f.close();
  }
});

test.each(["runtime_not_found", "tool_catalog_changed"] as const)(
  "real host replacement (%s) launches the other task and retains the held Run",
  async (reason) => {
    const f = recoveryFixture();
    try {
      const pm = f.pm();
      f.session(pm);
      f.comment();
      const trigger = f
        .state()
        .events.findLast((e) => e.type === "comment_posted");
      if (!trigger) throw new Error("Missing trigger");
      const params = {
        assignment_id: pm.id,
        model: "fixture",
        agent_cli_version: "fixture",
      };
      const held = f.apply((s, a, p) =>
        queueRun(s, a, { ...params, trigger_event_id: trigger.id }, p),
      );
      f.apply((s, a, p) =>
        updateCard(s, a, { card_id: f.target.card.id, hold }, p),
      );
      const run = f.apply((s, a, p) => queueRun(s, a, params, p));
      const previous = f.refFor(pm);
      const fresh = { ...previous, terminal_ref: "replacement-session" };
      vi.mocked(f.runtime.resume_or_replace).mockResolvedValue({
        ok: true,
        value: fresh,
      });
      const launch = () =>
        launchRun(
          {
            store: f.store,
            runtime: f.runtime,
            clock: f.clock,
            dataDir: f.dataDir,
            mcpUrl: "http://127.0.0.1:7780/mcp",
            launch: {
              config: parseLaunchConfig({
                profiles: { fixture: { harness: "pi", model: "fixture" } },
              }),
              secrets: {},
            },
          },
          {
            project: f.project,
            assignment_id: pm.id,
            run,
            actor: { kind: "system", project_id: f.project },
            replacement: { previous, reason },
          },
        );
      // Queued records with evidence of execution or an uncertain launch are not dormant.
      for (const patch of [
        { status: "dispatched" as const },
        { started_at: f.clock.now() },
        {
          launch_publication: {
            generation: "pending",
            phase: "preparing" as const,
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
        },
      ]) {
        f.store.uow.run((tx) => tx.runs.put(f.project, { ...held, ...patch }));
        await expect(launch()).rejects.toThrow();
        expect(f.runtime.provision).not.toHaveBeenCalled();
        expect(f.runtime.resume_or_replace).not.toHaveBeenCalled();
      }
      f.store.uow.run((tx) => tx.runs.put(f.project, held));
      const launched = await launch();
      expect(launched.runtime_ref).toEqual(fresh);
      expect(f.runtime.resume_or_replace).toHaveBeenCalledOnce();
      expect(f.state().runs.find((r) => r.id === held.id)).toEqual(held);
      expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe(
        "dispatched",
      );
      expect(
        f.state().events.findLast((e) => e.type === "session_replaced")
          ?.payload,
      ).toMatchObject({
        assignment_id: pm.id,
        run_id: run.id,
        old_runtime_ref: previous,
        reason,
      });
    } finally {
      f.close();
    }
  },
);

test("a recovered standing task keeps its source through routing, host launch and cached dispatch", async () => {
  const f = recoveryFixture();
  try {
    const pm = f.pm();
    f.session(pm);
    const second = f.create();
    const queueFor = (card_id: typeof f.target.card.id) => {
      f.apply((s, a, p) =>
        postComment(
          s,
          a,
          { card_id, body: "Inspect source", mentions: [pm.id] },
          p,
        ),
      );
      const trigger = f
        .state()
        .events.findLast((e) => e.type === "comment_posted");
      if (!trigger) throw new Error("Missing trigger");
      return f.apply((s, a, p) =>
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
      );
    };
    const waiting = queueFor(f.target.card.id);
    f.apply((s, a, p) =>
      updateCard(s, a, { card_id: f.target.card.id, hold }, p),
    );
    const original = queueFor(second.card.id);
    f.apply((s, a, p) =>
      dispatchRun(s, a, { run_id: original.id, runtime_ref: f.refFor(pm) }, p),
    );
    f.skipEvents();
    const system = { kind: "system" as const, project_id: f.project };
    const claimed = f.apply(
      (s, a, p) =>
        claimDispatchStop(
          s,
          a,
          { run_id: original.id, reason: "dispatch_timeout", lease_ms: 60000 },
          p,
        ),
      system,
    );
    const stop = claimed?.dispatch_stop;
    if (!stop) throw new Error("Missing stop");
    f.apply(
      (s, a, p) =>
        startDispatchStop(
          s,
          a,
          { run_id: original.id, attempt_id: stop.attempt_id },
          p,
        ),
      system,
    );
    const next = f.apply(
      (s, a, p) =>
        recoverDispatch(
          s,
          a,
          {
            run_id: original.id,
            stop_id: stop.attempt_id,
            stopped_runtime: stop.runtime_ref,
            timeout_ms: 1000,
            failed_attempts: 3,
            max_failures: 3,
          },
          p,
        ),
      system,
    );
    if (!next) throw new Error("Missing successor");
    const event = f.state().events.find((e) => e.id === next.trigger_event_id);
    if (!event) throw new Error("Missing recovery event");
    expect(routeEvent({ event, snapshot: f.state() }).notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipient: { kind: "assignment", assignment_id: pm.id },
          card_id: second.card.id,
          event_id: event.id,
          seq: event.seq,
        }),
      ]),
    );
    f.apply((s, a, p) =>
      updateCard(s, a, { card_id: second.card.id, hold }, p),
    );
    const dispatcher = new Dispatcher(f.options);
    await dispatcher.tick();
    expect(f.options.startRun).not.toHaveBeenCalled();
    await expect(
      launchRun(
        {
          store: f.store,
          runtime: f.runtime,
          clock: f.clock,
          dataDir: f.dataDir,
          mcpUrl: "http://127.0.0.1:7780/mcp",
          launch: {
            config: parseLaunchConfig({
              profiles: { fixture: { harness: "pi", model: "fixture" } },
            }),
            secrets: {},
          },
        },
        { project: f.project, assignment_id: pm.id, actor: system, run: next },
      ),
    ).rejects.toBeInstanceOf(RunTargetDeferred);
    expect(f.runtime.provision).not.toHaveBeenCalled();
    expect(f.state().runs.find((r) => r.id === next.id)?.status).toBe("queued");
    f.apply((s, a, p) =>
      updateCard(s, a, { card_id: second.card.id, hold: null }, p),
    );
    await dispatcher.tick();
    expect(f.state().runs.find((r) => r.id === next.id)?.status).toBe(
      "dispatched",
    );
    expect(f.state().runs.find((r) => r.id === waiting.id)).toMatchObject(
      waiting,
    );
    const startRun = f.options.startRun;
    if (!startRun) throw new Error("Missing start callback");
    expect(
      vi
        .mocked(startRun)
        .mock.calls.filter(([job]) => job.assignment.id === pm.id)
        .map(([job]) => job.run.id),
    ).toEqual([next.id]);
  } finally {
    f.close();
  }
});
