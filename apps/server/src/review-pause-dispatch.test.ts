import {
  acknowledgeRun,
  finishRun,
  prepareDelivery,
  queueRun,
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

test.each(["before", "after"])(
  "a discussion finishes %s release: its queued repair dispatches exactly once",
  async (finish) => {
    const f = await sharedRepairStore();
    const repair = f.store.uow.run((tx) => {
      const s = loadCommandState(tx, f.project);
      const rejection = s.events.findLast((e) => e.type === "review_submitted");
      if (!rejection) throw Error("missing rejection");
      const effect = value(
        queueRun(
          s,
          { kind: "system", project_id: f.project },
          {
            assignment_id: f.owner,
            kind: "rework",
            trigger_event_id: rejection.id,
            model: "fixture",
            agent_cli_version: "1",
          },
          { clock: f.clock, ids: tx.ids },
        ),
      );
      persistEffect(tx, f.project, effect);
      return effect.data;
    });
    f.pause();
    const wake = vi.fn(async () => ({
      ok: true as const,
      value: { sent: true },
    }));
    const loop = new Dispatcher({
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
    await loop.tick();
    const runs = () => f.read().runs.filter((r) => r.assignment_id === f.owner);
    expect(runs().find((r) => r.id === repair.id)).toMatchObject({
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
      await loop.tick();
      expect(runs().find((r) => r.id === repair.id)?.status).toBe("queued");
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
      await loop.tick();
      expect(runs().find((r) => r.id === repair.id)?.status).toBe("queued");
      f.resume();
    }
    await loop.tick();
    await loop.tick();
    expect(runs().filter((r) => r.kind === "rework")).toMatchObject([
      { id: repair.id, status: "dispatched" },
    ]);
    expect(
      f
        .read()
        .events.filter(
          (e) =>
            e.type === "run_dispatched" &&
            (e.payload as { run_id?: string }).run_id === repair.id,
        ),
    ).toHaveLength(1);
  },
);
