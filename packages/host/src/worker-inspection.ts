import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Assignment, ProjectId, Run } from "@cardigan/domain";
import { ToolError, workerEvidence } from "@cardigan/mcp-server";
import {
  agentProcessCommand,
  type ExecutionConfig,
  runtimeOwnsRef,
} from "@cardigan/runtime-herdr";

const names = [
  "worker-files.py",
  "worker-git.py",
  "worker-primitives.py",
] as const;
const release = (name: string) =>
  readFile(new URL(`../../../deploy/${name}`, import.meta.url));
const unavailable = () =>
  new ToolError(
    "illegal_transition",
    "Worker unreachable or read-only diagnostics unavailable",
  );

/** The same isolated worker account path is used for loopback and remote machines.
 * Never run a probe in the controller account, including for a local-mode server. */
export async function inspectWorker(
  execution: ExecutionConfig,
  project: ProjectId,
  a: Assignment,
  run: Run | undefined,
  current: boolean,
  platform: string,
  harness = run?.harness,
) {
  const target = execution.target;
  if (
    execution.mode !== "agent-ssh" ||
    !target ||
    target.project_id !== project ||
    target.machine_id !== a.machine_id ||
    a.external ||
    ["root", "ciadmin"].includes(execution.user ?? "agent")
  )
    throw unavailable();
  const pub = run?.launch_publication;
  // Dispatch writes the Assignment ref, but a preparation failure can be
  // recorded as dispatched without ever waking that terminal. A matching
  // launch label proves an exact binding;
  // a unique acknowledged/running occupant also proves session reuse.
  const resident = a.runtime_ref;
  const dispatched = run?.recovery_runtime;
  const residentProven =
    current &&
    resident &&
    (!run ||
      (["dispatched", "acked", "running"].includes(run.status) &&
        (resident.launch_generation?.run_id === run.id ||
          ((run.status === "acked" || run.status === "running") &&
            (!dispatched ||
              JSON.stringify(dispatched) === JSON.stringify(resident))))));
  const ref = pub ? pub.runtime_ref : residentProven ? resident : null;
  if (
    (pub &&
      (pub.target.machine_id !== a.machine_id ||
        pub.target.project_id !== project ||
        pub.target.fingerprint !== target.fingerprint)) ||
    (ref && !runtimeOwnsRef(execution, ref)) ||
    (pub &&
      ref &&
      (ref.launch_generation?.generation !== pub.generation ||
        ref.launch_generation.run_id !== run?.id))
  )
    throw new ToolError("stale_target", "Worker binding changed");
  const launchRun = pub ? run?.id : ref?.launch_generation?.run_id;
  const generation =
    pub?.generation ?? ref?.launch_generation?.generation ?? null;
  const local = a.machine_id === "local" && !pub;
  const validGeneration = local
    ? /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    : /^[0-9a-f]{32}$/u;
  const terminal = ref?.terminal_ref.split("/").at(-1);
  if (
    !/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/u.test(project) ||
    !/^A-[1-9]\d*$/u.test(a.id) ||
    !["linux", "darwin"].includes(platform) ||
    !/^[a-zA-Z0-9_-]{1,48}$/u.test(target.session) ||
    (launchRun !== undefined && !/^R-[1-9]\d*$/u.test(launchRun)) ||
    (pub && !generation) ||
    (generation !== null && !validGeneration.test(generation)) ||
    (ref &&
      (!terminal ||
        !/^t[0-9a-z]{1,12}$/u.test(terminal) ||
        ref.terminal_ref !==
          (execution.machine === "local"
            ? terminal
            : `${execution.machine}/${terminal}`)))
  )
    throw unavailable();
  const live = current && (!!ref || !!pub);
  const payload = {
    project,
    platform,
    live,
    local,
    assignment: a.id,
    session: target.session,
    root: execution.agentRoot,
    user: execution.user ?? "agent",
    gid: execution.gid,
    harness: harness ?? null,
    generation,
    launch_run: launchRun ?? null,
    terminal: terminal ?? null,
    process: pub?.process ?? null,
    target: target.fingerprint,
    helpers: [
      execution.fileHelper?.path,
      execution.gitHelper?.path,
      `${execution.agentRoot}/libexec/worker-primitives.py`,
    ],
  };
  try {
    const source = await release("inspect-worker.py");
    const command = await agentProcessCommand(
      execution,
      [
        execution.fileHelper?.python ??
          execution.macosCore?.python ??
          "/usr/bin/python3",
        "-IB",
        "-c",
        `native = {"__name__":"worker_native"}\nexec(${JSON.stringify((await release("worker-primitives.py")).toString())}, native)\n${source}`,
      ],
      platform === "linux" ? { workerRuntimeDir: true } : undefined,
    );
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        command.file,
        command.args,
        {
          cwd: "/",
          env: { PATH: "/usr/bin:/bin" },
          timeout: 15_000,
          killSignal: "SIGKILL",
          maxBuffer: 32768,
        },
        (error, text) => (error ? reject(unavailable()) : resolve(text)),
      );
      child.stdin?.on("error", () => reject(unavailable()));
      child.stdin?.end(JSON.stringify(payload));
    });
    const evidence = workerEvidence.parse(JSON.parse(output));
    return {
      ...evidence,
      session_launch_run_id: launchRun ?? null,
      ...(!live ? { terminals: null, processes: null, events: null } : {}),
      helpers: await Promise.all(
        names.map(async (name, i) => ({
          name,
          sha256: evidence.helpers[i],
          matches_release: evidence.helpers[i]
            ? evidence.helpers[i] ===
              createHash("sha256")
                .update(await release(name))
                .digest("hex")
            : null,
        })),
      ),
    };
  } catch {
    throw unavailable();
  }
}
