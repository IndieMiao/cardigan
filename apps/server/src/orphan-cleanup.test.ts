import { platform } from "node:os";
import type { RemoteWorkerLoss, Runtime } from "@cardigan/domain";
import { expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { syntheticSealedVolume } from "../test-support/sealed-volume.js";
import { cleanReleasedOrphan } from "./orphan-cleanup.js";

test.each([
  "verified",
  "dirty_again",
  "no_writer_fence",
  "backup_failure",
  "new_work",
  "reusable",
  "pidfd_unavailable",
])("orphan guard: %s", async (mode) => {
  const f = dispatchFixture("worker-a", "write"),
    { assignment: a, item } = f.create();
  const volume =
    mode === "verified" && platform() === "linux"
      ? await syntheticSealedVolume()
      : null;
  const lateWrites: string[] = [];
  try {
    const run = f.session(a, true),
      generation = "a".repeat(32),
      sha = "a".repeat(40),
      ref = {
        ...f.refFor(a),
        branch: "agent/fixture",
        worktree_path: "/fixture/worktree",
        launch_generation: { generation, run_id: run.id },
      };
    const process = {
      machine: "a".repeat(64),
      boot: "fixture",
      start: "123",
      pid: 99,
      uid: 88,
      process_group: 99,
      terminal: generation,
    };
    const action_id = f.store.uow.run((tx) => {
      const id = tx.ids.nextEventId();
      tx.assignments.put(f.project, {
        ...a,
        status: mode === "reusable" ? "active" : "released",
        branch: ref.branch,
        worktree_path: ref.worktree_path,
        runtime_ref: mode === "reusable" ? ref : null,
      });
      tx.events.append(f.project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(f.project, item.card_id),
        actor: { kind: "system", project_id: f.project },
        card_id: item.card_id,
        type: "remote_worker_released",
        payload: { action_id: id },
        created_at: f.clock.now(),
      });
      return id;
    });
    const loss: RemoteWorkerLoss = {
      action_id,
      machine_id: a.machine_id,
      assignment_id: a.id,
      work_item_id: item.id,
      runtime_ref: ref,
      process,
    };
    let signals = 0;
    const snapshot = vi.fn(
      async (
        _p: unknown,
        _a: unknown,
        verification?: { sha: string; process: typeof process },
      ) => {
        if (mode === "backup_failure") throw new Error("private error");
        if (verification) {
          expect(verification).toEqual({ sha, process });
          if (mode === "no_writer_fence") return null;
          await volume?.seal();
        }
        if (verification && mode === "dirty_again") return "b".repeat(40);
        return sha;
      },
    );
    const retire: NonNullable<Runtime["retire_idle"]> = async (_ref, opts) => {
      expect(opts.system_finished_turn && opts.expected_process).toEqual(
        process,
      );
      if (mode === "pidfd_unavailable")
        return {
          ok: true,
          value: {
            outcome: "withdrawn",
            evidence: { stage: "probe", reason: "pidfd_unavailable" },
          },
        };
      if (!opts.system_finished_turn || !(await opts.workspace_preflight()))
        return {
          ok: true,
          value: {
            outcome: "withdrawn",
            evidence: { stage: "TERM", reason: "guard_changed" },
          },
        };
      if (mode === "new_work")
        f.store.uow.run((tx) =>
          tx.runs.put(f.project, {
            ...run,
            id: tx.ids.next(f.project, "run") as typeof run.id,
            status: "queued",
          }),
        );
      // Attempt IO through an fd opened BEFORE final verification, both before
      // the signal and during the subsequent (uncertain) wait for exit.
      const attemptWrite = async () => {
        if (volume)
          lateWrites.push(
            await volume.write().then(
              () => "written",
              (e: NodeJS.ErrnoException) => e.code ?? "unknown",
            ),
          );
      };
      await attemptWrite();
      if (opts.before_signal()) signals++;
      await attemptWrite();
      return {
        ok: true,
        value: {
          outcome: "uncertain",
          evidence: { stage: "confirm", reason: "confirmation_pending" },
        },
      };
    };
    const clean = () =>
      cleanReleasedOrphan({
        store: f.store,
        project: f.project,
        clock: f.clock,
        loss,
        alive: true,
        stopped: () => false,
        runtime: { retire_idle: retire },
        snapshot,
      });
    await clean();
    await clean();
    expect(signals).toBe(mode === "verified" ? 1 : 0);
    if (volume) expect(lateWrites).toEqual(["EPERM", "EPERM"]);
    if (signals)
      expect(
        f.state().events.find((e) => e.type === "remote_orphan_stop_started")
          ?.payload,
      ).toMatchObject({ sha, action_id });
    if (
      mode === "backup_failure" ||
      mode === "pidfd_unavailable" ||
      mode === "no_writer_fence"
    )
      expect(
        f
          .state()
          .events.find((e) => e.type === "remote_orphan_cleanup_finished")
          ?.payload,
      ).toMatchObject({
        reason:
          mode === "backup_failure"
            ? "backup_failed"
            : mode === "no_writer_fence"
              ? "writer_fence_unavailable"
              : mode,
      });
    expect(
      f.state().events.some((e) => e.type === "remote_worker_exit_observed"),
    ).toBe(false);
    expect(f.state().human_actions).toHaveLength(0);
  } finally {
    await volume?.close();
    f.close();
  }
});
