import {
  queueRun,
  stoppedByHuman,
  stopWorkItemAssignment,
} from "@cardigan/domain";
import { launchRun, RunWakeWithdrawn } from "@cardigan/host";
import { parseLaunchConfig } from "@cardigan/roles";
import { type HcClient, HerdrRuntime } from "@cardigan/runtime-herdr";
import { listBellAttempts, unfinishedBellAttempts } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { Dispatcher } from "./dispatch.js";

// Exercise all callers with the real adapter/queue and controllable hc IO.
for (const entry of ["initial", "retry", "host reuse"] as const) {
  test.each([
    "unchanged",
    "human stop",
    "runtime generation",
    "session generation",
    "unknown run",
    "completion",
  ] as const)(
    `${entry}: hc dequeue rechecks %s and preserves unsent intent accounting`,
    async (change) => {
      const f = recoveryFixture();
      let release = () => {};
      const occupied = new Promise<void>((resolve) => {
        release = resolve;
      });
      const actualSend = vi.fn();
      const client: HcClient = {
        available: async () => true,
        async *lines() {},
        async exec(args) {
          if (args[0] === "--version") return "hc 0.1.18";
          if (args[0] === "send") {
            if (args.at(-1)?.startsWith("occupy-")) await occupied;
            else actualSend();
          }
          return "{}";
        },
      };
      const created = await HerdrRuntime.create({
        client,
        execution: { mode: "local", dataDir: f.dataDir },
        session: "queued-wake",
        socketPath: `${f.dataDir}/fake.sock`,
        env: {
          CARDIGAN_HC_CONCURRENCY: "4",
          CARDIGAN_HC_QUEUE_WAIT_MS: "30000",
        },
      });
      if (!created.ok) throw new Error(created.error.message);
      const adapter = created.value;
      f.runtime.wake = vi.fn((...args) => adapter.wake(...args));
      if (entry !== "host reuse") f.comment();
      if (entry === "retry") {
        await new Dispatcher({
          ...f.options,
          beforeWake: async () => {
            throw new Error("fixture first failure");
          },
        }).tick();
        expect(f.runtime.wake).not.toHaveBeenCalled();
        f.advance(30000);
      }
      const holders = Array.from({ length: 4 }, (_, i) =>
        adapter.wake(f.refFor(f.target.assignment), `occupy-${i}`),
      );
      let sending: Promise<unknown> | undefined;
      try {
        await expect.poll(() => adapter.diagnostics().active).toBe(4);
        if (entry === "host reuse") {
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
          sending = launchRun(
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
              prepare_worktree: async () => undefined,
            },
          ).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
        } else
          sending = new Dispatcher(f.options)
            .tick()
            .then((value) => ({ value }));
        await expect.poll(() => adapter.diagnostics().queued).toBe(1);
        expect(f.runtime.wake).toHaveBeenCalledOnce();
        expect(actualSend).not.toHaveBeenCalled();
        const notes = f.notes();
        const outcomes = listBellAttempts(f.store.database, f.project).filter(
          (a) => a.finished_at !== null,
        );
        if (change === "human stop") {
          f.apply((state, actor, ports) =>
            stopWorkItemAssignment(
              state,
              actor,
              {
                assignment_id: f.target.assignment.id,
                reason: "stop before hc dequeue",
              },
              ports,
            ),
          );
          expect(stoppedByHuman(f.state().events, f.target.assignment.id)).toBe(
            true,
          );
        } else if (
          change === "runtime generation" ||
          change === "session generation"
        ) {
          f.store.uow.run((tx) => {
            const owner = tx.assignments.get(f.project, f.target.assignment.id);
            if (!owner?.runtime_ref) throw new Error("Missing fixture owner");
            tx.assignments.put(f.project, {
              ...owner,
              ...(change === "runtime generation"
                ? {
                    runtime_ref: {
                      ...owner.runtime_ref,
                      agent_session_id: "replacement",
                    },
                  }
                : { session_ref: "replacement" }),
            });
          });
        } else if (change === "unknown run" || change === "completion") {
          const current = f.latest();
          f.store.uow.run((tx) =>
            tx.runs.put(f.project, {
              ...current,
              status: change === "completion" ? "completed" : "unknown",
            }),
          );
        }
        const run = f.latest();
        release();
        await Promise.all(holders);
        const outcome = await sending;
        expect(unfinishedBellAttempts(f.store.database, f.project)).toEqual([]);
        expect(f.latest()).toEqual(run);
        if (change === "unchanged") {
          expect(outcome).not.toHaveProperty("error");
          expect(actualSend).toHaveBeenCalledOnce();
          expect(
            listBellAttempts(f.store.database, f.project).at(-1)?.outcome,
          ).toBe("sent");
          await new Dispatcher(f.options).tick();
          expect(actualSend).toHaveBeenCalledOnce();
        } else {
          if (entry === "host reuse")
            expect(outcome).toMatchObject({
              error: expect.any(RunWakeWithdrawn),
            });
          expect(actualSend).not.toHaveBeenCalled();
          expect(listBellAttempts(f.store.database, f.project)).toEqual(
            outcomes,
          );
          // The router resolves failed notices for completed Runs; it must
          // still preserve their attempts and never report a successful send.
          expect(f.notes()).toEqual(
            entry === "retry" && change === "completion"
              ? notes.map((note) => ({
                  ...note,
                  status: "resolved",
                  updated_at: f.clock.now(),
                }))
              : notes,
          );
        }
      } finally {
        release();
        await Promise.allSettled(holders);
        await sending;
        f.close();
      }
    },
  );
}
