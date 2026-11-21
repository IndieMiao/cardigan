import { z } from "zod";

// Treat the transport reply as untrusted. Never return extra properties or
// a worker-controlled string (including the error text from a schema failure).
const statusLine = z.enum([
  "",
  "[redacted]",
  "working",
  "idle",
  "blocked",
  "done",
  "error",
  "thinking",
  "waiting for input",
  "reconnecting",
  "would you like to run the following command?",
]);
const instant =
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/u;
export const workerEvidence = z.object({
  terminals: z
    .array(
      z.object({
        address: z
          .string()
          .max(13)
          .regex(/^t[0-9a-z]+$/u),
        state: z.enum(["live", "finished"]),
        activity: z
          .enum(["working", "idle", "done", "error", "blocked"])
          .nullable(),
        screen: z.array(statusLine).max(12),
      }),
    )
    .max(4)
    .nullable(),
  processes: z
    .array(
      z.object({
        pid: z.number().int().positive(),
        elapsed: z
          .string()
          .max(18)
          .regex(/^(?:\d+-)?(?:\d+:)?\d+:\d\d$/u),
        cpu: z.number().nonnegative(),
        command: z
          .string()
          .max(100)
          .regex(
            /^(?:codex|claude|pi|node|sh|bash|zsh|python3|git|pnpm|\[redacted\])(?: (?:exec|resume|--model|--json|-c|\[redacted\])){0,4}$/u,
          ),
      }),
    )
    .max(9)
    .nullable(),
  events: z
    .array(
      z.object({
        type: z.enum([
          "session_meta",
          "turn_context",
          "response_item",
          "event_msg",
          "assistant",
          "user",
          "system",
          "result",
          "summary",
          "progress",
          "session",
          "message",
          "model_change",
          "thinking_level_change",
          "compaction",
          "other",
        ]),
        time: z.string().max(40).regex(instant),
      }),
    )
    .max(8)
    .nullable(),
  markers: z
    .array(
      z.enum([
        "identity",
        "receiving",
        "published",
        "start",
        "running",
        "revoked",
      ]),
    )
    .max(6)
    .nullable(),
  helpers: z
    .array(
      z
        .string()
        .length(64)
        .regex(/^[a-f0-9]+$/u)
        .nullable(),
    )
    .length(3),
  free_bytes: z.number().int().nonnegative(),
});
