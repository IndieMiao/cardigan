import { expect, test, vi } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { Dispatcher } from "./dispatch.js";

test.each(["idle", "working", "unverified", "check_failed"] as const)(
  "PATH-only change: %s",
  async (mode) => {
    const f = recoveryFixture("worker-a");
    try {
      const fingerprint = "d".repeat(64);
      const observe = vi.fn(async () => ({
        ok: true as const,
        value:
          mode === "unverified" ? ("unknown" as const) : ("alive" as const),
      }));
      const runtime = {
        ...f.runtime,
        changedSessionEnvironment: () => fingerprint,
        canAdmitSession: async () => mode !== "check_failed",
        observe_retirement: observe,
      };
      if (mode === "working")
        f.working.add(f.refFor(f.target.assignment).terminal_ref);
      const previous = f.latest();
      f.comment();
      await new Dispatcher({ ...f.options, runtime }).tick();
      expect(runtime.release).not.toHaveBeenCalled();
      expect(f.options.startRun).not.toHaveBeenCalled();
      if (mode === "idle") {
        const run = f.latest();
        expect(run.id).not.toBe(previous.id);
        expect(run.session_environment_binding).toBe(fingerprint);
        expect(runtime.wake).toHaveBeenCalledWith(
          f.refFor(f.target.assignment),
          expect.anything(),
          expect.objectContaining({
            if_idle: true,
            session_run: {
              assignment_id: f.target.assignment.id,
              run_id: run.id,
            },
          }),
        );
        expect(
          f.state().timeline.filter((t) => t.body.includes("本会话仍用旧环境")),
        ).toHaveLength(1);
      } else {
        expect(runtime.wake).not.toHaveBeenCalled();
        expect(f.latest().id).toBe(previous.id);
        expect(f.notes().some((n) => n.status === "pending")).toBe(true);
      }
    } finally {
      f.close();
    }
  },
);
