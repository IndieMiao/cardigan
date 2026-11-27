import {
  type CommandState,
  dispatchedAt,
  type LaunchEvidence,
  launchEvidenceRecorded,
  type ProjectId,
  type Run,
  type RunId,
  recordLaunchEvidence,
  workerInspectionTarget,
} from "@cardigan/domain";
import {
  loadCommandState,
  persistEffect,
  ToolError,
  unwrap,
  type WorkerLaunchEvidence as WorkerLaunch,
} from "@cardigan/mcp-server";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import type { Store } from "@cardigan/store";
import { inspectWorker } from "./worker-inspection.js";

export { redactLaunchText, redactWorkerLaunch } from "./launch-redaction.js";

const reasonCode = (value: unknown) =>
  typeof value === "string" && /^[a-z][a-z0-9_]{0,39}$/u.test(value)
    ? value
    : "worker_unavailable";

export interface LaunchEvidenceOptions {
  readonly store: Store;
  readonly workerExecution?:
    | ((project: ProjectId, machine: string) => ExecutionConfig)
    | undefined;
  readonly runtime?: Parameters<typeof inspectWorker>[7];
  readonly now: () => string;
  /** Tests substitute the project state. */
  readonly loadState?: (project: ProjectId) => CommandState;
}

/**
 * C-806: collect a failed launch's evidence from the host's own records and
 * the worker (local or remote) through the fixed read-only collector. A part
 * the worker cannot give is named by a bounded reason code instead.
 */
export async function collectLaunchEvidence(
  options: LaunchEvidenceOptions,
  project: ProjectId,
  runId: RunId,
  reason: LaunchEvidence["reason"],
): Promise<LaunchEvidence | undefined> {
  const state =
    options.loadState?.(project) ??
    options.store.uow.read((tx) => loadCommandState(tx, project));
  const run = state.runs.find((r) => r.id === runId);
  const a = run && state.assignments.find((x) => x.id === run.assignment_id);
  if (!run || !a || run.started_at || launchEvidenceRecorded(state, run.id))
    return;
  const since = dispatchedAt(state, run);
  const target = workerInspectionTarget(state, {
    machine_id: a.machine_id,
    assignment_id: a.id,
    run_id: run.id,
  });
  let launch: WorkerLaunch | undefined;
  let missing: string | undefined;
  try {
    const execution = options.workerExecution?.(project, a.machine_id);
    if (!execution || !target.platform) missing = "worker_binding_unconfigured";
    else {
      const evidence = await inspectWorker(
        execution,
        project,
        a,
        run,
        target.current,
        target.platform,
        target.harness,
        options.runtime,
        { since: since ?? options.now() },
      );
      launch = "launch" in evidence ? evidence.launch : undefined;
      if (!launch) missing = "local_runtime_only";
    }
  } catch (error) {
    missing = reasonCode(
      error instanceof ToolError
        ? (error.details as { reason?: unknown } | undefined)?.reason
        : undefined,
    );
  }
  const unavailable: Record<string, string> = {};
  for (const [key, value] of Object.entries(launch?.unavailable ?? {}))
    if (value) unavailable[key] = reasonCode(value);
  if (missing) unavailable.terminal = unavailable.mcp = missing;
  return {
    reason,
    machine_id: a.machine_id,
    harness: target.harness ?? null,
    waited_ms: since
      ? Math.max(0, Date.parse(options.now()) - Date.parse(since))
      : null,
    card_handshake: a.mcp_handshake ?? null,
    terminal: launch?.terminal
      ? {
          state: launch.terminal.state,
          ...(launch.terminal.exit_code === undefined
            ? {}
            : { exit_code: launch.terminal.exit_code }),
          ...(launch.terminal.exit_reason === undefined
            ? {}
            : { exit_reason: launch.terminal.exit_reason }),
          tail: launch.terminal.tail,
          ...(launch.terminal.resources
            ? { resources: launch.terminal.resources }
            : {}),
        }
      : null,
    mcp_servers: launch?.mcp ?? null,
    unavailable,
  };
}

/**
 * C-806: once per unstarted Run, right before the host stops its session.
 * The event (`run_launch_evidence`) and its timeline line are the durable
 * record; a failure here never delays or blocks the stop itself.
 */
export async function recordRunLaunchEvidence(
  options: LaunchEvidenceOptions & { onError?: (error: unknown) => void },
  project: ProjectId,
  runId: RunId,
  reason: NonNullable<Run["dispatch_stop"]>["reason"],
): Promise<void> {
  try {
    const evidence = await collectLaunchEvidence(
      options,
      project,
      runId,
      reason,
    );
    if (!evidence) return;
    options.store.uow.run((tx) => {
      const state: CommandState = loadCommandState(tx, project);
      persistEffect(
        tx,
        project,
        unwrap(
          recordLaunchEvidence(
            state,
            { kind: "system", project_id: project },
            { run_id: runId, evidence },
            { ids: tx.ids, clock: { now: options.now } },
          ),
        ),
      );
    });
  } catch (error) {
    options.onError?.(error);
  }
}
