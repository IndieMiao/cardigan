import {
  IMAGE_BACKGROUNDS,
  IMAGE_GENERATION_MAX_PROMPT,
  IMAGE_GENERATION_MAX_REFERENCES,
  IMAGE_QUALITIES,
  IMAGE_SIZE,
  type ImageBackground,
  type ImageQuality,
} from "@cardigan/domain";
import { z } from "zod";
import { ERROR_CODES, ToolError } from "../errors.js";
import { defineTool, type ToolContext } from "./types.js";

export interface GenerateImageInput {
  readonly prompt: string;
  readonly reference_attachments?: readonly string[] | undefined;
  readonly model?: string | undefined;
  readonly size?: string | undefined;
  readonly quality?: ImageQuality | undefined;
  readonly n?: number | undefined;
  readonly background?: ImageBackground | undefined;
  readonly idempotency_key: string;
}
export interface GenerateImageToolOptions {
  readonly imageGenerator?: {
    execute(context: ToolContext, input: GenerateImageInput): Promise<unknown>;
  };
}
/** C-734: the host calls the provider; the credential never reaches the Agent. */
export function generateImageTool(options: GenerateImageToolOptions) {
  return defineTool({
    name: "generate_image",
    description:
      "Generate images on the host with the project's configured image provider; the credential stays on the host. Pass reference_attachments (image attachment IDs of this card) to edit from references. The images, prompt.txt and provenance.json are attached to this card and their attachment IDs returned. If the result is not ready within the wait window the status is running: call again with the same idempotency_key to read it (never re-billed). Failed paid requests are not retried automatically.",
    input: z
      .object({
        prompt: z.string().min(1).max(IMAGE_GENERATION_MAX_PROMPT),
        reference_attachments: z
          .array(z.string().min(1).max(64))
          .max(IMAGE_GENERATION_MAX_REFERENCES)
          .optional(),
        model: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u)
          .optional(),
        size: z.string().regex(IMAGE_SIZE).optional(),
        quality: z.enum(IMAGE_QUALITIES).optional(),
        n: z.number().int().min(1).max(10).optional(),
        background: z.enum(IMAGE_BACKGROUNDS).optional(),
        idempotency_key: z.string().min(1).max(128),
      })
      .strict(),
    handler: async (input, context) => {
      if (!options.imageGenerator)
        throw new ToolError("illegal_transition", "本主机未配置生图");
      try {
        return await options.imageGenerator.execute(context, input);
      } catch (error) {
        if (error instanceof ToolError) throw error;
        const refusal = error as { code?: unknown; message?: unknown };
        if (
          typeof refusal?.message === "string" &&
          (ERROR_CODES as readonly unknown[]).includes(refusal.code)
        )
          throw new ToolError(
            refusal.code as ToolError["code"],
            refusal.message,
          );
        // Never relay raw errors: they may carry host paths or provider data.
        throw new ToolError(
          "validation_failed",
          "生图请求失败，请核对当前身份、卡片状态和主机配置",
        );
      }
    },
  });
}
