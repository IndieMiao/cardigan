import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Assignment, ProjectId, Run, Runtime } from "@cardigan/domain";
import {
  ToolError,
  type WorkerUnavailableReason,
  workerEvidence,
} from "@cardigan/mcp-server";
import {
  agentProcessCommand,
  type ExecutionConfig,
  managedLoopback,
  runtimeOwnsRef,
} from "@cardigan/runtime-herdr";

import { redactWorkerLaunch } from "./launch-redaction.js";
import { observeTurnOwner } from "./stall-evidence.js";

const names = [
  "worker-files.py",
  "worker-git.py",
  "worker-primitives.py",
] as const;
const release = (name: string) =>
  readFile(new URL(`../../../deploy/${name}`, import.meta.url));
class WorkerInspectionError extends ToolError {}
const unavailable = (reason: string) =>
  new WorkerInspectionError(
    "illegal_transition",
    `Worker inspection unavailable: ${reason}`,
    { reason },
  );

/**
 * C-746: why each live field is null. Without live facts (the query named a
 * Run that does not hold the session, or no session is bound) the collector
 * was never asked; otherwise the collector names its failed read.
 */
type LiveField = "terminals" | "processes" | "events";
function unavailableFields(
  evidence: Record<LiveField, unknown> & {
    unavailable?:
      | {
          [K in LiveField | "activity"]?: WorkerUnavailableReason | undefined;
        }
      | undefined;
  },
  live: boolean,
  current: boolean,
) {
  const host: WorkerUnavailableReason | undefined = live
    ? undefined
    : current
      ? "session_not_bound"
      : "run_not_current";
  const reasons: Partial<
    Record<LiveField | "activity" | "last_activity_at", WorkerUnavailableReason>
  > = {};
  for (const field of ["terminals", "processes", "events"] as const)
    if (host || evidence[field] === null)
      reasons[field] = host ?? evidence.unavailable?.[field] ?? "other";
  // C-849: a live terminal without activity names why (the CLI never
  // reports it to hc); the last activity time then comes from the
  // transcript, and names the events reason when that is unreadable too.
  if (live && evidence.unavailable?.activity)
    reasons.activity = evidence.unavailable.activity;
  if (host || !lastActivityAt(evidence.events))
    reasons.last_activity_at = host ?? reasons.events ?? "other";
  return reasons;
}

/** C-849: the newest transcript event time, the session's last activity. */
function lastActivityAt(events: unknown) {
  if (!Array.isArray(events)) return null;
  let latest: string | null = null;
  for (const e of events as { time: string }[])
    if (!latest || Date.parse(e.time) > Date.parse(latest)) latest = e.time;
  return latest;
}

/** Collect files/processes only via the selected isolated account; native
 * local diagnostics may project the exact hc observation, not controller data. */
