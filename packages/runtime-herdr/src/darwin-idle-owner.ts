import { spawn } from "node:child_process";
import { createHash, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import type {
  Assignment,
  IdleRetirementResult,
  RetirementEvidence,
  Role,
  Runtime,
  RuntimeLaunch,
  RuntimeRef,
} from "@cardigan/domain";
import { agentProcessCommand } from "./agent-ssh.js";
import {
  readDarwinEnrollment,
  recordDarwinEnrollment,
} from "./darwin-owner-enrollment.js";
import { darwinOwnerKey } from "./darwin-owner-key.js";
import type { ExecutionConfig } from "./execution.js";
import { workerFileRequest, workerLaunchPath } from "./worker-files.js";

type Ssh = Extract<ExecutionConfig, { mode: "agent-ssh" }>;
type Stop = Parameters<NonNullable<Runtime["retire_idle"]>>[1];
// Deliberately no wildcard: enrollment and use both require this exact private target.
const enabled = (e: ExecutionConfig) =>
  !!e.target &&
  /^[0-9a-f]{64}$/u.test(e.target.fingerprint) &&
  process.env.CARDIGAN_DARWIN_IDLE_TARGETS?.split(",").includes(
    e.target.fingerprint,
  ) === true;
const enrollment = (
  e: Ssh,
  project: string,
  assignment: string,
  run: string,
  generation: string,
) => {
  const identity = {
    project,
    assignment,
    run,
    generation,
    target: e.target?.fingerprint ?? "",
  };
  const directory = workerLaunchPath(e, identity).value;
  return {
    directory,
    identity,
    id: JSON.stringify([e.target?.fingerprint, directory, run]),
  };
};

/** Opt-in only for the exact existing digest-pinned worker launcher, not arbitrary terminals. */
export async function enrollDarwinOwner(
  e: ExecutionConfig,
  a: Assignment,
  role: Role,
  launch: RuntimeLaunch,
): Promise<RuntimeLaunch> {
  // Not a launch of this controller's opted-in Darwin target: nothing to record.
  if (
    !enabled(e) ||
    e.mode !== "agent-ssh" ||
    !e.macosCore ||
    !e.target ||
    e.target.machine_id === "local" ||
    !launch.labels.generation ||
    !launch.labels.run ||
    launch.labels.project !== e.target.project_id
  )
    return launch;
  const ssh = e;
  const { project, run, generation } = launch.labels;
  // C-804: a skipped enrollment says why, so a refused retirement can name it.
  const skip = async (reason: string) => {
    let id: string | undefined;
    try {
      id = enrollment(ssh, project, a.id, run, generation).id;
    } catch {}
    if (id) await recordDarwinEnrollment(ssh.dataDir, id, reason);
    return launch;
  };
  if (!e.fileHelper || !e.user) return skip("worker_config");
  if (a.scope !== "work_item" || a.external) return skip("assignment_scope");
  if (!["none", "write", "readonly"].includes(role.worktree ?? ""))
    return skip("role_worktree");
  if (
    launch.command !== e.fileHelper.python ||
    launch.args[0] !== "-I" ||
    launch.args[1] !== "-B" ||
    launch.args[2] !== e.fileHelper.path ||
    launch.args[4] !== "run" ||
    launch.args.length !== 7 ||
    !/^[0-9a-f]{64}$/u.test(launch.args[6] ?? "")
  )
    return skip("launch_shape");
  if (launch.labels.assignment !== a.id) return skip("launch_labels");
  const { directory, id, identity } = enrollment(
    e,
    project,
    a.id,
    run,
    generation,
  );
  const packet = workerFileRequest(e, identity, "status");
  if (launch.args[5] !== packet.subarray(0, packet.indexOf(10)).toString())
    return skip("launch_packet");
  const [owner, inspector] = await Promise.all(
    ["darwin-idle-owner.py", "inspect-worker.py"].map((name) =>
      readFile(new URL(`../../../deploy/${name}`, import.meta.url), "utf8"),
    ),
  );
  if (!owner || !inspector) throw new Error("Missing Darwin owner");
  // Rebuilt from the host-private seed after any restart. Without a seed the
  // session still launches unenrolled and retirement keeps the bounded handoff.
  const key = await darwinOwnerKey(e.dataDir, id, true).catch(() => {
    console.error("Darwin idle owner seed unavailable; launch not enrolled");
  });
  if (!key) return skip("seed_unavailable");
  await recordDarwinEnrollment(e.dataDir, id, "enrolled");
  const config = {
    project,
    assignment: a.id,
    generation,
    launch_run: run,
    target: e.target.fingerprint,
    session: e.target.session,
    primitive: posix.join(
      posix.dirname(e.fileHelper.path),
      "worker-primitives.py",
    ),
    root: e.agentRoot,
    cwd: launch.cwd,
    agent_name: launch.agent_name,
    worktree: role.worktree,
    user: e.user,
    gid: e.gid,
    directory,
    public_pem: key.publicKey.export({ type: "spki", format: "pem" }),
  };
  return {
    ...launch,
    command: "/usr/bin/python3",
    args: [
      "-IB",
      "-c",
      owner,
      inspector,
      JSON.stringify(config),
      launch.command,
      ...launch.args,
    ],
  };
}

// This relay has no signal operation. The same connected socket carries the challenge and response.
// Exit 3: no owner listens for this generation (launched before enrollment).
// A challenge the controller abandons (no signature line) closes the socket
// at once, so the single-threaded owner is not held for its read timeout.
const relay = `import os,socket,sys
os.chdir(sys.argv[1])
with socket.socket(socket.AF_UNIX) as s:
 s.settimeout(10)
 try: s.connect('idle-owner.sock')
 except (FileNotFoundError, ConnectionRefusedError): sys.exit(3)
 s.sendall(sys.stdin.buffer.readline(2048))
 with s.makefile('rb') as f:
  for i in range(2):
   line=f.readline(256)
   if not line.endswith(b'\\n'): sys.exit(1)
   sys.stdout.buffer.write(line); sys.stdout.buffer.flush()
   if i==0:
    signature=sys.stdin.buffer.readline(256)
    if not signature.endswith(b'\\n'): sys.exit(1)
    s.sendall(signature)`;

type Refusal = RetirementEvidence["reason"];
const refused = (reason: Refusal): IdleRetirementResult => ({
  outcome: "withdrawn",
  evidence: { stage: "probe", reason },
});
/**
 * C-804: each precondition of the owner path that does not hold. All stay
 * `conditional_close_unavailable` (the session is kept, nothing is signed);
 * the bounded token and the launch's enrollment record only tell them apart.
 */
type Precondition =
  | "target_not_enabled"
  | "launch_generation_missing"
  | "terminal_machine_mismatch"
  | "enrolled_process_missing"
  | "receipt_target_mismatch"
  | "receipt_generation_mismatch"
  | "seed_missing"
  | "seed_unavailable"
  | "owner_not_listening"
  | "owner_key_absent"
  | "owner_key_mismatch";
const unavailable = (
  precondition: Precondition,
  facts: { enrollment?: string; exit_code?: number } = {},
): IdleRetirementResult => ({
  outcome: "withdrawn",
  evidence: {
    stage: "probe",
    reason: "conditional_close_unavailable",
    precondition,
    ...facts,
  },
});
const uncertain = (): IdleRetirementResult => ({
  outcome: "uncertain",
  evidence: { stage: "confirm", reason: "confirmation_pending" },
});
/**
 * C-746: the owner names the proof it refused (`refused <code>`) before it
 * closes. A dirty or unprovable checkout and a busy terminal are deliberate
 * keeps; any other refusal stays `probe_invalid`, now with its cause. The
 * code is a bounded token: never a path, file name or screen text.
 */
export function ownerRefusal(code: string): {
  readonly outcome: "withdrawn";
  readonly evidence: RetirementEvidence;
} {
  return {
    outcome: "withdrawn",
    evidence: {
      stage: "probe",
      reason:
        code === "terminal_not_idle"
          ? "terminal_busy"
          : /^(?:workspace|worktree|git|build)_/u.test(code)
            ? "workspace_not_clean"
            : "probe_invalid",
      owner_reason: code,
    },
  };
}
/** An owner that closed without naming a cause (enrolled before C-746), or a
 * relay/transport failure before any challenge. Nothing was signed. */
const unanswered = (
  owner_reason: "no_reply" | "relay_failed",
  code?: number | null,
): IdleRetirementResult => ({
  outcome: "withdrawn",
  evidence: {
    stage: "probe",
    reason: "probe_invalid",
    owner_reason,
    ...(Number.isInteger(code) &&
    (code as number) >= 0 &&
    (code as number) <= 255
      ? { exit_code: code as number }
      : {}),
  },
});

export async function stopDarwinOwner(
  e: Ssh,
  ref: RuntimeRef,
  options: Stop,
  transport = agentProcessCommand,
): Promise<IdleRetirementResult> {
  const g = ref.launch_generation,
    p = options.enrolled_process,
    target = e.target;
  // C-626: a system-ended turn may ask the owner too. The adapter already
  // ran its workspace preflight; the owner still requires a clean checkout
  // and an idle status itself, and refuses before any challenge otherwise.
  if (!enabled(e) || !target) return unavailable("target_not_enabled");
  if (!g) return unavailable("launch_generation_missing");
  if (!ref.terminal_ref.startsWith(`${e.machine}/`))
    return unavailable("terminal_machine_mismatch");
  const bind = () =>
    enrollment(
      e,
      options.project_id,
      options.assignment_id,
      g.run_id,
      g.generation,
    );
  let bound: ReturnType<typeof bind> | undefined;
  try {
    bound = bind();
  } catch {}
  // C-804: what this host recorded when it launched this generation.
  const enrolled = bound
    ? { enrollment: await readDarwinEnrollment(e.dataDir, bound.id) }
    : {};
  if (!p) return unavailable("enrolled_process_missing", enrolled);
  if (p.machine !== target.fingerprint)
    return unavailable("receipt_target_mismatch", enrolled);
  if (p.terminal !== g.generation)
    return unavailable("receipt_generation_mismatch", enrolled);
  // A foreign identity still fails here, as before C-804.
  const { directory, id } = bound ?? bind();
  // Without a key this controller can rebuild no owner can be asked. No
  // other entry can bind the original generation at delivery (Q-1166): the
  // session is kept and the bounded handoff applies.
  let seedFailure: Precondition | undefined;
  const key = await darwinOwnerKey(e.dataDir, id).catch((err: unknown) => {
    seedFailure =
      (err as NodeJS.ErrnoException).code === "ENOENT"
        ? "seed_missing"
        : "seed_unavailable";
  });
  if (!key) return unavailable(seedFailure ?? "seed_unavailable", enrolled);
  const request =
    JSON.stringify({
      process: p,
      terminal: ref.terminal_ref.slice(e.machine.length + 1),
    }) + "\n";
  const cmd = await transport(e, [
    "/usr/bin/python3",
    "-IB",
    "-c",
    relay,
    directory,
  ]);
  // An owner this controller cannot serve (none listening, or a key it
  // cannot rebuild) is never signed for: nothing was attempted.
  return new Promise<IdleRetirementResult>((resolve) => {
    const child = spawn(cmd.file, cmd.args, {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 20000,
    });
    let attempted = false,
      buffer = "",
      settled = false;
    const finish = (value: IdleRetirementResult) => {
      if (settled) return;
      settled = true;
      child.stdin.end();
      resolve(value);
    };
    const lost = (code?: number | null) =>
      finish(
        attempted
          ? uncertain()
          : unanswered(code === undefined ? "relay_failed" : "no_reply", code),
      );
    child.stdin.on("error", () => lost());
    child.on("error", () => lost());
    child.on("close", (code) =>
      code === 3 && !attempted
        ? finish(
            unavailable("owner_not_listening", { ...enrolled, exit_code: 3 }),
          )
        : lost(code),
    );
    child.stdout.setEncoding("utf8").on("data", (data: string) => {
      if (settled) return;
      buffer += data;
      if (buffer.length > 256) return lost();
      if (!buffer.includes("\n")) return;
      if (attempted) return finish(uncertain());
      const refusal = /^refused ([a-z_]{1,32})\n$/u.exec(buffer);
      if (refusal) return finish(ownerRefusal(refusal[1]!));
      // Owners enrolled before durable keys report no key id.
      const challenge = /^([a-f0-9]{64})(?: ([a-f0-9]{64}))?\n$/u.exec(buffer);
      if (!challenge) return lost();
      // C-804: only whether the ids agree is recorded, never either id.
      if (challenge[2] !== key.id)
        return finish(
          unavailable(
            challenge[2] === undefined
              ? "owner_key_absent"
              : "owner_key_mismatch",
            enrolled,
          ),
        );
      const message = `${challenge[1]}:${createHash("sha256").update(request).digest("hex")}`;
      buffer = "";
      try {
        if (!enabled(e) || !options.before_signal())
          return finish(refused("guard_changed"));
        attempted = true;
        child.stdin.write(
          `${sign("sha256", Buffer.from(message), key.privateKey).toString("base64")}\n`,
        );
      } catch {
        lost();
      }
    });
    child.stdin.write(request);
  });
}
