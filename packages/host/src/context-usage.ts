import { resolve, sep } from "node:path";
import {
  type Assignment,
  associatedHarnessActivity,
  type CommandState,
  type ContextObservation,
  type ContextUsage,
  contextGenerationStart,
  contextObservationCurrent,
  contextUsageFresh,
  contextUsageLevel,
  contextUsageThresholds,
  currentHarnessActivity,
  type Event,
  type HarnessActivity,
  isHarness,
  type ProjectId,
  projectPreferences,
  type Run,
  type RuntimeRef,
} from "@cardigan/domain";
import {
  type ActivityMetadata,
  type ContextReading,
  type ContextSample,
  expandClaudeModel,
  getHarnessAdapter,
  type LaunchConfig,
  measured,
  parseContextSample,
  resolveProfile,
} from "@cardigan/roles";

export {
  claudeContextWindow,
  parseClaudeTranscript,
  parseCodexContext,
  parseContextCache,
} from "@cardigan/roles";

import {
  agentProcessCommand,
  type ExecutionConfig,
  executionPaths,
  runtimeOwnsRef,
  workerLaunchPath,
  workerSessionPath,
} from "@cardigan/runtime-herdr";
import { captureTranscript } from "./capture-transcript.js";
import { CLAUDE_CONTEXT_READER } from "./claude-context-reader.js";
import { files, readParts } from "./session-files.js";
import { WORKER_CLAUDE_OPENER } from "./worker-claude-transcript.js";

function profileEnv(launch: LaunchConfig | undefined, ref: string | undefined) {
  return launch && ref
    ? resolveProfile(launch, ref).provider?.definition.env
    : undefined;
}
export function claudeLaunchModel(
  launch: LaunchConfig | undefined,
  ref: string | undefined,
  model: string | undefined,
) {
  return expandClaudeModel(model, () => profileEnv(launch, ref));
}
export interface ContextUsageOptions {
  execution: ExecutionConfig;
  /** Existing Claude status-line cache; optional when not installed. */
  cacheDir?: string;
  staleAfterMs?: number;
  /** Host launch config, used only to expand a Claude model alias. */
  launch?: LaunchConfig;
  /** Service shutdown cancels readers without queuing another Assignment. */
  signal?: AbortSignal;
}
export const DEFAULT_CONTEXT_STALE_AFTER_MS = 10 * 60_000;

async function privateTranscript(
  execution: ExecutionConfig,
  root: string,
  session: string | undefined,
  alertScope: readonly [floor: string, exactCwd: string, childPrefix: string],
  onReadFailure: () => void,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    // Claude creates 0700 directories and 0600 transcripts. In agent-ssh mode
    // the host cannot read them; use the existing credential-checked channel.
    // Roots come from validated execution paths, never transcript metadata.
    const args = [
      "-e",
      CLAUDE_CONTEXT_READER,
      "--",
      root,
      session ?? "",
      "local",
      ...alertScope,
    ];
    const worker = execution.target && execution.target.machine_id !== "local";
    if (worker && (execution.mode !== "agent-ssh" || !execution.fileHelper)) {
      onReadFailure();
      return;
    }
    const remoteArgs =
      worker && execution.mode === "agent-ssh" && execution.fileHelper
        ? [
            execution.fileHelper.python,
            "-I",
            "-B",
            "-c",
            WORKER_CLAUDE_OPENER,
            root,
            session ?? "",
            CLAUDE_CONTEXT_READER,
            ...alertScope,
          ]
        : ["node", ...args];
    const command =
      execution.mode === "agent-ssh"
        ? await agentProcessCommand(execution, remoteArgs)
        : { file: process.execPath, args };
    if (signal?.aborted) return undefined;
    return await captureTranscript(command.file, command.args, signal);
  } catch {
    // No raw process output, transcript text or SSH diagnostics are disclosed.
    onReadFailure();
    return undefined;
  }
}
async function caches(root: string | undefined): Promise<ContextSample[]> {
  if (!root) return [];
  const result: ContextSample[] = [];
  for (const path of await files(root, ".json")) {
    try {
      const parts = await readParts(path, true);
      const usage = parts && parseContextSample(JSON.parse(parts.head));
      if (usage) result.push(usage);
    } catch {
      /* Missing, partial, oversized or unreadable cache: no action. */
    }
  }
  return result;
}

export type HarnessActivityStatus =
  | "fresh"
  | "missing"
  | "stale"
  | "unassociated"
  | "read_failed";
