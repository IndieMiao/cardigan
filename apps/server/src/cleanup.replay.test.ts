/** C-233: bounded synthetic cleanup replay; no runtime delay or CPU load. */
import { performance } from "node:perf_hooks";
import type { AssignmentId, Runtime } from "@cardigan/domain";
import { releaseAssignment } from "@cardigan/domain";
import { expect, test } from "vitest";
import { CleanupExecutor } from "./cleanup-loop.js";
import { ServerGit } from "./git.js";
import { m4Fixture, m4Scenario } from "./m4-fixtures.js";
import { setTickProfiler, TickProfiler } from "./tick-profile.js";

test.skipIf(process.env.CARDIGAN_CLEANUP_REPLAY !== "1")(
  "replay 657 released Assignments across three cleanup sweeps",
  async () => {
    const f = m4Fixture();
    const s = m4Scenario(f);
    f.startRun(s.coder);
    f.endRun(s.coder);
    const released = f.apply((state, actor, ports) =>
      releaseAssignment(state, actor, { assignment_id: s.coder.id }, ports),
    );
    const ref = released.runtime_ref;
    if (!ref) throw new Error("missing fixture terminal");
    const profiler = new TickProfiler({
      reportIntervalMs: 0,
      log: (line) => console.log(JSON.stringify(line)),
    });
    let statusCalls = 0;
    try {
      f.store.uow.run((tx) => {
        for (let i = 0; i < 656; i++) {
          const id = `A-${1000 + i}` as AssignmentId;
          tx.assignments.put(f.project_id, {
            ...released,
            id,
            runtime_ref: { ...ref, terminal_ref: `t-${id}` },
          });
        }
        for (const a of tx.assignments.list(f.project_id)) {
          if (a.status !== "released") continue;
          for (let t = 0; t < 3; t++) {
            const issued = tx.issueToken({
              project_id: f.project_id,
              assignment_id: a.id,
              role: { role_version: 1, allowed_tools: [] },
            });
            tx.revokeToken(issued.record.id);
          }
        }
      });
      const executor = new CleanupExecutor({
        store: f.store,
        git: new ServerGit({ store: f.store, dataDir: f.dataDir }),
        runtime: {
          status: async () => {
            statusCalls++;
            return {
              ok: false,
              error: { code: "runtime_not_found", message: "gone" },
            };
          },
        } as Runtime,
      });
      setTickProfiler(profiler);
      f.store.observe(profiler.storeObserver);
      for (let sweep = 1; sweep <= 3; sweep++) {
        statusCalls = 0;
        const start = performance.now();
        await profiler.tick("cleanup", () => executor.tick());
        console.log(
          JSON.stringify({
            sweep,
            statusCalls,
            wall_ms: performance.now() - start,
          }),
        );
      }
      expect(
        f.state().assignments.filter((a) => a.status === "released"),
      ).toHaveLength(657);
    } finally {
      setTickProfiler(undefined);
      profiler.stop();
      f.close();
    }
  },
);
