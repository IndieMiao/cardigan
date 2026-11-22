import {
  abortDispatch,
  acknowledgeRun,
  finishRun,
  prepareDelivery,
  queueRun,
  type Runtime,
  recoverPreparation,
} from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import { expect, test, vi } from "vitest";
import { parallelParams } from "../../../packages/domain/src/commands/parallel-review/test-fixtures.js";
import {
  actor,
  value,
} from "../../../packages/domain/src/commands/test-fixtures.js";
import { sharedRepairStore } from "../test-support/shared-repair.js";
import { Dispatcher } from "./dispatch.js";

type Fixture = Awaited<ReturnType<typeof sharedRepairStore>>;
function queueRepair(f: Fixture, retry: boolean) {
  return f.store.uow.run((tx) => {
    const read = () => loadCommandState(tx, f.project);
    const s = read(),
      system = { kind: "system" as const, project_id: f.project },
      ports = { clock: f.clock, ids: tx.ids };
    const rejection = s.events.findLast((e) => e.type === "review_submitted");
    const owner = s.assignments.find((a) => a.id === f.owner);
    if (!rejection || !owner) throw Error("missing first repair");
    const effect = value(
      queueRun(
        s,
        system,
        {
          assignment_id: f.owner,
          kind: "rework",
          trigger_event_id: rejection.id,
          model: "fixture",
          agent_cli_version: "1",
        },
        ports,
      ),
    );
    persistEffect(tx, f.project, effect);
    if (!retry) return effect.data;
    persistEffect(
      tx,
      f.project,
      value(
        abortDispatch(
          read(),
          system,
          { run_id: effect.data.id, reason: "directory preparation failed" },
          ports,
        ),
      ),
    );
    const recovery = value(
      recoverPreparation(
        read(),
        system,
        {
          run_id: effect.data.id,
          category: "repository_lock_timeout",
          execution_exited: true,
          cleanup_complete: true,
          expected_runtime_ref: owner.runtime_ref,
          backoff_ms: 5000,
        },
        ports,
      ),
    );
    persistEffect(tx, f.project, recovery);
    if (!recovery.data) throw Error("missing queued retry");
    return recovery.data;
  });
}

test.each(
  ["queued", "preparation_retry", "withdrawn_first_send"].flatMap((phase) =>
    ["before", "after"].map((finish) => [phase, finish]),
  ),
)(
  "%s: discussion finishes %s release; only the original repair is sent once",
  async (phase, finish) => {
    const f = await sharedRepairStore();
    let pauseBeforeSend = phase === "withdrawn_first_send";
    const repair = !pauseBeforeSend
      ? queueRepair(f, phase === "preparation_retry")
      : undefined;
    if (repair) f.pause();
    const writes: string[] = [];
    const wake: Runtime["wake"] = async (_ref, bell, opts) => {
      if (pauseBeforeSend) {
        pauseBeforeSend = false;
        f.pause();
      }
      if (opts?.before_send && !(await opts.before_send()))
        return { ok: true, value: { sent: false, withdrawn: true } };
      writes.push(/\brun=(R-\d+)/.exec(bell)?.[1] ?? bell);
      return { ok: true, value: { sent: true } };
    };
    const loop = () =>
      new Dispatcher({
        store: f.store,
        clock: f.clock,
        snapshot: async () => ({ model: "fixture", agent_cli_version: "1" }),
        startRun: vi.fn(),
        runtime: {
          wake,
          status: async () => ({
            ok: true,
            value: { process: "alive", agent: "idle", observed_seq: 0 },
          }),
          release: vi.fn(),
          interrupt: vi.fn(),
          provision: vi.fn(),
          resume_or_replace: vi.fn(),
          human_entry: vi.fn(),
        },
      });
    await loop().tick();
    const runs = () => f.read().runs.filter((r) => r.assignment_id === f.owner);
    const repairId = repair?.id ?? runs().find((r) => r.kind === "rework")?.id;
    if (!repairId) throw Error("missing repair run");
    f.advance(5001);
    await loop().tick();
    await loop().tick();
    expect(runs().find((r) => r.id === repairId)).toMatchObject({
      status: "queued",
    });
    const instruction = f
      .read()
      .events.find((e) => e.type === "instruction_issued");
    const discussion = runs().find(
      (r) => r.trigger_event_id === instruction?.id,
    );
    expect(discussion).toMatchObject({
      kind: "followup",
      status: "dispatched",
    });
    if (!discussion) throw Error("missing discussion");
    f.store.uow.run((tx) => {
      const ports = { clock: f.clock, ids: tx.ids };
      const s = () => loadCommandState(tx, f.project);
      persistEffect(
        tx,
        f.project,
        value(acknowledgeRun(s(), actor(), { run_id: discussion.id }, ports)),
      );
      expect(
        s().work_items.find((w) => w.id === f.target.work_item_id)?.status,
      ).toBe("changes_requested");
    });
    const verify = vi.fn();
    expect(
      await prepareDelivery(f.read(), actor(), parallelParams, { verify }),
    ).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("暂停尚未结案") },
    });
    expect(verify).not.toHaveBeenCalled();
    if (finish === "after") {
      f.resume();
      await loop().tick();
      expect(runs().find((r) => r.id === repairId)?.status).toBe("queued");
    }
    f.store.uow.run((tx) => {
      const ports = { clock: f.clock, ids: tx.ids };
      const s = () => loadCommandState(tx, f.project);
      persistEffect(
        tx,
        f.project,
        value(
          finishRun(
            s(),
            actor(),
            {
              run_id: discussion.id,
              outcome: "completed",
              summary: "Ready for confirmation",
            },
            ports,
          ),
        ),
      );
    });
    if (finish === "before") {
      await loop().tick();
      expect(runs().find((r) => r.id === repairId)?.status).toBe("queued");
      f.resume();
    }
    await Promise.all([loop().tick(), loop().tick()]);
    await loop().tick();
    expect(
      runs().filter((r) => r.kind === "rework" && r.status !== "cancelled"),
    ).toMatchObject([{ id: repairId, status: "dispatched" }]);
    expect(
      writes.filter((id) => id === repairId || id === discussion.id),
    ).toEqual([discussion.id, repairId]);
  },
);
