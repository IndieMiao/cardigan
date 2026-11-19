import { join } from "node:path";
import type { HarnessActivity } from "@cardigan/domain";
import { files, readParts } from "./session-files.js";

export interface ActivityMetadata {
  session_id: string;
  cwd: string;
  updated_at: string;
  turn_ended?: true;
  error?: HarnessActivity["error"];
}
const object = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
function json(line: string) {
  try {
    return object(JSON.parse(line));
  } catch {
    return undefined;
  }
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
    ...(v.turn_ended === true && !v.error ? { turn_ended: true as const } : {}),
    ...(v.error ? { error: v.error as HarnessActivity["error"] } : {}),
  };
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
function records(tail: string, start: number) {
  const lines = tail.split("\n");
  if (start) lines.shift();
  return lines.slice(-256).map(json);
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
export async function readPiActivity(
  root: string,
  onReadFailure?: () => void,
): Promise<ActivityMetadata | undefined> {
  // Select by creation filename, never by a late write's mtime or cache-provided path.
  let failed = false;
  const fail = () => {
    failed = true;
    onReadFailure?.();
  };
  const path = (await files(join(root, "pi", "sessions"), ".jsonl", 0, fail))
    .sort()
    .at(-1);
  if (!path || failed) return;
  try {
    const parts = await readParts(path);
    if (!parts) {
      fail();
      return;
    }
    const meta = parts.head
      .split("\n")
      .map(json)
      .find((v) => v?.type === "session");
    let last: ActivityMetadata | undefined;
    for (const event of records(parts.tail, parts.tailStart)) {
      if (event?.type !== "message") continue;
      const message = object(event.message);
      if (!["assistant", "user", "toolResult"].includes(String(message?.role)))
        continue;
      const sample = parseActivityMetadata({
        session_id: meta?.id,
        cwd: meta?.cwd,
        updated_at: event.timestamp,
        ...(message?.stopReason === "error" ? { error: "unclassified" } : {}),
      });
      if (
        !sample ||
        (last && Date.parse(sample.updated_at) < Date.parse(last.updated_at))
      )
        return;
      last = sample;
    }
    return last;
  } catch {
    fail();
    return;
  }
}
