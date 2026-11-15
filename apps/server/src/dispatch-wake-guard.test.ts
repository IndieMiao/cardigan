import { queueRun, stopWorkItemAssignment } from "@cardigan/domain";
import { launchRun, RunWakeWithdrawn } from "@cardigan/host";
import { parseLaunchConfig } from "@cardigan/roles";
import { listBellAttempts, unfinishedBellAttempts } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { Dispatcher } from "./dispatch.js";

type Entry = "initial" | "retry" | "host reuse";
const entries: Entry[] = ["initial", "retry", "host reuse"];
function gate() {
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
}

async function fixture(entry: Entry) {
  const f = recoveryFixture();
  const entered = gate(),
    ready = gate();
  let failPreparation = false;
  const prepare = vi.fn(async () => {
    entered.release();
    await ready.pending;
    if (failPreparation)
      throw new Error("fixture preparation failure after stop");
    return undefined;
  });
  if (entry !== "host reuse") f.comment();
  if (entry === "retry") {
    await new Dispatcher({
      ...f.options,
      beforeWake: async () => {
        throw new Error("fixture first preparation failure");
      },
    }).tick();
    expect(f.runtime.wake).not.toHaveBeenCalled();
    f.advance(30000);
  }
  const start = () => {
    if (entry !== "host reuse")
      return new Dispatcher({ ...f.options, beforeWake: prepare }).tick();
    f.store.issueToken({
      project_id: f.project,
      assignment_id: f.target.assignment.id,
      role: { role_version: 1, allowed_tools: ["whoami"] },
    });
    const run = f.apply((state, actor, ports) =>
      queueRun(
        state,
        actor,
        {
          assignment_id: f.target.assignment.id,
          model: "fixture",
          agent_cli_version: "fixture",
        },
        ports,
      ),
    );
    return launchRun(
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
        reuse_session: true,
        prepare_worktree: prepare,
      },
    );
  };
  const stop = async (released = false) => {
    f.apply((state, actor, ports) =>
      stopWorkItemAssignment(
        state,
        actor,
        {
          assignment_id: f.target.assignment.id,
          reason: "stop during awaited IO",
        },
        ports,
      ),
    );
    if (released) {
      const ref = f.refFor(f.target.assignment);
      expect(await f.runtime.release(ref, { force: true })).toMatchObject({
        ok: true,
      });
      f.apply((state, actor, ports) =>
        stopWorkItemAssignment(
          state,
          actor,
          {
            assignment_id: f.target.assignment.id,
            reason: "exit confirmed",
            released_runtime_ref: ref,
          },
          ports,
        ),
      );
    }
  };
  return {
    ...f,
    entered,
    ready,
    prepare,
    start,
    stop,
    failPreparation: () => {
      failPreparation = true;
    },
  };
}

for (const entry of entries) {
  test.each([
    "unchanged",
    "stop",
    "released",
    "generation",
    "session generation",
    "unknown run",
    "host operation",
    "stop then failure",
  ] as const)(
    `${entry}: preparation completion rechecks %s before any actual wake`,
    async (change) => {
      const f = await fixture(entry);
      const sending = f.start().then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await f.entered.pending;
        const run = f.latest();
        expect(run.status).toBe("dispatched");
        expect(f.runtime.wake).not.toHaveBeenCalled();
        const outcomes = listBellAttempts(f.store.database, f.project).filter(
          (attempt) => attempt.finished_at !== null,
        );
        const notes = f.notes();
        if (["stop", "released", "stop then failure"].includes(change)) {
          await f.stop(change === "released");
          if (change === "stop then failure") f.failPreparation();
        } else if (change === "generation") {
          // The terminal address is unchanged; only the session generation moves.
          f.store.uow.run((tx) => {
            const owner = tx.assignments.get(f.project, f.target.assignment.id);
            if (!owner?.runtime_ref) throw new Error("Missing live fixture");
            tx.assignments.put(f.project, {
              ...owner,
              runtime_ref: {
                ...owner.runtime_ref,
                agent_session_id: "generation-2",
              },
            });
          });
        } else if (change === "session generation") {
          f.store.uow.run((tx) => {
            const owner = tx.assignments.get(f.project, f.target.assignment.id);
            if (!owner) throw new Error("Missing fixture owner");
            tx.assignments.put(f.project, {
              ...owner,
              session_ref: "generation-2",
            });
          });
        } else if (change === "unknown run") {
          // A monitor observation during awaited preparation is not proof of ACK.
          f.store.uow.run((tx) =>
            tx.runs.put(f.project, { ...run, status: "unknown" }),
          );
        } else if (change === "host operation") {
          // Seed the trusted host's persisted stop intent, without executing IO.
          f.store.uow.run((tx) =>
            tx.events.append(f.project, {
              id: tx.ids.nextEventId(),
              card_id: f.target.card.id,
              seq: tx.ids.nextEventSequence(f.project, f.target.card.id),
              type: "host_ops_action_taken",
              actor: { kind: "system", project_id: f.project },
              created_at: f.clock.now(),
              payload: {
                execution: true,
                tool: "host_ops_cancel_run",
                target_id: run.id,
                run_id: run.id,
                assignment_id: f.target.assignment.id,
                runtime_ref: f.refFor(f.target.assignment),
                reason: "fixture stop",
              },
            }),
          );
        }
        const runs = f.state().runs;
        f.ready.release();
        const result = await sending;
        expect(unfinishedBellAttempts(f.store.database, f.project)).toEqual([]);
        expect(f.latest().id).toBe(run.id);
        if (change === "unchanged") {
          expect(result).not.toHaveProperty("error");
          expect(f.runtime.wake).toHaveBeenCalledOnce();
          expect(
            listBellAttempts(f.store.database, f.project).at(-1),
          ).toMatchObject({
            run_id: run.id,
            outcome: "sent",
          });
          await new Dispatcher(f.options).tick();
          expect(f.runtime.wake).toHaveBeenCalledOnce();
        } else {
          if (entry === "host reuse")
            expect(result).toMatchObject({
              error: expect.any(RunWakeWithdrawn),
            });
          else expect(result).not.toHaveProperty("error");
          expect(f.runtime.wake).not.toHaveBeenCalled();
          expect(listBellAttempts(f.store.database, f.project)).toEqual(
            outcomes,
          );
          // The existing router resolves obsolete failed notices once their
          // Run is cancelled; it must not record a send or increment attempts.
          expect(f.notes()).toEqual(
            entry === "retry" && change === "released"
              ? notes.map((note) => ({
                  ...note,
                  status: "resolved",
                  updated_at: f.clock.now(),
                }))
              : notes,
          );
          expect(f.state().runs).toEqual(runs);
        }
      } finally {
        f.ready.release();
        await sending;
        f.close();
      }
    },
  );

  test(`${entry}: a response after confirmed cancellation cannot revive the Run`, async () => {
    const f = await fixture(entry);
    const entered = gate(),
      response = gate();
    vi.mocked(f.runtime.wake).mockImplementation(async () => {
      entered.release();
      await response.pending;
      return { ok: true, value: { sent: true } };
    });
    f.ready.release();
    const sending = f.start();
    try {
      await entered.pending;
      await f.stop(true);
      const cancelled = f.latest();
      expect(cancelled.status).toBe("cancelled");
      response.release();
      await sending;
      await new Dispatcher(f.options).tick();
      expect(f.latest()).toEqual(cancelled);
      expect(f.runtime.wake).toHaveBeenCalledOnce();
      expect(f.options.startRun).not.toHaveBeenCalled();
    } finally {
      response.release();
      await sending;
      f.close();
    }
  });
}
