import {
  acknowledgeRun,
  finishRun,
  postComment,
  queueRun,
  updateCard,
} from "@cardigan/domain";
import {
  launchRun,
  RunTargetDeferred,
  refreshTargetWait,
  runCapacitySnapshot,
} from "@cardigan/host";
import { parseLaunchConfig } from "@cardigan/roles";
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
