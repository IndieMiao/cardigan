import {
  type ContextUsage,
  type HarnessActivity,
  isAgentBinary,
} from "@cardigan/domain";

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export function json(line: string): Record<string, unknown> | undefined {
  try {
    return object(JSON.parse(line));
  } catch {
    return undefined;
  }
}
export type ContextSample = Omit<
  ContextUsage,
  "context_tokens" | "context_window_size" | "used_percentage"
> & {
  context_tokens: number | null;
  context_window_size: number | null;
  used_percentage: number | null;
};
export function measured(sample: ContextSample): sample is ContextUsage {
  return (
    sample.context_tokens !== null &&
    sample.context_window_size !== null &&
    sample.used_percentage !== null
  );
}
export function parseContextSample(value: unknown): ContextSample | undefined {
  const v = object(value);
  if (
    !v ||
    !isAgentBinary(v.agent) ||
    typeof v.session_id !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(v.session_id) ||
    typeof v.cwd !== "string" ||
    !v.cwd.startsWith("/") ||
    typeof v.updated_at !== "string" ||
    !Number.isFinite(Date.parse(v.updated_at))
  )
    return undefined;
  const metadata = {
    agent: v.agent,
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

export interface ActivityMetadata {
  session_id: string;
  cwd: string;
  updated_at: string;
  model_silent_since?: number;
  turn_ended?: true;
  error?: HarnessActivity["error"];
}
export function parseActivityMetadata(
  value: unknown,
): ActivityMetadata | undefined {
  const v = object(value);
  if (
    !v ||
    typeof v.session_id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(v.session_id) ||
    typeof v.cwd !== "string" ||
    !v.cwd.startsWith("/") ||
    v.cwd.length > 4096 ||
    typeof v.updated_at !== "string" ||
    !Number.isFinite(Date.parse(v.updated_at)) ||
    (v.error !== undefined &&
      ![
        "rate_limit",
        "server_error",
        "stream_disconnected",
        "unclassified",
      ].includes(String(v.error)))
  )
    return;
  return {
    session_id: v.session_id,
    cwd: v.cwd,
    updated_at: v.updated_at,
    ...(typeof v.model_silent_since === "number" &&
    Number.isSafeInteger(v.model_silent_since) &&
    v.model_silent_since >= 0
      ? { model_silent_since: v.model_silent_since }
      : {}),
    ...(v.turn_ended === true && !v.error ? { turn_ended: true as const } : {}),
    ...(v.error ? { error: v.error as HarnessActivity["error"] } : {}),
  };
}
export function records(tail: string, start: number) {
  const lines = tail.split("\n");
  if (start) lines.shift();
  return lines.slice(-256).map(json);
}

/** Bounded readers supplied by the host; adapters never choose a process or SSH target. */
export interface ContextReadInput {
  root: string;
  model: string | undefined;
  providerEnv: () => Readonly<Record<string, string>> | undefined;
  onReadFailure: () => void;
  files(
    root: string,
    suffix: string,
    depth?: number,
    onFailure?: () => void,
  ): Promise<string[]>;
  readParts(
    path: string,
  ): Promise<{ head: string; tail: string; tailStart: number } | undefined>;
  caches(root: string): Promise<ContextSample[]>;
  readPrivateTranscript(): Promise<string | undefined>;
}
export interface ContextReading {
  usage?: ContextSample | undefined;
  activity?: ActivityMetadata | undefined;
  progress?: ActivityMetadata | undefined;
}