export interface AlertEvidence {
  fileActivity?: HarnessActivity;
  foreground?: { command: string; since: string };
}
export interface HarnessActivityInspection extends AlertEvidence {
  activity?: HarnessActivity;
  startupFailure?: HarnessActivity;
  status: HarnessActivityStatus;
}

export interface SessionContextDiagnostic extends AlertEvidence {
  agent: ContextUsage["agent"] | null;
  cwd: string | null;
  model: string | null;
  assignment_id: Assignment["id"] | null;
  employee_id: string | null;
  employee_name: string | null;
  external: boolean;
  session_id: string | null;
  context_tokens: number | null;
  context_window_size: number | null;
  used_percentage: number | null;
  context_usage_pct: number | null;
  context_usage_estimated: false;
  source: string | null;
  updated_at: string | null;
  stale: boolean;
  status: "fresh" | "missing" | "stale" | "unassociated";
  level: "handoff" | "restart" | null;
  observation?: ContextObservation;
  activity?: HarnessActivity;
  startupFailure?: HarnessActivity;
  activity_status?: HarnessActivityStatus;
  activity_diagnostic?: string;
  activity_updated_at?: string | null;
  activity_source?: string | null;
  activity_error?: HarnessActivity["error"];
}

export type ResolveActivityExecution = (
  ref: RuntimeRef,
  project: ProjectId,
) => ExecutionConfig | undefined | Promise<ExecutionConfig | undefined>;

async function workerPaths(
  a: Assignment,
  project: ProjectId,
  resolver?: ResolveActivityExecution,
) {
  const ref = a.runtime_ref;
  if (!ref?.target || ref.machine_id !== a.machine_id || !ref.launch_generation)
    return;
  const execution = await resolver?.(ref, project);
  if (execution?.mode !== "agent-ssh" || !runtimeOwnsRef(execution, ref))
    return;
  const identity = {
    project,
    assignment: a.id,
    run: ref.launch_generation.run_id,
    generation: ref.launch_generation.generation,
    target: ref.target.fingerprint,
  };
  return {
    execution,
    root: workerSessionPath(execution, identity),
    cwd: workerLaunchPath(execution, identity).value,
  };
}

/**
 * Index events and Runs by assignment once per pass. Generation and activity
 * checks only read events whose payload names the assignment and that
 * assignment's Runs, so each scoped state yields the same answers as the full
 * state without rescanning project history for every active assignment.
 */
export function assignmentActivityScope(state: CommandState) {
  const events = new Map<string, Event[]>();
  for (const e of state.events) {
    const id = (e.payload as { assignment_id?: unknown } | null)?.assignment_id;
    if (typeof id !== "string") continue;
    const list = events.get(id);
    if (list) list.push(e);
    else events.set(id, [e]);
  }
  const runs = new Map<string, Run[]>();
  for (const r of state.runs) {
    const list = runs.get(r.assignment_id);
    if (list) list.push(r);
    else runs.set(r.assignment_id, [r]);
  }
  const scoped = new Map<string, CommandState>();
  return (a: Pick<Assignment, "id">): CommandState => {
    let view = scoped.get(a.id);
    if (!view) {
      view = {
        ...state,
        events: events.get(a.id) ?? [],
        runs: runs.get(a.id) ?? [],
      };
      scoped.set(a.id, view);
    }
    return view;
  };
}

