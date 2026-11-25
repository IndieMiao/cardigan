import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { promisify } from "node:util";
import type { RetirementIdentity, RuntimeRef } from "@cardigan/domain";
import { agentProcessCommand } from "./agent-ssh.js";
import type { ExecutionConfig } from "./execution.js";
import { workerTerminalProbe } from "./loopback-terminal.js";

type Ssh = Extract<ExecutionConfig, { mode: "agent-ssh" }>;
type Owner = RetirementIdentity & {
  readonly system_finished_turn?: true;
  /** C-626: only after the controller read the bound empty editor. */
  readonly unknown_activity?: true;
  /** C-667: ask the worker to name an idle replacement shell of a kept terminal. */
  readonly kept_shell?: true;
  /** C-672: ask the worker to name a plain live terminal whose CLI is gone. */
  readonly agent_exit?: true;
};

/** The pinned worker binding; undefined when any part is missing or foreign. */
function binding(execution: Ssh, ref: RuntimeRef, owner: Owner) {
  const launch = ref.launch_generation,
    p = owner.enrolled_process,
    target = execution.target;
  if (
    !execution.fileHelper ||
    !execution.user ||
    !target ||
    !launch ||
    !p ||
    p.terminal !== launch.generation ||
    p.machine !== target.fingerprint ||
    !ref.terminal_ref.startsWith(`${execution.machine}/`)
  )
    return;
  return {
    platform: "darwin",
    user: execution.user,
    gid: execution.gid,
    session: target.session,
    target: target.fingerprint,
    project: owner.project_id,
    assignment: owner.assignment_id,
    launch_run: launch.run_id,
    generation: launch.generation,
    terminal: ref.terminal_ref.slice(execution.machine.length + 1),
    agent_name: ref.agent_name,
    process: p,
    require_idle: owner.system_finished_turn === true,
    ...(owner.system_finished_turn && owner.unknown_activity
      ? { unknown_activity: true }
      : {}),
    ...(owner.kept_shell ? { kept_shell: true } : {}),
    ...(owner.agent_exit ? { agent_exit: true } : {}),
    primitive: posix.join(
      posix.dirname(execution.fileHelper.path),
      "worker-primitives.py",
    ),
  };
}

/** Only these bounded facts can cross the trusted worker boundary. */
export async function darwinRetirementObservation(
  execution: Ssh,
  ref: RuntimeRef,
  owner: Owner,
  probe = workerTerminalProbe,
): Promise<"alive" | "exited" | "kept" | "shell" | "agent_exited" | "unknown"> {
  const bound = binding(execution, ref, owner);
  if (!bound) return "unknown";
  const observed: unknown = await probe(execution, bound);
  if (observed === "shell") return owner.kept_shell ? "shell" : "kept";
  if (observed === "agent_exited")
    return owner.agent_exit ? "agent_exited" : "unknown";
  return observed === "exited" || observed === "alive" || observed === "kept"
    ? observed
    : "unknown";
}

export type DarwinTurnStop =
  | { readonly sent: true; readonly pid: number }
  /** Nothing was signalled: refused by the worker proof or a host guard. */
  | { readonly sent: false; readonly reason: "refused" | "guard_changed" }
  /** The command may have run; only a later exit observation settles it. */
  | { readonly sent: "unknown" };

async function run(file: string, args: readonly string[]) {
  const { stdout } = await promisify(execFile)(file, [...args], {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin" },
    timeout: 15000,
    killSignal: "SIGKILL",
    maxBuffer: 8192,
  });
  return stdout;
}

/**
 * C-626 PID fallback for a system-ended turn whose idle owner cannot be asked.
 * The worker repeats the bound read-only proof and the enrolled receipt's
 * native identity, then sends one TERM to that CLI only. `before_signal` is
 * the host's last synchronous guard, immediately before the worker command.
 */
export async function stopDarwinTurn(
  execution: Ssh,
  ref: RuntimeRef,
  owner: Owner & { readonly system_finished_turn: true },
  before_signal: () => boolean,
  transport = agentProcessCommand,
  exec = run,
): Promise<DarwinTurnStop> {
  const bound = binding(execution, ref, owner);
  if (!bound) return { sent: false, reason: "refused" };
  let cmd: Awaited<ReturnType<typeof transport>>;
  try {
    const [stop, inspector] = await Promise.all(
      ["darwin-turn-stop.py", "inspect-worker.py"].map((name) =>
        readFile(new URL(`../../../deploy/${name}`, import.meta.url), "utf8"),
      ),
    );
    if (!stop || !inspector) return { sent: false, reason: "refused" };
    cmd = await transport(
      execution,
      ["/usr/bin/python3", "-IB", "-c", stop, inspector, JSON.stringify(bound)],
      { workerRuntimeDir: true },
    );
  } catch {
    return { sent: false, reason: "refused" };
  }
  if (!before_signal()) return { sent: false, reason: "guard_changed" };
  try {
    const reply = JSON.parse(await exec(cmd.file, cmd.args)) as {
      result?: unknown;
      pid?: unknown;
    };
    if (
      reply.result === "sent" &&
      reply.pid === owner.enrolled_process?.pid &&
      Number.isSafeInteger(reply.pid)
    )
      return { sent: true, pid: reply.pid as number };
    if (reply.result === "refused") return { sent: false, reason: "refused" };
  } catch {
    // Transport loss or a worker failure after the guard: not proof of no signal.
  }
  return { sent: "unknown" };
}
