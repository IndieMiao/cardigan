import type { ProbeInput } from "@cardigan/domain";
import { z } from "zod";
import { ToolError } from "../errors.js";
import { defineTool, type ToolContext } from "./types.js";

export interface ProbeToolOptions {
  readonly probeHost?: {
    execute(context: ToolContext, input: ProbeInput): Promise<unknown>;
  };
}
export function runProbeTool(options: ProbeToolOptions) {
  return defineTool({
    name: "run_probe",
    description:
      "Run a configured sandbox probe for your current task. No commands, paths, credentials or external run IDs are accepted. Poll status for host-generated evidence and cleanup confirmation.",
    input: z
      .object({
        probe: z.enum(["github", "config"]),
        operation: z.enum(["smoke", "status", "cancel", "cleanup"]),
        parameters: z
          .object({ probe_run_id: z.string().regex(/^[a-f0-9]{32}$/u) })
          .strict()
          .optional(),
        idempotency_key: z.string().min(1).max(128),
      })
      .strict(),
    handler: async (input, context) => {
      if (!options.probeHost)
        throw new ToolError("illegal_transition", "集成探针未配置");
      try {
        return await options.probeHost.execute(context, input);
      } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError(
          "validation_failed",
          "探针请求失败，请核对当前身份、主机配置及任务状态",
        );
      }
    },
  });
}
