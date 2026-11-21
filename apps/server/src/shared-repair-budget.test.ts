import type { Runtime } from "@cardigan/domain";
import { listBellAttempts, Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { sharedRepairStore } from "../test-support/shared-repair.js";
import { Dispatcher } from "./dispatch.js";

// All rows come from the dispatcher. Reopen the SQLite file on each scan so
// neither retry eligibility nor the retained refusal receipts can rely on memory.
// F: preparation failed, R: explicit refusal, U: write with a lost acknowledgement.
test.each([
  ["first ordinary failure", "F", "send"],
  ["four refusals before first failure", "RRRRF", "send"],
  ["refusal between ordinary failures", "FRF", "send"],
  ["repeated send-slot refusals reach the handoff deadline", "RR", "handoff"],
  ["ordinary budget exhausted", "FFFFF", "recover"],
  ["same exhaustion with refusals", "FRFFRFF", "recover"],
  ["unknown fifth attempt still waits for ACK", "FFFFU", "wait"],
] as const)(
  "shared repair budget: %s",
  async (_name, sequence, finalAction) => {
    const f = await sharedRepairStore();
    let pause = true,
      step = "",
      writes = 0;
    const release = vi.fn<Runtime["release"]>(async () => ({
      ok: true,
      value: undefined,
    }));
    const runtime: Runtime = {
      status: async () => ({
        ok: true,
        value: { process: "alive", agent: "idle", observed_seq: 0 },
      }),
      wake: async (_r, _b, opts) => {
        if (!opts?.before_send?.() || step === "R")
          return { ok: true, value: { sent: false, withdrawn: true } };
        writes++;
        if (step === "U")
          return {
            ok: false,
            error: { code: "runtime_timeout", message: "lost receipt" },
          };
        return { ok: true, value: { sent: true } };
      },
      release,
      provision: vi.fn(),
      interrupt: vi.fn(),
      resume_or_replace: vi.fn(),
      human_entry: vi.fn(),
    };
    const tick = async () => {
      const store = Store.open({ dataDir: f.dataDir, clock: f.clock });
      try {
        await new Dispatcher({
          store,
          clock: f.clock,
          runtime,
          startRun: vi.fn(),
          snapshot: async () => ({ model: "fixture", agent_cli_version: "1" }),
          beforeWake: async () => {
            if (pause) {
              pause = false;
              f.pause();
            } else if (step === "F")
              throw Error("temporary preparation failure");
          },
        }).tick();
      } finally {
        store.close();
      }
    };
    await tick();
    const run = f
      .read()
      .runs.find((r) => r.kind === "rework" && r.assignment_id === f.owner);
    if (!run) throw Error("Missing repair Run");
    expect(f.resume()?.payload).toMatchObject({ rework_run_id: run.id });
    const rows = () =>
      listBellAttempts(f.store.database, f.project, run.id).map((a) =>
        a.outcome !== "failed"
          ? a.outcome
          : a.review_wake?.refused_at
            ? "R"
            : a.review_wake?.sending_at
              ? "U"
              : "F",
      );
    let ordinary = 0,
      waited = "";
    for (const next of sequence) {
      step = next;
      await tick();
      waited += next;
      expect(rows()).toEqual([...waited]);
      expect(release).not.toHaveBeenCalled();
      if (next === "F") ordinary++;
      if (finalAction !== "send" && waited === sequence) break;
      const delay = next === "R" ? 30_000 : 30_000 * 2 ** (ordinary - 1);
      f.advance(delay - 1);
      await tick();
      expect(rows()).toEqual([...waited]);
      expect(release).not.toHaveBeenCalled();
      f.advance(1);
    }
    if (finalAction === "handoff") {
      const waits = () =>
        f
          .read()
          .events.filter(
            (e) =>
              e.type.startsWith("bell_wake_") &&
              (e.payload as { run_id?: string }).run_id === run.id,
          );
      expect(waits()).toMatchObject([
        {
          type: "bell_wake_deferred",
          created_at: new Date(
            Date.parse(f.clock.now()) - 30_000,
          ).toISOString(),
        },
      ]);
      f.advance(570_000);
      await tick();
      expect(waits().map((e) => e.type)).toEqual([
        "bell_wake_deferred",
        "bell_wake_escalated",
      ]);
      const ids =
        listBellAttempts(f.store.database, f.project, run.id).at(-1)
          ?.notification_ids ?? [];
      expect(ids).toHaveLength(1);
      expect(
        f.store.listNotifications({ project_id: f.project, ids }),
      ).toMatchObject([
        {
          event_id: run.trigger_event_id,
          status: "needs_attention",
          attempts: 0,
        },
      ]);
      const history = rows();
      step = "";
      f.advance(600_000);
      await tick();
      expect(rows()).toEqual(history);
      expect(writes).toBe(0);
      expect(release).not.toHaveBeenCalled();
      return;
    }
    step = "";
    await tick();
    if (finalAction === "wait") {
      f.advance(30_001);
      await tick();
      expect(rows()).toEqual([...sequence]);
      expect(writes).toBe(1);
      expect(release).not.toHaveBeenCalled();
    } else if (finalAction === "recover") {
      expect(writes).toBe(0);
      expect(release).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ force: true }),
      );
    } else {
      await tick();
      expect(writes).toBe(1);
      expect(release).not.toHaveBeenCalled();
      expect(rows()).toEqual([...sequence, "sent"]);
    }
  },
);