export async function inspectWorker(
  execution: ExecutionConfig,
  project: ProjectId,
  a: Assignment,
  run: Run | undefined,
  current: boolean,
  platform: string,
  harness = run?.harness,
  runtime?: Runtime,
  /** C-806: also collect a failed launch's evidence (from `since`). */
  launch?: { since: string },
  /** C-849: the Run that launched the resident session, when it is not `run`. */
  sessionLaunch?: Run,
) {
  const target = execution.target;
  if (!target) throw unavailable("worker_binding_missing");
  if (target.project_id !== project || target.machine_id !== a.machine_id)
    throw unavailable("worker_binding_mismatch");
  if (
    a.external ||
    (execution.mode === "agent-ssh" &&
      ["root", "ciadmin"].includes(execution.user ?? "agent"))
  )
    throw unavailable("worker_identity_not_allowed");
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
  // Native local mode has no isolated worker account. Read only the bound
  // native terminal; never run a file/process collector as the controller.
  if (
    runtime &&
    a.machine_id === "local" &&
    !pub &&
    execution.mode === "local"
  ) {
    if (
      ref?.machine_id !== "local" ||
      ref.runtime_machine !== "local" ||
      !/^t[0-9a-z]{1,12}$/u.test(ref.terminal_ref) ||
      (ref.target && !runtimeOwnsRef(execution, ref))
    )
      throw unavailable("local_session_not_bound");
    const owner = await observeTurnOwner(
      runtime,
      ref,
      {
        project_id: project,
        assignment_id: a.id,
      },
      false,
    );
    if (!owner?.ok || owner.value === "unknown")
      throw unavailable("local_terminal_unconfirmed");
    return {
      source: "local_runtime",
      session_launch_run_id: ref.launch_generation?.run_id ?? null,
      last_activity_at: null,
      terminals: [
        {
          address: ref.terminal_ref,
          state: owner.value === "alive" ? "live" : "finished",
          activity: null,
          screen: [],
        },
      ],
      processes: null,
      events: null,
      markers: null,
      helpers: [],
      free_bytes: null,
      unavailable: {
        processes: "local_runtime_only",
        events: "local_runtime_only",
        last_activity_at: "local_runtime_only",
      },
    };
  }
  if (execution.mode !== "agent-ssh")
    throw unavailable("isolated_worker_transport_required");
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
    throw unavailable("invalid_probe_identity");
  const live = current && (!!ref || !!pub);
  // C-849: an idle or reused session has no publication of its own. Its
  // launch Run's enrolled CLI receipt (same checks as the retirement path)
  // lets the collector list the CLI under the terminal's own program; hc
  // reports only that program on a macOS worker (C-690).
  const launched = sessionLaunch?.launch_publication;
  const sessionProcess =
    !pub &&
    ref &&
    ref === resident &&
    ref.launch_generation &&
    sessionLaunch?.id === ref.launch_generation.run_id &&
    sessionLaunch.assignment_id === a.id &&
    launched?.generation === ref.launch_generation.generation &&
    launched.target.fingerprint === target.fingerprint &&
    launched.runtime_ref?.terminal_ref === ref.terminal_ref &&
    launched.process?.terminal === ref.launch_generation.generation &&
    launched.process.machine === target.fingerprint
      ? launched.process
      : null;
  const payload = {
    project,
    platform,
    live,
    local,
    managed_loopback:
      local && platform === "linux" && managedLoopback(execution),
    assignment: a.id,
    session: target.session,
    root: execution.agentRoot,
    user: execution.user ?? "agent",
    gid: execution.gid,
    harness: harness ?? null,
    generation,
    launch_run: launchRun ?? null,
    terminal: terminal ?? null,
    process: pub?.process ?? sessionProcess,
    target: target.fingerprint,
    // C-823: the Run's id lets the collector find its own (possibly
    // finished) terminal when the Run no longer holds the session.
    launch:
      launch && Number.isFinite(Date.parse(launch.since))
        ? {
            since_ms: Date.parse(launch.since),
            ...(run && /^R-[1-9]\d{0,15}$/u.test(run.id)
              ? { run: run.id }
              : {}),
          }
        : null,
    helpers: [
      execution.fileHelper?.path,
      execution.gitHelper?.path,
      `${execution.agentRoot}/libexec/worker-primitives.py`,
    ],
  };
  let stage = "collector_release_unreadable";
  try {
    const [source, primitives] = await Promise.all([
      release("inspect-worker.py"),
      release("worker-primitives.py"),
    ]);
    stage = "worker_transport_configuration";
    const command = await agentProcessCommand(
      execution,
      [
        execution.fileHelper?.python ??
          execution.macosCore?.python ??
          "/usr/bin/python3",
        "-IB",
        "-c",
        `native = {"__name__":"worker_native"}\nexec(${JSON.stringify(primitives.toString())}, native)\n${source}`,
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
        (error, text) => {
          if (!error) return resolve(text);
          // Never reflect command, hostname, paths, stderr or malformed output.
          const reason =
            error.code === 255
              ? "ssh_connection_failed"
              : error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
                ? "response_too_large"
                : error.killed
                  ? "collector_timeout"
                  : error.code === "ENOENT"
                    ? "transport_binary_missing"
                    : `collector_exit_${typeof error.code === "number" ? error.code : "failed"}`;
          reject(unavailable(reason));
        },
      );
      child.stdin?.on("error", () =>
        reject(unavailable("collector_input_closed")),
      );
      child.stdin?.end(JSON.stringify(payload));
    });
    stage = "invalid_collector_response";
    const { launch: worker, ...evidence } = workerEvidence.parse(
      JSON.parse(output),
    );
    stage = "collector_release_unreadable";
    return {
      ...evidence,
      ...(launch && worker ? { launch: redactWorkerLaunch(worker) } : {}),
      session_launch_run_id: launchRun ?? null,
      last_activity_at: live ? lastActivityAt(evidence.events) : null,
      ...(!live ? { terminals: null, processes: null, events: null } : {}),
      unavailable: unavailableFields(evidence, live, current),
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
  } catch (error) {
    if (error instanceof WorkerInspectionError) throw error;
    throw unavailable(stage);
  }
}
