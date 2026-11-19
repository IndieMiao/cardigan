import {
  acknowledgeRun,
  dispatchRun,
  queueRun,
  type Runtime,
} from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import {
  beginLaunchAttempt,
  finishBellAttempt,
  listBellAttempts,
} from "@cardigan/store";
import { expect, test, vi } from "vitest";
import {
  actor,
  value,
} from "../../../packages/domain/src/commands/test-fixtures.js";
import { sharedRepairStore } from "../test-support/shared-repair.js";
import { Dispatcher } from "./dispatch.js";
import { deliveryAttemptFailed } from "./dispatch-alert.js";

// Reproduce the v42 protocol (unbound failure row; only Dispatcher had a
// transactional before-wake audit). No assertion depends on a migration backfill.
test.each([
  "no receipt",
  "late ACK",
  "before wake",
  "ambiguous audit",
  "superseded",
] as const)("legacy repair: %s", async (phase) => {
  const f = await sharedRepairStore();
  const run = f.store.uow.run((tx) => {
    const read = () => loadCommandState(tx, f.project);
    const review = read().events.findLast((e) => e.type === "review_submitted");
    const owner = tx.assignments.get(f.project, f.owner);
    if (!review || !owner) throw Error("Missing review fixture");
    const system = { kind: "system" as const, project_id: f.project };
    const ports = { ids: tx.ids, clock: f.clock };
    const queued = value(
      queueRun(
        read(),
        system,
        {
          assignment_id: f.owner,
          model: "fixture",
          agent_cli_version: "1",
          kind: "rework",
          trigger_event_id: review.id,
        },
        ports,
      ),
    );
    persistEffect(tx, f.project, queued);
    const at = f.clock.now();
    const attempt = beginLaunchAttempt(f.store.database, {
      project_id: f.project,
      id: "legacy",
      assignment_id: f.owner,
      run_id: queued.data.id,
      started_at: at,
      lease_until: new Date(Date.parse(at) + 60_000).toISOString(),
    });
    const dispatched = value(
      dispatchRun(read(), system, { run_id: queued.data.id }, ports),
    );
    persistEffect(tx, f.project, dispatched);
    finishBellAttempt(f.store.database, f.project, attempt.id, "failed", at);
    if (
      phase === "before wake" ||
      phase === "ambiguous audit" ||
      phase === "superseded"
    ) {
      for (let i = 0; i < (phase === "ambiguous audit" ? 2 : 1); i++)
        deliveryAttemptFailed(tx, read(), at, {
          assignment: owner,
          run_id: queued.data.id,
          notification_ids: [],
          reason: "before_wake_failed",
          error: { category: "fixture", message: "preparation" },
          card_id: review.card_id,
        });
    }
    return queued.data;
  });
  f.pause();
  expect(f.resume()?.payload).toMatchObject({ rework_run_id: run.id });
  let writes = 0;
  const release = vi.fn();
  const runtime: Runtime = {
    status: async () => ({
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 0 },
    }),
    wake: async (_ref, _msg, opts) => {
      if (opts?.before_send && !opts.before_send())
        return { ok: true, value: { sent: false, withdrawn: true } };
      writes++;
      return { ok: true, value: { sent: true } };
    },
    provision: vi.fn(),
    release,
    interrupt: vi.fn(),
    resume_or_replace: vi.fn(),
    human_entry: vi.fn(),
  };
  const tick = () =>
    new Dispatcher({
      store: f.store,
      clock: f.clock,
      runtime,
      startRun: vi.fn(),
      snapshot: async () => ({ model: "fixture", agent_cli_version: "1" }),
    }).tick();
  if (phase === "superseded")
    f.store.uow.run((tx) =>
      tx.deliveries.put(f.project, { ...f.target, status: "superseded" }),
    );
  f.advance(30_001);
  await tick();
  expect(writes).toBe(phase === "before wake" ? 1 : 0);
  if (phase === "superseded" || phase === "before wake") return;
  const ack = () =>
    f.store.uow.run((tx) =>
      persistEffect(
        tx,
        f.project,
        value(
          acknowledgeRun(
            loadCommandState(tx, f.project),
            actor(),
            { run_id: run.id },
            { clock: f.clock, ids: tx.ids },
          ),
        ),
      ),
    );
  if (phase === "late ACK") ack();
  f.advance(720_001);
  await tick();
  await tick();
  const stalls = f
    .read()
    .events.filter((e) => e.type === "run_dispatch_stalled");
  if (phase === "late ACK") expect(stalls).toHaveLength(0);
  else {
    expect(stalls.map((e) => e.payload)).toEqual([
      expect.objectContaining({
        run_id: run.id,
        reason: "legacy_repair_ack_unknown",
        delivery_id: f.target.id,
        target_sha: f.target.subject.value,
      }),
    ]);
    ack();
  }
  expect(f.read().runs.find((r) => r.id === run.id)?.status).toBe("running");
  expect(writes).toBe(0);
  expect(release).not.toHaveBeenCalled();
  expect(listBellAttempts(f.store.database, f.project, run.id)).toHaveLength(1);
});
