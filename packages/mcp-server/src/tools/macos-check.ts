import { MACOS_CHECK_MAX_FILES } from "@cardigan/domain";
import { z } from "zod";
import { ERROR_CODES, ToolError } from "../errors.js";
import { defineTool, type ToolContext } from "./types.js";

export interface MacosCheckToolOptions {
  readonly macosCheckHost?: {
    execute(
      context: ToolContext,
      input: {
        readonly test_files: readonly string[];
        readonly idempotency_key: string;
      },
    ): Promise<unknown>;
  };
}
export function macosCheckTool(options: MacosCheckToolOptions) {
  return defineTool({
    name: "request_macos_check",
    description:
      "As this card's author or a reviewer targeting its producer, run the given repository test files on a standard GitHub-hosted macOS arm64 runner against the current delivery merged onto the baseline. The result (macOS version and arch, hc version, per-file counts, real hc cases, exit code, step timings) is posted to the card timeline with a JSON attachment. Re-requests are allowed up to the host limit per delivery head.",
    input: z
      .object({
        test_files: z
          .array(z.string().min(1).max(200))
          .min(1)
          .max(MACOS_CHECK_MAX_FILES),
        idempotency_key: z.string().min(1).max(128),
      })
      .strict(),
    handler: async (input, context) => {
      if (!options.macosCheckHost)
        throw new ToolError("illegal_transition", "macOS 检查执行器未配置");
      try {
        return await options.macosCheckHost.execute(context, input);
      } catch (error) {
        if (error instanceof ToolError) throw error;
        // Domain refusals (identity, delivery, card state) keep their reason.
        const refusal = error as { code?: unknown; message?: unknown };
        if (
          typeof refusal?.message === "string" &&
          (ERROR_CODES as readonly unknown[]).includes(refusal.code)
        )
          throw new ToolError(
            refusal.code as ToolError["code"],
            refusal.message,
          );
        throw new ToolError(
          "validation_failed",
          "macOS 检查请求失败，请核对当前身份、交付和主机配置",
        );
      }
    },
  });
}
