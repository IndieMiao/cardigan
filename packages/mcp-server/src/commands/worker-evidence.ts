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
/** C-746: the fixed reasons a collector may give for a null field; any
 * other code is reported as `other`, never echoed. */
export const workerUnavailableReasons = [
  // terminals
  "core_socket_missing",
  "core_socket_untrusted",
  "core_not_listening",
  "core_timeout",
  "core_unreachable",
  "core_protocol",
  "core_error",
  "core_reply_incomplete",
  "core_reply_invalid",
  "permission_denied",
  "platform_unsupported",
  "terminal_not_registered",
  "terminal_unconfirmed",
  // processes
  "no_registered_process",
  "registered_process_mismatch",
  "process_identity_unreadable",
  "process_identity_changed",
  "process_unconfirmed",
  "process_attribution_incomplete",
  "terminal_unreadable",
  // events
  "harness_unknown",
  "session_not_published",
  "launch_markers_unreadable",
  "transcript_unreadable",
  // host side: the collector was not asked for live facts
  "run_not_current",
  "session_not_bound",
  "local_runtime_only",
  "other",
] as const;
export type WorkerUnavailableReason = (typeof workerUnavailableReasons)[number];
const unavailableReason = z.enum(workerUnavailableReasons).catch("other");
/** C-806: why a part of a failed launch's evidence is missing. */
export const launchUnavailableReasons = [
  ...workerUnavailableReasons,
  "harness_unsupported",
  "mcp_logs_unreadable",
] as const;
const launchUnavailable = z.enum(launchUnavailableReasons).catch("other");
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
  /** C-746: why a field above is null; bounded codes only, never messages. */
  unavailable: z
    .object({
      terminals: unavailableReason.optional(),
      processes: unavailableReason.optional(),
      events: unavailableReason.optional(),
    })
    .optional(),
  /** C-806: only when asked for a failed launch. The host redacts the text
   * again and applies the domain limits before anything is stored. */
  launch: z
    .object({
      terminal: z
        .object({
          state: z.enum(["live", "finished"]),
          exit_code: z.number().int().min(-255).max(255).optional(),
          exit_reason: z
            .string()
            .regex(/^[a-z_]{1,32}$/u)
            .optional(),
          tail: z.array(z.string().max(400)).max(20),
          resources: z
            .object({
              source: z.enum(["scope", "process"]),
              cpu_ms: z.number().int().nonnegative(),
              memory_bytes: z.number().int().nonnegative(),
              memory_peak_bytes: z.number().int().nonnegative().optional(),
              elapsed_ms: z.number().int().nonnegative(),
            })
            .nullable()
            .optional(),
        })
        .nullable(),
      mcp: z
        .array(
          z.object({
            name: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/u),
            status: z.enum(["connected", "failed", "pending"]),
            transport: z
              .string()
              .regex(/^[a-z-]{1,16}$/u)
              .optional(),
            elapsed_ms: z.number().int().nonnegative().optional(),
            error: z.string().max(400).optional(),
          }),
        )
        .max(8)
        .nullable(),
      unavailable: z.object({
        terminal: launchUnavailable.optional(),
        mcp: launchUnavailable.optional(),
        resources: launchUnavailable.optional(),
      }),
    })
    .optional(),
});
/** C-806: a failed launch's evidence as the collector reports it. */
export type WorkerLaunchEvidence = NonNullable<
  z.infer<typeof workerEvidence>["launch"]
>;
