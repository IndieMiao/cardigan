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
  const ref = pub ? pub.runtime_ref : current ? a.runtime_ref : null;
  if (
    (pub &&
      (pub.target.machine_id !== a.machine_id ||
        pub.target.project_id !== project ||
        pub.target.fingerprint !== target.fingerprint)) ||
    (ref && !runtimeOwnsRef(execution, ref))
  )
    throw new ToolError("stale_target", "Worker binding changed");
  // A reused terminal retains its original launch generation/labels. Do not
  // substitute a new terminal for a historical Run without launch evidence.
  const launchRun = pub
    ? run?.id
    : (ref?.launch_generation?.run_id ?? (ref ? undefined : run?.id));
  const generation =
    pub?.generation ?? ref?.launch_generation?.generation ?? null;
  if (
    !/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/u.test(project) ||
    !/^A-[1-9]\d*$/u.test(a.id) ||
    (generation && !/^[0-9a-f]{32}$/u.test(generation))
  )
    throw unavailable();
  const payload = {
    project,
    assignment: a.id,
    session: target.session,
    root: execution.agentRoot,
    user: execution.user ?? "agent",
    gid: execution.gid,
    harness: run?.harness ?? null,
    generation,
    launch_run: launchRun ?? null,
    terminal: ref?.terminal_ref.split("/").at(-1) ?? null,
    process: pub?.process ?? null,
    legacy: !generation && current && a.machine_id === "local",
    target: target.fingerprint,
    helpers: [
      execution.fileHelper?.path,
      execution.gitHelper?.path,
      `${execution.agentRoot}/libexec/worker-primitives.py`,
    ],
  };
  try {
    const source = await release("inspect-worker.py");
    const command = await agentProcessCommand(execution, [
      execution.fileHelper?.python ??
        execution.macosCore?.python ??
        "/usr/bin/python3",
      "-IB",
      "-c",
      `native = {"__name__":"worker_native"}\nexec(${JSON.stringify((await release("worker-primitives.py")).toString())}, native)\n${source}`,
    ]);
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
