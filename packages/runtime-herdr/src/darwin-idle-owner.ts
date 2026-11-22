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
  if (
    !enabled(e) ||
    e.mode !== "agent-ssh" ||
    !e.macosCore ||
    !e.target ||
    e.target.machine_id === "local" ||
    !e.fileHelper ||
    !e.user ||
    a.scope !== "work_item" ||
    a.external ||
    !["none", "write", "readonly"].includes(role.worktree ?? "") ||
    launch.command !== e.fileHelper.python ||
    launch.args[0] !== "-I" ||
    launch.args[1] !== "-B" ||
    launch.args[2] !== e.fileHelper.path ||
    launch.args[4] !== "run" ||
    launch.args.length !== 7 ||
    !/^[0-9a-f]{64}$/u.test(launch.args[6] ?? "") ||
    !launch.labels.generation ||
    !launch.labels.run ||
    launch.labels.project !== e.target.project_id ||
    launch.labels.assignment !== a.id
  )
    return launch;
  const { project, run, generation } = launch.labels;
  const { directory, id, identity } = enrollment(
    e,
    project,
    a.id,
    run,
    generation,
  );
  const packet = workerFileRequest(e, identity, "status");
  if (launch.args[5] !== packet.subarray(0, packet.indexOf(10)).toString())
    return launch;
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
  if (!key) return launch;
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
   if i==0: s.sendall(sys.stdin.buffer.readline(256))`;

type Refusal = RetirementEvidence["reason"];
const refused = (reason: Refusal): IdleRetirementResult => ({
  outcome: "withdrawn",
  evidence: { stage: "probe", reason },
});
const uncertain = (): IdleRetirementResult => ({
  outcome: "uncertain",
  evidence: { stage: "confirm", reason: "confirmation_pending" },
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
  if (
    !enabled(e) ||
    !target ||
    !g ||
    !p ||
    options.system_finished_turn ||
    !ref.terminal_ref.startsWith(`${e.machine}/`) ||
    p.machine !== target.fingerprint ||
    p.terminal !== g.generation
  )
    return refused("conditional_close_unavailable");
  const { directory, id } = enrollment(
    e,
    options.project_id,
    options.assignment_id,
    g.run_id,
    g.generation,
  );
  // Without a key this controller can rebuild no owner can be asked. No
  // other entry can bind the original generation at delivery (Q-1166): the
  // session is kept and the bounded handoff applies.
  const key = await darwinOwnerKey(e.dataDir, id).catch(() => undefined);
  if (!key) return refused("conditional_close_unavailable");
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
  const unowned = refused("conditional_close_unavailable");
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
    const lost = () =>
      finish(attempted ? uncertain() : refused("probe_invalid"));
    child.stdin.on("error", lost);
    child.on("error", lost);
    child.on("close", (code) =>
      code === 3 && !attempted ? finish(unowned) : lost(),
    );
    child.stdout.setEncoding("utf8").on("data", (data: string) => {
      if (settled) return;
      buffer += data;
      if (buffer.length > 256) return lost();
      if (!buffer.includes("\n")) return;
      if (attempted) return finish(uncertain());
      // Owners enrolled before durable keys report no key id.
      const challenge = /^([a-f0-9]{64})(?: ([a-f0-9]{64}))?\n$/u.exec(buffer);
      if (!challenge) return lost();
      if (challenge[2] !== key.id) return finish(unowned);
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
