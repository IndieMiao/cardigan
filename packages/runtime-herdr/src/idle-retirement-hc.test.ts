import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import { testHcBinary } from "../../../test-support/hc.js";
import { createTestRuntime } from "../../../test-support/paths.js";
import { corePid, stopCore } from "../test-support/hc-core.js";
import { HerdrRuntime } from "./index.js";
import { assignment, launch, machine, role, value } from "./test-support.js";

const binary = process.env.CARDIGAN_TEST_HC ?? join(homedir(), ".local/bin/hc");
const available = testHcBinary({ binary });
const exec = promisify(execFile);

// Employee runs honor the standard local hc skip. Trusted remote checks exercise
// the real core in an isolated socket/session, never the production service.
test.skipIf(!available || process.platform !== "linux").each([false, true])(
  "real hc retains files and confirms a gently retired terminal (cold system-turn adapter: %s)",
  async (cold) => {
    const dir = await mkdtemp(join(tmpdir(), "cg-idle-hc-"));
    const runtimeDir = createTestRuntime(join(dir, "runtime")),
      socketPath = join(runtimeDir, "hc.sock");
    const session = `idle-${randomUUID().slice(0, 8)}`;
    const env = {
      ...process.env,
      HC_SESSION: session,
      HC_SOCKET: socketPath,
      XDG_RUNTIME_DIR: runtimeDir,
      XDG_STATE_HOME: join(dir, "state"),
      XDG_CONFIG_HOME: join(dir, "config"),
    };
    try {
      await writeFile(join(dir, "dirty.txt"), "uncommitted fixture");
      const program = join(dir, "agent.cjs");
      await writeFile(
        program,
        String.raw`process.on('SIGHUP',()=>process.exit(0));process.on('SIGTERM',()=>process.exit(0));process.stdin.resume();process.stdin.on('data',()=>process.exit(0));process.stdout.write('\x1b]7501;state=idle:app=fixture\x1b\\');`,
      );
      const runtime = value(
        await HerdrRuntime.create({ binary, session, socketPath, env }),
      );
      const ref = value(
        await runtime.provision(assignment, role, machine, {
          ...launch,
          command: process.execPath,
          args: [program],
          cwd: dir,
        }),
      );
      const inspect = async () =>
        JSON.parse(
          (
            await exec(binary, ["get", ref.terminal_ref, "--json"], {
              env,
              timeout: 10000,
            })
          ).stdout,
        );
      await vi.waitFor(
        async () => expect((await inspect()).status?.state).toBe("idle"),
        { timeout: 10000 },
      );
      const consumer = cold
        ? value(await HerdrRuntime.create({ binary, session, socketPath, env }))
        : runtime;
      const { local_process_receipt: _receipt, ...current } = ref;
      const owner = { project_id: "fixture", assignment_id: assignment.id };
      const preflight = vi.fn(
        async () =>
          (await readFile(join(dir, "dirty.txt"), "utf8")) ===
          "uncommitted fixture",
      );
      if (cold)
        expect(
          value(
            await consumer.observe_retirement(current, {
              ...owner,
              system_finished_turn: true,
            }),
          ),
        ).toBe("alive");
      const result = await consumer.retire_idle(cold ? current : ref, {
        ...(cold
          ? {
              system_finished_turn: true as const,
              workspace_preflight: preflight,
            }
          : {}),
        project_id: "fixture",
        assignment_id: assignment.id,
        hangup_ms: 2000,
        terminate_ms: 2000,
        before_signal: () => true,
      });
      if (cold) {
        expect(preflight).toHaveBeenCalledOnce();
        expect(
          value(
            await consumer.observe_retirement(current, {
              ...owner,
              system_finished_turn: true,
            }),
          ),
        ).toBe("exited");
      }
      // A system-ended stop also asks the kernel whether the probed leader
      // and its whole group are gone; plain idle retirement does not.
      // C-626: the system-turn stop also reports its owner-bound TERM.
      expect(result).toEqual({
        ok: true,
        value: cold
          ? {
              outcome: "exited",
              process_group_exited: true,
              stop: {
                path: "linux_pidfd",
                signal: "TERM",
                pid: expect.any(Number),
              },
            }
          : { outcome: "exited" },
      });
      expect((await inspect()).state).toBe("finished");
      expect(await readFile(join(dir, "dirty.txt"), "utf8")).toBe(
        "uncommitted fixture",
      );
    } finally {
      await stopCore({
        session,
        socket: socketPath,
        env,
        pid: corePid({ session, socket: socketPath, env }),
      });
      await rm(dir, { recursive: true, force: true });
    }
  },
  30000,
);
