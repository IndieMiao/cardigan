import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeRef } from "@cardigan/domain";
import { expect, vi } from "vitest";
import * as ssh from "../../../packages/runtime-herdr/src/agent-ssh.js";
import {
  HC_RELEASE,
  HerdrRuntime,
} from "../../../packages/runtime-herdr/src/index.js";

/** Actual adapter and pidfd command sequence; replace both worker transports
 * with bounded fixture responses. No hc socket, SSH connection or real signal. */
export async function loopbackFixture(
  dir: string,
  ref: RuntimeRef,
  assignment: string,
) {
  const target = ref.target!,
    gen = ref.launch_generation!;
  const machine = ref.runtime_machine;
  const endpoint = join(dir, "fixture-identity"),
    knownHostsFile = join(dir, "fixture-hosts");
  for (const file of [endpoint, knownHostsFile])
    writeFileSync(file, "fixture only", { mode: 0o600 });
  let sample = "conflict",
    exited = false;
  const signals: string[] = [];
  vi.spyOn(ssh, "agentProcessCommand").mockImplementation(
    async (_, args, options) => {
      expect(options).toEqual({ workerRuntimeDir: true });
      const c = JSON.parse(args.at(-1)!);
      expect(c).toMatchObject({
        project: target.project_id,
        assignment,
        launch_run: gen.run_id,
        generation: gen.generation,
        terminal: "t2",
        session: target.session,
        local: true,
      });
      const t = {
        address: "t2",
        state: exited ? "finished" : "live",
        keep: false,
        created_ms: 1234,
        ...(sample !== "incomplete" ? { pid: 12345 } : {}),
        status: { state: sample === "busy" ? "working" : "unknown" },
        labels: {
          cardigan: "1",
          project: target.project_id,
          assignment: sample === "conflict" ? "other" : assignment,
          run: gen.run_id,
          generation: gen.generation,
        },
      };
      return {
        file: process.execPath,
        args: [
          "-e",
          "process.stdout.write(process.argv[1])",
          JSON.stringify(t),
        ],
      };
    },
  );
  const result = await HerdrRuntime.create({
    session: target.session,
    execution: {
      mode: "agent-ssh",
      target,
      machine,
      dataDir: dir,
      agentRoot: join(dir, "agent"),
      gid: 2001,
      identityFile: endpoint,
      knownHostsFile,
    },
    client: {
      available: async () => true,
      async *lines() {},
      exec: async (args) => {
        if (args[0] === "--version") return `hc ${HC_RELEASE.version}`;
        if (args[0] === "machine")
          return JSON.stringify(
            args[1] === "ls"
              ? { machines: [] }
              : { version: HC_RELEASE.version },
          );
        expect(args.slice(0, 4)).toEqual(["exec", "--on", machine, "--"]);
        const mode = args[args.indexOf("-c") + 2];
        if (mode === "probe")
          return JSON.stringify({
            pid: 12345,
            start: "1",
            boot: "fixture",
            uid: 1001,
          });
        expect(mode).toBe("TERM");
        signals.push(mode);
        exited = true;
        return "";
      },
    },
  });
  if (!result.ok) throw new Error(result.error.message);
  return {
    runtime: result.value,
    signals,
    sample: (v: string) => {
      sample = v;
    },
  };
}
