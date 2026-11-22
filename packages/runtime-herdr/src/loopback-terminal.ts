import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { agentProcessCommand } from "./agent-ssh.js";
import { fail } from "./client.js";
import type { ExecutionConfig } from "./execution.js";

type Ssh = Extract<ExecutionConfig, { mode: "agent-ssh" }>;
export function managedLoopback(e: ExecutionConfig): e is Ssh {
  return (
    e.mode === "agent-ssh" &&
    e.target?.machine_id === "local" &&
    e.target.generation === "legacy" &&
    !e.macosCore &&
    (e.user ?? "agent") === "agent" &&
    ["localhost", "127.0.0.1", "::1"].includes(e.host ?? "localhost")
  );
}
/** Same shipped, read-only collector and isolated SSH account as diagnostics;
 * this private projection contains no terminal content or controller paths. */
export async function loopbackTerminal(
  execution: Ssh,
  binding: {
    project: string;
    assignment: string;
    launch_run: string;
    generation: string | null;
    terminal: string;
    session: string;
  },
) {
  try {
    const source = await readFile(
      new URL("../../../deploy/inspect-worker.py", import.meta.url),
      "utf8",
    );
    const cmd = await agentProcessCommand(
      execution,
      [
        "/usr/bin/python3",
        "-IB",
        "-c",
        source,
        JSON.stringify({
          ...binding,
          local: true,
          platform: "linux",
          root: execution.agentRoot,
          gid: execution.gid,
        }),
      ],
      { workerRuntimeDir: true },
    );
    const { stdout } = await promisify(execFile)(cmd.file, cmd.args, {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin" },
      timeout: 10000,
      killSignal: "SIGKILL",
      maxBuffer: 8192,
    });
    return JSON.parse(stdout);
  } catch {
    fail("runtime_unavailable", "Bound worker terminal could not be verified");
  }
}
