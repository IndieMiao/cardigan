import { execFile } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  type Assignment,
  type CommandState,
  type ContextObservation,
  type ContextUsage,
  contextObservationCurrent,
  contextUsageFresh,
  contextUsageLevel,
  contextUsageThresholds,
  currentHarnessActivity,
  type HarnessActivity,
  projectPreferences,
} from "@cardigan/domain";
import { type LaunchConfig, resolveProfile } from "@cardigan/roles";
import {
  AGENT_PATH,
  agentProcessCommand,
  type ExecutionConfig,
  executionPaths,
} from "@cardigan/runtime-herdr";
import { CLAUDE_CONTEXT_READER } from "./claude-context-reader.js";
import {
  type ActivityMetadata,
  parseActivityMetadata,
  parseCodexActivity,
  readPiActivity,
} from "./session-activity.js";
import { files, readParts } from "./session-files.js";

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
const HEAD_BYTES = 64 * 1024;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function json(line: string): Record<string, unknown> | undefined {
  try {
    return object(JSON.parse(line));
  } catch {
    return undefined;
  }
}
type ContextSample = Omit<
  ContextUsage,
  "context_tokens" | "context_window_size" | "used_percentage"
> & {
  context_tokens: number | null;
  context_window_size: number | null;
  used_percentage: number | null;
};
function measured(sample: ContextSample): sample is ContextUsage {
  return (
    sample.context_tokens !== null &&
    sample.context_window_size !== null &&
    sample.used_percentage !== null
  );
}
function parseContextSample(value: unknown): ContextSample | undefined {
  const v = object(value);
  if (
    !v ||
    !["claude", "codex", "pi"].includes(String(v.agent)) ||
    typeof v.session_id !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(v.session_id) ||
    typeof v.cwd !== "string" ||
    !v.cwd.startsWith("/") ||
    typeof v.updated_at !== "string" ||
    !Number.isFinite(Date.parse(v.updated_at))
  )
    return undefined;
  const metadata = {
    agent: v.agent as ContextUsage["agent"],
    session_id: v.session_id,
    cwd: v.cwd,
    transcript_path:
      typeof v.transcript_path === "string" ? v.transcript_path : null,
    model: typeof v.model === "string" ? v.model : null,
    updated_at: v.updated_at,
  };
  if (
    v.agent === "pi" &&
    v.context_tokens === null &&
    v.context_window_size === null &&
    v.used_percentage === null
  )
    return {
      ...metadata,
      context_tokens: null,
      context_window_size: null,
      used_percentage: null,
    };
  if (
    typeof v.context_tokens !== "number" ||
    !Number.isFinite(v.context_tokens) ||
    v.context_tokens < 0 ||
    typeof v.context_window_size !== "number" ||
    !Number.isFinite(v.context_window_size) ||
    v.context_window_size <= 0
  )
    return undefined;
  const percentage =
    Math.round((v.context_tokens / v.context_window_size) * 1000) / 10;
  if (!Number.isFinite(percentage)) return undefined;
  return {
    ...metadata,
    context_tokens: v.context_tokens,
    context_window_size: v.context_window_size,
    used_percentage: percentage,
  };
}
export function parseContextCache(value: unknown): ContextUsage | undefined {
  const sample = parseContextSample(value);
  return sample && measured(sample) ? sample : undefined;
}

/** The last token_count's last_token_usage is current context; total_token_usage is cumulative. */
export function parseCodexContext(
  head: string,
  tail: string,
  path: string,
  tailStart = 0,
): ContextUsage | undefined {
  const meta = head
    .split("\n")
    .map(json)
    .find((v) => v?.type === "session_meta");
  const session = object(meta?.payload);
  const lines = tail.split("\n");
  if (tailStart) lines.shift();
  let last: Record<string, unknown> | undefined;
  let model: unknown;
  for (const line of lines) {
    const event = json(line);
    const payload = object(event?.payload);
    if (event?.type === "turn_context") model = payload?.model;
    if (event?.type === "event_msg" && payload?.type === "token_count")
      last = event;
  }
  const info = object(object(last?.payload)?.info);
  const usage = object(info?.last_token_usage);
  return parseContextCache({
    agent: "codex",
    session_id: session?.id,
    cwd: session?.cwd,
    transcript_path: path,
    model,
    context_tokens: usage?.total_tokens,
    context_window_size: info?.model_context_window,
    updated_at: last?.timestamp,
  });
}
async function codex(
  root: string,
  onReadFailure: () => void,
): Promise<
  | { usage: ContextUsage | undefined; activity: ActivityMetadata | undefined }
  | undefined
