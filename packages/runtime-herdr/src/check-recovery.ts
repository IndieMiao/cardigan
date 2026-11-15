import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import {
  CHECK_RECOVERY_STAGES,
  type CheckRecoveryOutcome,
} from "@cardigan/domain";
import { agentProcessCommand } from "./agent-ssh.js";
import { CHECK_RECOVERY_WORKER } from "./check-recovery-worker.js";
import type { ExecutionConfig } from "./execution.js";

export interface CheckDirectoryIdentity {
  device: string;
  inode: string;
  uid: number;
}
/** Captured by the authenticated supervisor before running candidate code. */
export interface CheckRecoveryBinding {
  git_layout: "bare" | "checkout";
  container: CheckDirectoryIdentity;
  worktree: CheckDirectoryIdentity;
  repository: CheckDirectoryIdentity;
  registration: CheckDirectoryIdentity;
  registration_name: string;
}
export type CheckRecoveryResult = CheckRecoveryOutcome;
export function validCheckRecoveryBinding(
  value: unknown,
): value is CheckRecoveryBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as CheckRecoveryBinding;
  return (
    ["bare", "checkout"].includes(binding.git_layout) &&
    typeof binding.registration_name === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(binding.registration_name) &&
    [
      binding.container,
      binding.worktree,
      binding.repository,
      binding.registration,
    ].every(
      (v) =>
        v &&
        typeof v.device === "string" &&
        typeof v.inode === "string" &&
        /^\d+$/u.test(v.device) &&
        /^[1-9]\d*$/u.test(v.inode) &&
        Number.isSafeInteger(v.uid) &&
        v.uid > 0,
    )
  );
}

/** Fixed recovery operation; no caller-controlled shell, path, PID or signal. */
export async function recoverCheckDirectory(
  execution: Extract<ExecutionConfig, { mode: "agent-ssh" }>,
  input: {
    project: string;
    attempt: string;
    sha: string;
    binding: CheckRecoveryBinding;
    slots: number;
    /** Read-only, bounded presence patrol; never scans processes or authorizes deletion. */
    observeOnly?: boolean;
    /** Audit a verified absence; this callback never authorizes deletion. */
    confirmAbsence: () => void;
  },
  start: (
    file: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => ChildProcessWithoutNullStreams = (file, args, env) =>
    spawn(file, args, { env, stdio: ["pipe", "pipe", "pipe"] }),
): Promise<CheckRecoveryResult> {
  if (
    !execution.host ||
    !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(input.project) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(input.attempt) ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(input.sha) ||
    !validCheckRecoveryBinding(input.binding) ||
    !Number.isSafeInteger(input.slots) ||
    input.slots < 1 ||
    input.slots > 16
  )
    throw new Error("Invalid check recovery identity");
  const { confirmAbsence, ...request } = input;
  const authKey = randomBytes(32).toString("hex");
  const command = await agentProcessCommand(execution, [
    "/usr/bin/python3",
    "-I",
    "-c",
    CHECK_RECOVERY_WORKER,
    execution.agentRoot,
  ]);
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    const failed: CheckRecoveryResult = {
      status: "manual_attention",
      reason: "transport",
      stage: "transport",
      processes: [],
    };
    try {
      child = start(command.file, command.args, { PATH: "/usr/bin:/bin" });
    } catch {
      resolve(failed);
      return;
    }
    let result: CheckRecoveryResult | undefined,
      confirmedAbsent = false,
      closed = false,
      bytes = 0;
    const lines = createInterface({ input: child.stdout });
    const finish = (ok: boolean) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      lines.close();
      resolve(ok && result ? result : failed);
    };
    const stop = () => {
      child.kill("SIGKILL");
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      finish(false);
    };
    // Same bound as the existing remote maintenance operation.
    const timer = setTimeout(stop, 60_000);
    child.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > 65536) stop();
    });
    lines.on("line", (line) => {
      if (closed) return;
      try {
        const { auth, ...value } = JSON.parse(line);
        if (
          auth !==
          createHmac("sha256", authKey)
            .update(JSON.stringify(value))
            .digest("hex")
        )
          throw new Error("Unauthenticated recovery response");
        if (value.phase === "absent" && !confirmedAbsent && !result) {
          confirmAbsence();
          confirmedAbsent = true;
          child.stdin.end("confirm\n");
          return;
        }
        if (
          result ||
          (value.stage !== undefined &&
            !CHECK_RECOVERY_STAGES.includes(value.stage)) ||
          (value.evidence !== undefined &&
            !/^[a-f0-9]{64}$/u.test(value.evidence)) ||
          (value.stage === "presence" &&
            (!input.observeOnly ||
              value.status !== "manual_attention" ||
              value.reason !== "unverified" ||
              value.processes?.length !== 0 ||
              typeof value.evidence !== "string")) ||
          !["cleaned", "manual_attention", "busy"].includes(value.status) ||
          ![
            "complete",
            "occupied",
            "unverified",
            "locked",
            "exclusion_unproven",
          ].includes(value.reason) ||
          (value.status === "cleaned" &&
            (!confirmedAbsent ||
              value.reason !== "complete" ||
              value.processes?.length !== 0)) ||
          !Array.isArray(value.processes) ||
          !value.processes.every(
            (p: CheckRecoveryResult["processes"][number]) =>
              Number.isSafeInteger(p.pid) &&
              p.pid > 0 &&
              /^(?:[A-Z]|unknown)$/u.test(p.state) &&
              /^[A-Za-z0-9_]{1,80}$/u.test(p.wchan),
          )
        )
          throw new Error("Invalid recovery response");
        result = {
          ...(value.stage !== undefined ? { stage: value.stage } : {}),
          ...(value.evidence !== undefined ? { evidence: value.evidence } : {}),
          status: value.status,
          reason: value.reason,
          processes: value.processes.map(
            ({
              pid,
              state,
              wchan,
            }: CheckRecoveryResult["processes"][number]) => ({
              pid,
              state,
              wchan,
            }),
          ),
        };
        // A terminal diagnostic has no further handshake. Release the input
        // pipe as well, so a remote reader cannot wait for an acknowledgement.
        child.stdin.end();
      } catch {
        stop();
      }
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    child.stdin.write(`${JSON.stringify({ ...request, auth_key: authKey })}\n`);
  });
}
