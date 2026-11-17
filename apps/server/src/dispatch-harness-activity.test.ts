import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Runtime } from "@cardigan/domain";
import { HostOpsService, UpstreamHealthMonitor } from "@cardigan/host";
import { parseLaunchConfig } from "@cardigan/roles";
import { executionPaths } from "@cardigan/runtime-herdr";
import { expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher } from "./dispatch.js";

const snapshot = async () => ({
  model: "fixture",
  agent_cli_version: "fixture",
});
test.each([
  "progress",
  "silent",
  "missing",
  "rate_limit",
  "stream_disconnected",
] as const)(
  "C-297: synthetic %s rollouts drive dispatcher and upstream classification together",
  async (mode) => {
    const f = dispatchFixture();
    const runtime = {
      status: vi.fn(async () => ({
        ok: true,
        value: { process: "alive", agent: "idle", observed_seq: 1 },
      })),
      release: vi.fn(),
      wake: vi.fn(),
    } as unknown as Runtime;
    const targets = [f.create(), f.create(), f.create()];
    for (const target of targets) f.session(target.assignment, false);
    const config = parseLaunchConfig({
      providers: { relay: { harness: "codex", upstream: { group: "relay" } } },
      profiles: { fixture: { harness: "codex", provider: "relay" } },
    });
    f.store.uow.run((tx) => {
      for (const run of tx.runs.list(f.project))
        tx.runs.put(f.project, {
          ...run,
          harness: "codex",
          launch_profile_ref: "fixture",
        });
    });
    const initial = f.clock.now();
    f.advance(16 * 60_000);
    const execution = { mode: "local" as const, dataDir: f.dataDir };
    const monitor = new UpstreamHealthMonitor(config, runtime, f.clock);
    const service = new HostOpsService({
      store: f.store,
      runtime,
      snapshot,
      clock: f.clock,
      contextUsage: { execution },
      upstreamMonitor: monitor,
    });
    const reconciled = vi.spyOn(monitor, "reconcile");
    const inspected = vi.spyOn(service, "inspectHarnessActivity");
    let dispatcher: Dispatcher | undefined;
    try {
      if (mode !== "missing")
        for (const target of targets) {
          const dir = executionPaths(
            execution,
            f.project,
            target.assignment.id,
          ).runDir;
          const folder = join(dir, "codex", "sessions");
          await mkdir(folder, { recursive: true });
          const a = f
            .state()
            .assignments.find((a) => a.id === target.assignment.id);
          const error = mode === "rate_limit" || mode === "stream_disconnected";
          await writeFile(
            join(folder, "rollout-2030-01-01.jsonl"),
            [
              {
                type: "session_meta",
                payload: {
                  id:
                    a?.runtime_ref?.agent_session_id ??
                    a?.session_ref ??
                    "fixture-session",
                  cwd: a?.worktree_path ?? a?.runtime_ref?.worktree_path ?? dir,
                },
              },
              {
                type: "event_msg",
                timestamp: mode === "silent" ? initial : f.clock.now(),
                payload: error
                  ? {
                      type: "error",
                      codex_error_info:
                        mode === "rate_limit"
                          ? "usage_limit_exceeded"
                          : "stream_disconnected",
                      message: "SECRET-ERROR",
                    }
                  : { type: "token_count", info: null },
              },
            ]
              .map((v) => JSON.stringify(v))
              .join("\n"),
          );
        }
      dispatcher = new Dispatcher({
        store: f.store,
        runtime,
        snapshot,
        clock: f.clock,
        inactiveCancelAfterMs: null,
        inspectHarnessActivity: (project) =>
          service.inspectHarnessActivity(project),
        harnessActivity: (project, assignment) =>
          service.harnessActivity(project, assignment),
      });
      await dispatcher.tick();
      await vi.waitFor(() =>
        expect(inspected.mock.settledResults[0]?.type).toBe("fulfilled"),
      );
      await service.tick();
      await vi.waitFor(() => expect(reconciled).toHaveBeenCalledTimes(1));
      const events = f.state().events;
      expect(events.filter((e) => e.type === "run_inactive")).toHaveLength(
        mode === "progress" ? 0 : 3,
      );
      expect(
        events.filter((e) => e.type === "upstream_incident_started"),
      ).toHaveLength(mode === "progress" ? 0 : 1);
      expect(runtime.release).not.toHaveBeenCalled();
      expect(JSON.stringify(events)).not.toContain("SECRET-ERROR");
    } finally {
      dispatcher?.close();
      await service.close();
      f.close();
    }
  },
);
