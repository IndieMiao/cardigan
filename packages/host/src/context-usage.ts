import { constants } from "node:fs";
import { type FileHandle, lstat, open, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  type Assignment,
  type CommandState,
  type ContextObservation,
  type ContextUsage,
  contextObservationCurrent,
  contextUsageFresh,
  contextUsageLevel,
  contextUsageThresholds,
  projectPreferences,
} from "@cardigan/domain";
import { type ExecutionConfig, executionPaths } from "@cardigan/runtime-herdr";

export interface ContextUsageOptions {
  execution: ExecutionConfig;
  /** Existing Claude status-line cache; optional when not installed. */
  cacheDir?: string;
  staleAfterMs?: number;
}
export const DEFAULT_CONTEXT_STALE_AFTER_MS = 10 * 60_000;
const TAIL_BYTES = 4 * 1024 * 1024;
const HEAD_BYTES = 64 * 1024;

// The host reads Agent-writable trees. Pin every ancestor so a directory swap
// cannot redirect a read into host-private files between lstat and open.
async function directory(path: string): Promise<FileHandle> {
  if (process.platform !== "linux")
    throw new Error(
      "Context cache reader requires pinned directory descriptors",
    );
  const flags =
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let current = await open("/", flags);
  try {
    for (const part of resolve(path).split("/").filter(Boolean)) {
      const next = await open(`/proc/self/fd/${current.fd}/${part}`, flags);
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close();
    throw error;
  }
}

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

/** Never read a cache-provided transcript path or follow directory/file symlinks. */
async function files(
  root: string,
  suffix: string,
  depth = 0,
): Promise<string[]> {
  let dir: FileHandle | undefined;
  try {
    if (depth > 4) return [];
    dir = await directory(root);
    const entries = await readdir(`/proc/self/fd/${dir.fd}`, {
      withFileTypes: true,
    });
    if (entries.length > 2048) return [];
    const result: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory())
        result.push(
          ...(await files(join(root, entry.name), suffix, depth + 1)),
        );
      else if (entry.isFile() && entry.name.endsWith(suffix))
        result.push(join(root, entry.name));
      if (result.length > 4096) return [];
    }
    return result;
  } catch {
    return [];
  } finally {
    await dir?.close();
  }
}
async function readParts(path: string, cache = false) {
  const dir = await directory(dirname(path));
  let file: FileHandle | undefined;
  try {
    file = await open(
      `/proc/self/fd/${dir.fd}/${basename(path)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await file.stat();
    if (!stat.isFile() || (cache && stat.size > HEAD_BYTES)) return undefined;
    const start = Buffer.alloc(Math.min(stat.size, HEAD_BYTES));
    const head = await file.read(start, 0, start.length, 0);
    const tailStart = Math.max(0, stat.size - TAIL_BYTES);
    const end = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
    const tail = await file.read(end, 0, end.length, tailStart);
    return {
      head: start.subarray(0, head.bytesRead).toString("utf8"),
      tail: end.subarray(0, tail.bytesRead).toString("utf8"),
      tailStart,
      mtime: stat.mtimeMs,
    };
  } finally {
    await file?.close();
    await dir.close();
  }
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
async function codex(root: string): Promise<ContextUsage | undefined> {
  // Rollout names contain creation timestamps. An older file receiving a late
  // write must not take precedence over a newly opened, as-yet-empty session.
  const paths = (await files(join(root, "codex", "sessions"), ".jsonl"))
    .filter((p) => /\/rollout-[^/]+\.jsonl$/.test(p))
    .sort()
    .reverse();
  const latest = paths[0];
  if (!latest) return undefined;
  try {
    const parts = await readParts(latest);
    return parts
      ? parseCodexContext(parts.head, parts.tail, latest, parts.tailStart)
      : undefined;
  } catch {
    return undefined;
  }
}
/** Claude Code session ids are UUIDs; anything else never selects a file. */
const CLAUDE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CLAUDE_MAX_CANDIDATES = 256;
/** Only an explicit launch suffix declares the window; no guessing from names. */
export function claudeContextWindow(
  model: string | null | undefined,
): number | null {
  return model && /\[1m\]$/i.test(model) ? 1_000_000 : null;
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
/** Main-session transcripts sit directly in claude/projects/<slug>/. */
async function claudeTranscripts(
  root: string,
): Promise<{ path: string; name: string; mtime: number }[]> {
  const projects = join(root, "claude", "projects");
  const result: { path: string; name: string; mtime: number }[] = [];
  for (const slug of await entries(projects)) {
    if (!slug.isDirectory()) continue;
    const dir = join(projects, slug.name);
    let handle: FileHandle | undefined;
    try {
      handle = await directory(dir);
      const list = await readdir(`/proc/self/fd/${handle.fd}`, {
        withFileTypes: true,
      });
      if (list.length > 2048) continue;
      for (const entry of list) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        // lstat through the pinned descriptor never follows the final link.
        const stat = await lstat(`/proc/self/fd/${handle.fd}/${entry.name}`);
        if (!stat.isFile()) continue;
        result.push({
          path: join(dir, entry.name),
          name: entry.name,
          mtime: stat.mtimeMs,
        });
        if (result.length > CLAUDE_MAX_CANDIDATES) return [];
      }
    } catch {
      /* Unreadable or swapped directory: skip it. */
    } finally {
      await handle?.close();
    }
  }
  return result;
}
async function entries(path: string) {
  let dir: FileHandle | undefined;
  try {
    dir = await directory(path);
    const list = await readdir(`/proc/self/fd/${dir.fd}`, {
      withFileTypes: true,
    });
    return list.length > 2048 ? [] : list;
  } catch {
    return [];
  } finally {
    await dir?.close();
  }
}
async function claude(
  root: string,
  session: string | undefined,
  model: string | null | undefined,
): Promise<ContextSample | undefined> {
  const candidates = await claudeTranscripts(root);
  const wanted =
    session && CLAUDE_SESSION_ID.test(session) ? `${session}.jsonl` : null;
  const chosen =
    candidates.find((c) => c.name === wanted) ??
    candidates.sort(
      (a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1),
    )[0];
  if (!chosen) return undefined;
  try {
    const parts = await readParts(chosen.path);
    return parts
      ? parseClaudeTranscript(
          parts.tail,
          chosen.path,
          claudeContextWindow(model),
          parts.tailStart,
        )
      : undefined;
  } catch {
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
    let source: string | null = null;
    const run = [...state.runs].reverse().find((r) => r.assignment_id === a.id);
    const harness = run?.harness;
    if (!a.external && root) {
      if (harness === "codex") {
        usage = await codex(root);
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
        source = "pi_turn_end:getContextUsage";
      }
      if (harness === "claude-code") {
        usage = await claude(root, session, run?.model);
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
