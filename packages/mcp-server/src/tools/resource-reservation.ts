import type { Actor } from "@cardigan/domain";
import { z } from "zod";
import { ToolError } from "../errors.js";
import { defineTool } from "./types.js";
export interface ReservationOptions {
  reserveResource?: (
    actor: Actor,
    input: {
      machine: string;
      resource: string;
      starts_at: string;
      ends_at: string;
      idempotency_key: string;
    },
    revalidate: () => void,
  ) => Promise<string>;
}
export function reservationTool(options: ReservationOptions) {
  return defineTool({
    name: "reserve_machine_resource",
    description:
      "Reserve a host-authorized resource window for the current project. Times must include a timezone.",
    input: z
      .object({
        machine: z.string().min(1).max(200),
        resource: z.string().min(1).max(100),
        starts_at: z.string().max(48),
        ends_at: z.string().max(48),
        idempotency_key: z.string().min(1).max(128),
      })
      .strict(),
    handler: async (input, context) => {
      if (!options.reserveResource || !context.revalidateToken)
        throw new ToolError("forbidden_tool", "资源预约未开放");
      try {
        return {
          generation: await options.reserveResource(
            context.identity.actor,
            input,
            context.revalidateToken,
          ),
        };
      } catch {
        throw new ToolError(
          "validation_failed",
          "预约未生效：请核对项目授权、绝对时段、冲突及目标状态",
        );
      }
    },
  });
}
