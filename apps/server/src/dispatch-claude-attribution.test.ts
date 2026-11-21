import { appendFile, mkdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import type { Runtime } from "@cardigan/domain";
import { HostOpsService } from "@cardigan/host";
import {
  type ExecutionConfig,
  executionPaths,
  workerLaunchPath,
  workerSessionPath,
} from "@cardigan/runtime-herdr";
import { expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher } from "./dispatch.js";

// Replace the SSH hop only. The worker still uses its generation directory,
// real Python no-follow opener, fd handoff and activity-only Node parser.
vi.mock("@cardigan/runtime-herdr", async (original) => ({
  ...(await original<typeof import("@cardigan/runtime-herdr")>()),
  agentProcessCommand: async (
    _execution: ExecutionConfig,
    [file, ...args]: string[],
  ) => ({ file, args }),
}));
const cases = [
  "A",
  "AB",
  "BA",
  "cross-output",
  "outside-pending",
  "outside-only",
] as const;
for (const machine of ["local", "worker"]) {
  test.each(cases)(
    `C-541: ${machine} attributes progress and the stalled command before selection (%s)`,
    async (mode) => {
      const f = dispatchFixture(machine);
      const { assignment } = f.create();
      const run = f.session(assignment, false);
      const ref = f.refFor(assignment);
      const generation = "b".repeat(32);
      const local = { mode: "local" as const, dataDir: f.dataDir };
      const worker = ref.target && {
        mode: "agent-ssh" as const,
        machine,
        agentRoot: join(f.dataDir, "worker"),
        dataDir: f.dataDir,
        gid: 1234,
        identityFile: "/unused/id",
        knownHostsFile: "/unused/known",
        fileHelper: { python: "python3", path: "/unused/helper" },
        target: ref.target,
      };
      const identity = worker && {
        project: f.project,
        assignment: assignment.id,
        run: run.id,
        generation,
        target: worker.target.fingerprint,
      };
      const root =
        worker && identity
          ? workerSessionPath(worker, identity)
          : executionPaths(local, f.project, assignment.id).runDir;
      const same = mode === "A" || mode === "AB" || mode === "BA";
      const worktree = join(f.dataDir, "worktrees", assignment.id);
      const launch =
        worker && identity ? workerLaunchPath(worker, identity).value : root;
      const cwd = same ? launch : join(worktree, "apps", "web"),
        outside = `${worktree}0/apps/web`;
      f.store.uow.run((tx) => {
        const [a] = tx.assignments.list(f.project);
        if (!a?.runtime_ref) throw new Error("Missing fixture session");
        tx.assignments.put(f.project, {
          ...a,
          ...(!same ? { worktree_path: worktree } : {}),
          runtime_ref: {
            ...a.runtime_ref,
            ...(worker
              ? { launch_generation: { run_id: run.id, generation } }
              : {}),
          },
        });
        const [r] = tx.runs.list(f.project);
        if (!r) throw new Error("Missing fixture Run");
        tx.runs.put(f.project, { ...r, harness: "claude-code" });
      });
      const runtime = {
        status: async () => ({
          ok: true,
          value: { process: "alive", agent: "idle" },
        }),
        // No transcript or usable terminal evidence in the outside-only control.
        ...(mode !== "outside-only"
          ? {
              terminalActivity: async () => ({
                ok: true,
                value: { digest: "unchanged" },
              }),
            }
          : {}),
        executionForRef: () => worker,
      } as unknown as Runtime;
      const options = {
        store: f.store,
        runtime,
        snapshot: async () => ({
          model: "fixture",
          agent_cli_version: "fixture",
        }),
        clock: f.clock,
      };
      const service = new HostOpsService({
        ...options,
        contextUsage: { execution: local },
      });
      const inspect = vi.fn(service.inspectHarnessActivity.bind(service));
      const dispatcher = new Dispatcher({
        ...options,
        inspectHarnessActivity: inspect,
        inactiveCancelAfterMs: null,
      });
      const folder = join(root, "claude", "projects", "-fixture"),
        file = join(folder, "session.jsonl");
      const append = async (dir: string, event: object) => {
        const timestamp = f.clock.now();
        await appendFile(
          file,
          `${JSON.stringify({ cwd: dir, sessionId: "session", timestamp, ...event })}\n`,
        );
        await utimes(file, new Date(timestamp), new Date(timestamp));
      };
      const start = (dir: string, ids: string) =>
        append(dir, {
          type: "assistant",
          message: {
            content: Array.from(ids, (id) => ({
              type: "tool_use",
              id,
              name: "Bash",
              input: { command: id === "A" ? "node web.mjs" : "vite" },
            })),
          },
        });
      const end = (dir: string, id: string) =>
        append(dir, {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: id }] },
        });
      const started = f.clock.now();
      const output = (dir: string, id: string, count: number) =>
        append(dir, {
          type: "progress",
          parentToolUseID: id,
          data: {
            type: "bash_progress",
            totalLines: count,
            elapsedTimeSeconds:
              (Date.parse(f.clock.now()) - Date.parse(started)) / 1000,
            totalBytes: count * "PRIVATE\n".length,
            fullOutput: "PRIVATE\n".repeat(count),
          },
        });
      const named = same || mode === "cross-output";
      try {
        await mkdir(folder, { recursive: true });

        if (same) {
          await start(cwd, mode);
          if (mode.includes("B")) await end(cwd, "B");
        } else {
          await start(outside, "B");
          if (mode !== "outside-only") await start(cwd, "A");
          if (mode === "outside-pending") await end(cwd, "A");
        }
        let lastA = started;
        for (let i = 0; i < (named ? 3 : 2); i++) {
          const at = Date.parse(started) + (i + 1) * 16 * 60_000;
          f.advance(at - Date.parse(f.clock.now()));
          if (named) {
            await output(cwd, "A", Math.min(i + 1, 2));
            if (i < 2) lastA = f.clock.now();
          }
          if (mode === "cross-output") {
            f.advance(1_000);
            await output(outside, "B", i + 1);
            // Even a later *protocol* record outside A must not suppress A's
            // retained time or let A claim the last physical write in the file.
            if (i === 1) await append(outside, { type: "assistant" });
          }
          await dispatcher.tick();
          await vi.waitFor(
            () =>
              expect(inspect.mock.settledResults[i]?.type).toBe("fulfilled"),
            { timeout: 5000 },
          );
          const row = (await inspect.mock.results[i]?.value)?.get(
            assignment.id,
          );
          const events = f.state().events;
          const alerts = events
            .filter((e) => e.type === "run_inactive")
            .map((e) => e.payload);
          if (named) {
            expect(row?.foreground).toEqual({
              command: "node web.mjs",
              since: started,
            });
            expect(row?.fileActivity?.updated_at).toBe(lastA);
            if (i < 2) expect(alerts).toHaveLength(0);
            else
              expect(alerts).toMatchObject([
                {
                  reason:
                    "前台命令 node web.mjs 已运行至少 48 分钟，无近期输出",
                },
              ]);
          } else {
            expect(row?.foreground).toBeUndefined();
            expect(JSON.stringify(alerts)).not.toContain("vite");
            if (mode === "outside-pending" && i === 1)
              expect(alerts).toMatchObject([{ reason: "mcp_inactivity" }]);
            else expect(alerts).toHaveLength(0);
            if (mode === "outside-only") {
              expect(row?.activity).toBeUndefined();
              expect(row?.fileActivity).toBeUndefined();
              expect(
                events.filter(
                  (e) =>
                    e.type ===
                    `run_${machine === "local" ? "local" : "remote"}_activity_missing`,
                ),
              ).toHaveLength(1);
            }
          }
          expect(JSON.stringify([row, alerts])).not.toContain("PRIVATE");
        }
      } finally {
        dispatcher.close();
        await service.close();
        f.close();
      }
    },
  );
}
