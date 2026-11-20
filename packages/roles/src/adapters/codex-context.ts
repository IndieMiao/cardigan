import { join } from "node:path";
import type { ContextUsage, HarnessActivity } from "@cardigan/domain";
import {
  type ActivityMetadata,
  type ContextReadInput,
  type ContextReading,
  json,
  object,
  parseActivityMetadata,
  parseContextCache,
  records,
} from "./context.js";
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
export async function readCodexContext({
  root,
  onReadFailure,
  files,
  readParts,
}: ContextReadInput): Promise<ContextReading | undefined> {
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
/** Only protocol enums/status codes, never error messages or response bodies. */
function codexError(info: unknown): HarnessActivity["error"] {
  if (info === "usage_limit_exceeded") return "rate_limit";
  const v = object(info);
  if (v?.stream_disconnected !== undefined || info === "stream_disconnected")
    return "stream_disconnected";
  const status = object(v?.http_connection_failed)?.http_status_code;
  return status === 429
    ? "rate_limit"
    : typeof status === "number" &&
        Number.isInteger(status) &&
        status >= 500 &&
        status <= 599
      ? "server_error"
      : "unclassified";
}
export function parseCodexActivity(
  head: string,
  tail: string,
  start = 0,
): ActivityMetadata | undefined {
  const meta = object(
    head
      .split("\n")
      .map(json)
      .find((v) => v?.type === "session_meta")?.payload,
  );
  let last: ActivityMetadata | undefined;
  for (const event of records(tail, start)) {
    const payload = object(event?.payload);
    const error = event?.type === "event_msg" && payload?.type === "error";
    if (
      !(
        event?.type === "response_item" ||
        (event?.type === "event_msg" &&
          ["token_count", "task_complete", "task_started"].includes(
            String(payload?.type),
          )) ||
        error
      )
    )
      continue;
    const sample = parseActivityMetadata({
      session_id: meta?.id,
      cwd: meta?.cwd,
      updated_at: event?.timestamp,
      ...(event?.type === "event_msg" && payload?.type === "task_complete"
        ? { turn_ended: true }
        : {}),
      ...(error ? { error: codexError(payload?.codex_error_info) } : {}),
    });
    // Regressing clocks/late older records do not become new activity.
    if (
      !sample ||
      (last && Date.parse(sample.updated_at) < Date.parse(last.updated_at))
    )
      return;
    last = sample;
  }
  return last;
}
