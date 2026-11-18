import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Runtime } from "@cardigan/domain";
import { HostOpsService } from "@cardigan/host";
import { executionPaths } from "@cardigan/runtime-herdr";
import { expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { InactiveRunReaper } from "./dispatch-inactive.js";

// A real private transcript and SQLite, but only a simulated runtime can be stopped.
test.each([
  "removed",
  "resumed",
  "during_status",
  "read_failed",
  "503",
  "silent",
] as const)("C-462: Claude %s after the cached 59:50 sample", async (mode) => {
  const f = dispatchFixture();
  const { assignment } = f.create();
  const run = f.session(assignment, false);
  const execution = { mode: "local" as const, dataDir: f.dataDir };
  const cwd = executionPaths(execution, f.project, assignment.id).runDir;
  const folder = join(cwd, "claude", "projects", "-fixture");
  const path = join(folder, "session-1.jsonl");
  const record = (timestamp: string, error = false) =>
    `${JSON.stringify({
      sessionId: "session-1",
      cwd,
      timestamp,
      ...(error
        ? { type: "system", subtype: "api_error", error: { status: 503 } }
        : { type: "assistant" }),
    })}\n`;
  let stopped = false;
  const release = vi.fn(async () => {
    stopped = true;
    return { ok: true, value: undefined };
  });
  const runtime = {
    release,
    status: async () => {
      if (mode === "during_status") await rm(path);
      return {
        ok: true,
        value: {
          process: stopped ? "exited" : "alive",
          agent: "idle",
          observed_seq: 1,
        },
      };
    },
  } as unknown as Runtime;
  const service = new HostOpsService({
    store: f.store,
    runtime,
    clock: f.clock,
    snapshot: async () => ({
      model: "fixture",
      agent_cli_version: "fixture",
    }),
    contextUsage: { execution },
  });
  try {
    f.store.uow.run((tx) => {
      const current = tx.runs.get(f.project, run.id);
      if (!current) throw new Error("Missing fixture Run");
      tx.runs.put(f.project, { ...current, harness: "claude-code" });
    });
    await mkdir(folder, { recursive: true });
    await writeFile(path, record(f.clock.now()));
    f.advance(59 * 60_000 + 50_000);
    const cache = await service.inspectHarnessActivity(f.project);
    expect(cache.get(assignment.id)?.status).toBe("stale");
    if (mode === "removed") await rm(path);
    f.advance(5_000);
    if (mode === "resumed" || mode === "503")
      await appendFile(
        path,
        record(mode === "503" ? "2030-01-01T00:59:00.000Z" : f.clock.now()),
      );
    f.advance(5_000);
    if (mode === "503") await appendFile(path, record(f.clock.now(), true));
    const inspect = vi.spyOn(service, "inspectHarnessActivity");
    if (mode === "read_failed")
      inspect.mockRejectedValueOnce(new Error("fixture read failure"));
    await new InactiveRunReaper({
      store: f.store,
      runtime,
      clock: f.clock,
      afterMs: 60 * 60_000,
      harnessActivity: (p, id) => service.harnessActivity(p, id),
      inspectHarnessActivity: (p, id) => service.inspectHarnessActivity(p, id),
      alert: () => {},
    }).tick([f.project]);
    expect(inspect.mock.calls).toEqual(
      Array(mode === "during_status" || mode === "silent" ? 2 : 1).fill([
        f.project,
        assignment.id,
      ]),
    );
    expect(release).toHaveBeenCalledTimes(mode === "silent" ? 1 : 0);
    const current = f.state().runs.find((r) => r.id === run.id);
    expect(current?.status).toBe(mode === "silent" ? "cancelled" : "running");
    expect(current?.inactivity_stop).toBeUndefined();
  } finally {
    await service.close();
    f.close();
  }
});