> {
  // Rollout names contain creation timestamps. An older file receiving a late
  // write must not take precedence over a newly opened, as-yet-empty session.
  let failed = false;
  const paths = (
    await files(join(root, "codex", "sessions"), ".jsonl", 0, () => {
      failed = true;
      onReadFailure();
    })
  )
    .filter((p) => /\/rollout-[^/]+\.jsonl$/.test(p))
    .sort()
    .reverse();
  const latest = paths[0];
  if (!latest || failed) return undefined;
  try {
    const parts = await readParts(latest);
    if (!parts) onReadFailure();
    return parts
      ? {
          usage: parseCodexContext(
            parts.head,
            parts.tail,
            latest,
            parts.tailStart,
          ),
          activity: parseCodexActivity(parts.head, parts.tail, parts.tailStart),
        }
      : undefined;
  } catch {
    onReadFailure();
    return undefined;
  }
}
/** Only an explicit launch suffix declares the window; no guessing from names. */
export function claudeContextWindow(
  model: string | null | undefined,
): number | null {
  return model && /\[1m\]$/i.test(model) ? 1_000_000 : null;
}
/**
 * Runs record the profile model, often a Claude Code alias such as `opus`.
 * The alias resolves through the profile's provider env (non-secret; secrets
 * live elsewhere), e.g. ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5-5[1m].
 */
export function claudeLaunchModel(
  launch: LaunchConfig | undefined,
  profileRef: string | undefined,
  model: string | undefined,
): string | undefined {
  const alias = /^(opus|sonnet|haiku|fable)$/i.exec(model ?? "")?.[1];
  if (!alias || !launch || !profileRef) return model;
  try {
    const env = resolveProfile(launch, profileRef).provider?.definition.env;
    const full = env?.[`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`];
    return typeof full === "string" && full ? full : model;
  } catch {
    return model;
  }
}
function tokenCount(value: unknown, optional = false): number | undefined {
  if (value === undefined && optional) return 0;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
/**
 * The last main-thread assistant message with usage is the current context.
 * Only numeric usage and session metadata leave this function; message text
 * and tool output are never copied.
 */
export function parseClaudeTranscript(
  tail: string,
  path: string,
  window: number | null,
  tailStart = 0,
): ContextSample | undefined {
  const lines = tail.split("\n");
  if (tailStart) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const event = json(lines[i] ?? "");
    if (event?.type !== "assistant" || event.isSidechain === true) continue;
    const message = object(event.message);
    const usage = object(message?.usage);
    if (!usage || message?.model === "<synthetic>") continue;
    const parts = [
      tokenCount(usage.input_tokens),
      tokenCount(usage.cache_creation_input_tokens, true),
      tokenCount(usage.cache_read_input_tokens, true),
      tokenCount(usage.output_tokens),
    ];
    if (parts.some((v) => v === undefined)) return undefined;
    const tokens = parts.reduce<number>((sum, v) => sum + (v ?? 0), 0);
    const sample = parseContextSample({
      agent: "claude",
      session_id: event.sessionId,
      cwd: event.cwd,
      transcript_path: path,
      model: message?.model,
      context_tokens: tokens,
      context_window_size: window ?? 1,
      updated_at: event.timestamp,
    });
    if (!sample) return undefined;
    return window === null
      ? { ...sample, context_window_size: null, used_percentage: null }
      : sample;
  }
  return undefined;
}
const capture = promisify(execFile);
async function claude(
  execution: ExecutionConfig,
  root: string,
  session: string | undefined,
  model: string | null | undefined,
  onReadFailure: () => void,
  signal?: AbortSignal,
): Promise<
  | {
      usage: ContextSample | undefined;
      activity: ActivityMetadata | undefined;
      progress: ActivityMetadata | undefined;
    }
  | undefined
