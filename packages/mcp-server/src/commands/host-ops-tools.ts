import type {
  HostOpsExecutionTool,
  WorkerInspectionRequest,
} from "@cardigan/domain";
import { z } from "zod";
import { ToolError } from "../errors.js";
import { defineTool, type ToolContext } from "../tools/types.js";
import { id, idempotency_key } from "./schemas.js";

/** Host implementation is injected; MCP never imports host/CLI or touches terminals. */
export interface HostOpsToolOptions {
  readonly hostOps?: {
    inspectWorker(
      context: ToolContext,
      request: WorkerInspectionRequest,
    ): Promise<unknown> | unknown;
    read(context: ToolContext, project?: string): unknown;
    execute(
      context: ToolContext,
      tool: HostOpsExecutionTool | "host_ops_recheck_merge",
      params: {
        target_id: string;
        reason?: string;
        idempotency_key: string;
        context_session_id?: string;
        dispatch_stall_id?: string;
      },
    ): Promise<unknown> | unknown;
  };
}
export function hostOpsTools(options: HostOpsToolOptions = {}) {
  const host = () => {
    if (!options.hostOps)
      throw new ToolError(
        "illegal_transition",
        "Host operations are not configured",
      );
    return options.hostOps;
  };
  const reason = z.string().trim().min(1);
  return [
    defineTool({
      name: "host_ops_inspect_worker",
      description:
        "Inspect a numbered session on its registered worker, read-only. Returns bounded, redacted evidence only.",
      input: z.strictObject({
        machine_id: z
          .string()
          .max(64)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u),
        assignment_id: id("assignment"),
        run_id: id("run").optional(),
      }),
      handler: (p, c) => host().inspectWorker(c, p),
    }),
    defineTool({
      name: "host_ops_read_diagnostics",
      description: "Read project session health and pending host operations.",
      input: z.object({ project_id: z.string().min(1).optional() }),
      handler: (p, c) => host().read(c, p.project_id),
    }),
    defineTool({
      name: "host_ops_restart_assignment",
      description:
        "Request an Assignment restart; the host confirms exit before asynchronously queuing a new Run.",
      input: z.object({
        assignment_id: id("assignment"),
        dispatch_stall_id: z.string().min(1).max(200).optional(),
        context_session_id: z.string().min(1).optional(),
        reason,
        idempotency_key,
      }),
      handler: (p, c) =>
        host().execute(c, "host_ops_restart_assignment", {
          target_id: p.assignment_id,
          ...(p.dispatch_stall_id
            ? { dispatch_stall_id: p.dispatch_stall_id }
            : {}),
          ...(p.context_session_id
            ? { context_session_id: p.context_session_id }
            : {}),
          reason: p.reason,
          idempotency_key: p.idempotency_key,
        }),
    }),
    defineTool({
      name: "host_ops_cancel_run",
      description:
        "Request cancellation of a numbered Run after the host confirms terminal exit.",
      input: z.object({ run_id: id("run"), reason, idempotency_key }),
      handler: (p, c) =>
        host().execute(c, "host_ops_cancel_run", {
          target_id: p.run_id,
          reason: p.reason,
          idempotency_key: p.idempotency_key,
        }),
    }),
    defineTool({
      name: "host_ops_recheck_merge",
      description:
        "Requeue a failed or timed-out merge check for the current completion.",
      input: z.object({ card_id: id("card"), idempotency_key }),
      handler: (p, c) =>
        host().execute(c, "host_ops_recheck_merge", {
          target_id: p.card_id,
          idempotency_key: p.idempotency_key,
        }),
    }),
    defineTool({
      name: "host_ops_restart_standing_pm",
      description:
        "Request a new session for a numbered standing PM after the host confirms terminal exit.",
      input: z.object({
        assignment_id: id("assignment"),
        dispatch_stall_id: z.string().min(1).max(200).optional(),
        context_session_id: z.string().min(1).optional(),
        reason,
        idempotency_key,
      }),
      handler: (p, c) =>
        host().execute(c, "host_ops_restart_standing_pm", {
          target_id: p.assignment_id,
          ...(p.dispatch_stall_id
            ? { dispatch_stall_id: p.dispatch_stall_id }
            : {}),
          ...(p.context_session_id
            ? { context_session_id: p.context_session_id }
            : {}),
          reason: p.reason,
          idempotency_key: p.idempotency_key,
        }),
    }),
  ];
}