export async function readSessionContexts(
  state: CommandState,
  options: ContextUsageOptions | undefined,
  now: string,
  projectCwd?: string | null,
  resolveWorker?: ResolveActivityExecution,
): Promise<SessionContextDiagnostic[]> {
  const shared = (await caches(options?.cacheDir)).filter(measured);
  const consumed = new Set<ContextUsage>();
  const result: SessionContextDiagnostic[] = [];
  const active = state.assignments.filter((a) => a.status === "active");
  const staleMs = options?.staleAfterMs ?? DEFAULT_CONTEXT_STALE_AFTER_MS;
  const scope = assignmentActivityScope(state);
  for (const a of active) {
    if (options?.signal?.aborted) break;
    const own = scope(a);
    const remote = !!a.machine_id && a.machine_id !== "local";
    const run = own.runs.at(-1);
    const boundPaths = () =>
      workerPaths(a, state.project_id, resolveWorker).catch(() => undefined);
    const worker =
      remote && options && !a.external && run?.harness === "claude-code"
        ? await boundPaths()
        : undefined;
    const execution = remote ? worker?.execution : options?.execution;
    const root =
      worker?.root ??
      (!remote && execution
        ? executionPaths(execution, state.project_id, a.id).runDir
        : undefined);
    const cwd =
      a.worktree_path ??
      a.runtime_ref?.worktree_path ??
      (a.external ? projectCwd : (worker?.cwd ?? root));
    const session = a.runtime_ref?.agent_session_id ?? a.session_ref;
    const matches = shared.filter(
      (v) =>
        !remote &&
        v.agent === "claude" &&
        cwd &&
        resolve(v.cwd) === resolve(cwd) &&
        (!session || v.session_id === session),
    );
    const uniqueExternal =
      !a.external ||
      active.filter(
        (other) =>
          other.external && (other.worktree_path ?? projectCwd) === cwd,
      ).length === 1;
    let usage: ContextSample | undefined;
    let progress: ActivityMetadata | undefined;
    let startupMetadata: ActivityMetadata | undefined;
    let activityMetadata: ActivityMetadata | undefined;
    let fileMetadata: ActivityMetadata | undefined;
    let pending: ContextReading["foreground"];
    let activityReadFailed = false;
    const readFailed = () => {
      activityReadFailed = true;
    };
    let source: string | null = null;
    const harness = run?.harness;
    const adapter =
      harness && isHarness(harness) ? getHarnessAdapter(harness) : undefined;
    // Pass the same trusted exact directory and (only for a worktree) child
    // prefix to the reader. A Run directory alone does not permit descendants.
    const exactCwd = cwd ? resolve(cwd) : "";
    const worktree = a.worktree_path ?? a.runtime_ref?.worktree_path;
    const childPrefix =
      exactCwd && adapter?.allowWorktreeDescendant && worktree
        ? resolve(worktree) + sep
        : "";
    const matchesCwd = (dir: string) =>
      exactCwd &&
      (resolve(dir) === exactCwd ||
        (childPrefix && resolve(dir).startsWith(childPrefix)));
    if (!a.external && execution && root && options && adapter) {
      const reading = await adapter.readContext({
        root,
        model: run?.model,
        providerEnv: () => profileEnv(options.launch, run?.launch_profile_ref),
        onReadFailure: readFailed,
        files,
        readParts,
        caches,
        readPrivateTranscript: () =>
          privateTranscript(
            execution,
            root,
            session,
            [
              String(
                Math.max(
                  contextGenerationStart(a, own.events),
                  Date.parse(run?.started_at ?? a.created_at),
                ),
              ),
              exactCwd,
              childPrefix,
            ],
            readFailed,
            options.signal,
          ),
      });
      // A target may have been replaced while its SSH read was in flight.
      if (reading && (!worker || (await boundPaths())?.root === worker.root)) {
        usage = reading.usage;
        fileMetadata = reading.fileActivity;
        pending = reading.foreground;
        activityMetadata = reading.activity;
        progress = reading.progress;
        startupMetadata = reading.startupFailure;
      }
      source = adapter.contextSource;
    }
    if (
      !usage &&
      (a.external || adapter?.useStatuslineCache) &&
      uniqueExternal &&
      (session
        ? matches.length === 1
        : matches.filter((v) => contextUsageFresh(v, now, staleMs)).length ===
          1)
    ) {
      usage = session
        ? matches[0]
        : matches.find((v) => contextUsageFresh(v, now, staleMs));
      source = "claude_statusline_cache";
      if (usage && measured(usage)) consumed.add(usage);
    }
    const bindActivity = (
      metadata: ActivityMetadata | undefined,
      progress?: ActivityMetadata,
    ): HarnessActivity | undefined =>
      metadata && run && source && matchesCwd(metadata.cwd)
        ? {
            assignment_id: a.id,
            runtime_key: JSON.stringify(a.runtime_ref),
            run_id: run.id,
            session_id: metadata.session_id,
            updated_at: metadata.updated_at,
            ...(metadata.model_output_at
              ? { model_output_at: metadata.model_output_at }
              : {}),
            ...(metadata.error &&
            progress &&
            progress.session_id === metadata.session_id &&
            matchesCwd(progress.cwd)
              ? { last_progress_at: progress.updated_at }
              : {}),
            ...(metadata.model_silent_since !== undefined
              ? { model_silent_since: metadata.model_silent_since }
              : {}),
            ...(metadata.turn_ended ? { turn_ended: true as const } : {}),
            stale_after_ms: staleMs,
            source: `${harness}:session_metadata`,
            ...(metadata.error ? { error: metadata.error } : {}),
          }
        : undefined;
    const activity = bindActivity(activityMetadata, progress);
    const file = bindActivity(fileMetadata);
    const fileActivity =
      file &&
      (!activity?.error || harness === "claude-code") &&
      !activityReadFailed
        ? { ...file, source: `${harness}:transcript_mtime` }
        : undefined;
    // Bind the command's own start, not merely some other activity in the file.
    const start = associatedHarnessActivity(
      own,
      a,
      now,
      bindActivity(pending?.start),
    );
    const foreground =
      pending &&
      start &&
      !activityReadFailed &&
      [activity, fileActivity].some(
        (sample) => sample?.session_id === start.session_id,
      )
        ? { command: pending.command, since: start.updated_at }
        : undefined;
    const startupFailure = bindActivity(startupMetadata);
    const activityFresh = !!currentHarnessActivity(own, a, now, activity);
    const activityStatus: HarnessActivityStatus = activityReadFailed
      ? "read_failed"
      : !run || !a.runtime_ref || a.external || !root || !source
        ? "unassociated"
        : !activityMetadata
          ? "missing"
          : !activity ||
              !contextObservationCurrent(a, activity, own.events) ||
              Date.parse(activity.updated_at) <
                Date.parse(run.started_at ?? a.created_at)
            ? "unassociated"
            : activityFresh
              ? "fresh"
              : "stale";
    const observation =
      usage && measured(usage) && source
        ? {
            ...usage,
            assignment_id: a.id,
            runtime_key: JSON.stringify(a.runtime_ref),
            source,
          }
        : undefined;
    const fresh =
      !!observation &&
      contextUsageFresh(observation, now, staleMs) &&
      contextObservationCurrent(a, observation, own.events);
    result.push({
      agent: usage?.agent ?? null,
      cwd: usage?.cwd ?? null,
      model: usage?.model ?? null,
      assignment_id: a.id,
      employee_id: a.employee_id ?? null,
      employee_name:
        state.employees?.find((e) => e.id === a.employee_id)?.name ?? null,
      external: a.external === true,
      session_id: usage?.session_id ?? null,
      context_tokens: usage?.context_tokens ?? null,
      context_window_size: usage?.context_window_size ?? null,
      used_percentage: usage?.used_percentage ?? null,
      context_usage_pct: usage?.used_percentage ?? null,
      context_usage_estimated: false,
      source,
      updated_at: usage?.updated_at ?? null,
      stale: !fresh,
      status: !observation ? "missing" : fresh ? "fresh" : "stale",
      level:
        fresh && observation
          ? (contextUsageLevel(observation, projectPreferences(state)) ?? null)
          : null,
      ...(observation ? { observation } : {}),
      ...(activity ? { activity } : {}),
      ...(fileActivity ? { fileActivity } : {}),
      ...(foreground ? { foreground } : {}),
      ...(startupFailure ? { startupFailure } : {}),
      activity_updated_at: activity?.updated_at ?? null,
      activity_source: activity?.source ?? null,
      ...(activity?.error ? { activity_error: activity.error } : {}),
      activity_status: activityStatus,
      activity_diagnostic:
        activityStatus !== "fresh"
          ? `${remote && activityStatus !== "stale" ? "远程活动来源缺失" : "活动来源缺失"}：${({ missing: "没有可用记录", stale: "记录过期或时间无效", unassociated: "会话未关联", read_failed: "读取失败" } as const)[activityStatus]}；活动未知`
          : activity?.error === "unclassified"
            ? "缺少结构化上游错误类别，不读取错误正文"
            : (adapter?.activityDiagnostic ?? "会话活动元信息可用"),
    });
  }
  // Shared caches outside this project's known directories are not disclosed.
  const knownCwds = new Set(
    [projectCwd, ...active.map((a) => a.worktree_path)]
      .filter((v): v is string => !!v)
      .map((v) => resolve(v)),
  );
  for (const usage of shared.filter(
    (v) => !consumed.has(v) && knownCwds.has(resolve(v.cwd)),
  )) {
    result.push({
      agent: usage.agent,
      cwd: usage.cwd,
      model: usage.model,
      assignment_id: null,
      employee_id: null,
      employee_name: null,
      external: true,
      session_id: usage.session_id,
      context_tokens: usage.context_tokens,
      context_window_size: usage.context_window_size,
      used_percentage: usage.used_percentage,
      context_usage_pct: usage.used_percentage,
      context_usage_estimated: false,
      source: "claude_statusline_cache",
      updated_at: usage.updated_at,
      stale: !contextUsageFresh(usage, now, staleMs),
      status: "unassociated",
      level: null,
    });
  }
  return result;
}

export function contextThresholdView(state: CommandState) {
  const { handoff, restart } = contextUsageThresholds(
    projectPreferences(state),
  );
  return { handoff_remaining_pct: handoff, restart_remaining_pct: restart };
}