> {
  try {
    // Claude creates 0700 directories and 0600 transcripts. In agent-ssh mode
    // the host cannot read them; use the existing credential-checked channel.
    // Paths come only from executionPaths, never RuntimeRef/cached metadata.
    const args = ["-e", CLAUDE_CONTEXT_READER, "--", root, session ?? ""];
    const command =
      execution.mode === "agent-ssh"
        ? await agentProcessCommand(execution, ["node", ...args])
        : { file: process.execPath, args };
    if (signal?.aborted) return undefined;
    const pending = capture(command.file, command.args, {
      encoding: "utf8",
      env: { PATH: AGENT_PATH },
      timeout: 10_000,
      killSignal: "SIGKILL",
      maxBuffer: HEAD_BYTES,
      ...(signal ? { signal } : {}),
    });
    // Abort reports an error before the child closes. Shutdown must also wait
    // for the actual process/stdio cleanup before dropping the in-flight slot.
    const closed = new Promise<void>((resolve) =>
      pending.child.once("close", () => resolve()),
    );
    try {
      const { stdout } = await pending;
      const event = json(stdout);
      if (event?.read_failed === true) {
        onReadFailure();
        return undefined;
      }
      return event && typeof event.path === "string"
        ? {
            usage: parseClaudeTranscript(
              stdout,
              event.path,
              claudeContextWindow(model),
            ),
            activity: parseActivityMetadata(event.activity),
            progress: parseActivityMetadata(object(event.activity)?.progress),
          }
        : undefined;
    } finally {
      await closed;
    }
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
export interface HarnessActivityInspection {
  activity?: HarnessActivity;
  status: HarnessActivityStatus;
}

export interface SessionContextDiagnostic {
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
  activity_status?: HarnessActivityStatus;
  activity_diagnostic?: string;
  activity_updated_at?: string | null;
  activity_source?: string | null;
  activity_error?: HarnessActivity["error"];
}

export async function readSessionContexts(
  state: CommandState,
  options: ContextUsageOptions | undefined,
  now: string,
  projectCwd?: string | null,
): Promise<SessionContextDiagnostic[]> {
  const shared = (await caches(options?.cacheDir)).filter(measured);
  const consumed = new Set<ContextUsage>();
  const result: SessionContextDiagnostic[] = [];
  const active = state.assignments.filter((a) => a.status === "active");
  const staleMs = options?.staleAfterMs ?? DEFAULT_CONTEXT_STALE_AFTER_MS;
  for (const a of active) {
    if (options?.signal?.aborted) break;
    const root = options
      ? executionPaths(options.execution, state.project_id, a.id).runDir
      : undefined;
    const cwd =
      a.worktree_path ??
      a.runtime_ref?.worktree_path ??
      (a.external ? projectCwd : root);
    const session = a.runtime_ref?.agent_session_id ?? a.session_ref;
    const matches = shared.filter(
      (v) =>
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
    let activityMetadata: ActivityMetadata | undefined;
    let activityReadFailed = false;
    const readFailed = () => {
      activityReadFailed = true;
    };
    let source: string | null = null;
    const run = [...state.runs].reverse().find((r) => r.assignment_id === a.id);
    const harness = run?.harness;
    if (!a.external && root && options) {
      if (harness === "codex") {
        const sample = await codex(root, readFailed);
        usage = sample?.usage;
        activityMetadata = sample?.activity;
        source = "codex_rollout:last_token_usage";
      }
      if (harness === "pi") {
        usage = (await caches(join(root, "pi", "context-usage")))
          .filter((v) => v.agent === "pi")
          // Select the latest sample before checking its measurements. Unknown
          // samples must suppress older valid sessions, including timestamp ties.
          .sort(
            (a, b) =>
              Date.parse(b.updated_at) - Date.parse(a.updated_at) ||
              Number(measured(a)) - Number(measured(b)),
          )[0];
        activityMetadata = await readPiActivity(root, readFailed);
        source = "pi_turn_end:getContextUsage";
      }
      if (harness === "claude-code") {
        const sample = await claude(
          options.execution,
          root,
          session,
          claudeLaunchModel(
            options?.launch,
            run?.launch_profile_ref,
            run?.model,
          ),
          readFailed,
          options.signal,
        );
        usage = sample?.usage;
        activityMetadata = sample?.activity;
        progress = sample?.progress;
        source = "claude_transcript:last_usage";
      }
    }
    if (
      !usage &&
      (a.external || harness === "claude-code") &&
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
    // Claude reports the current directory (e.g. apps/web), not necessarily
    // the launch cwd. Only its private transcript may use a worktree descendant.
    const worktree = a.worktree_path ?? a.runtime_ref?.worktree_path;
    const matchesCwd = (dir: string) =>
      cwd &&
      (resolve(dir) === resolve(cwd) ||
        (harness === "claude-code" &&
          worktree &&
          resolve(dir).startsWith(resolve(worktree) + sep)));
    const activity: HarnessActivity | undefined =
      activityMetadata && run && source && matchesCwd(activityMetadata.cwd)
        ? {
            assignment_id: a.id,
            runtime_key: JSON.stringify(a.runtime_ref),
            run_id: run.id,
            session_id: activityMetadata.session_id,
            updated_at: activityMetadata.updated_at,
            ...(activityMetadata.error &&
            progress &&
            progress.session_id === activityMetadata.session_id &&
            matchesCwd(progress.cwd)
              ? { last_progress_at: progress.updated_at }
              : {}),
            stale_after_ms: staleMs,
            source: `${harness}:session_metadata`,
            ...(activityMetadata.error
              ? { error: activityMetadata.error }
              : {}),
          }
        : undefined;
    const activityFresh = !!currentHarnessActivity(state, a, now, activity);
    const activityStatus: HarnessActivityStatus = activityReadFailed
      ? "read_failed"
      : !run || !a.runtime_ref || a.external || !root || !source
        ? "unassociated"
        : !activityMetadata
          ? "missing"
          : !activity ||
              !contextObservationCurrent(a, activity, state.events) ||
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
      contextObservationCurrent(a, observation, state.events);
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
      activity_updated_at: activity?.updated_at ?? null,
      activity_source: activity?.source ?? null,
      ...(activity?.error ? { activity_error: activity.error } : {}),
      activity_status: activityStatus,
      activity_diagnostic:
        activityStatus !== "fresh"
          ? `活动来源缺失：${({ missing: "没有可用记录", stale: "记录过期或时间无效", unassociated: "会话未关联", read_failed: "读取失败" } as const)[activityStatus]}；活动未知`
          : activity?.error === "unclassified"
            ? "缺少结构化上游错误类别，不读取错误正文"
            : harness === "pi"
              ? "会话活动可用；上游错误缺少结构化类别"
              : "会话活动元信息可用",
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
