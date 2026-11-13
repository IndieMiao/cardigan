import {
  PLAIN_SUMMARY_LIMITS,
  parseId,
  parseTimelineEntryId,
  type ReadableIdKind,
} from "@cardigan/domain";
import { z } from "zod";
import { unwrap } from "./execute.js";

export const id = <K extends ReadableIdKind>(kind: K) =>
  z
    .string()
    .refine((s) => parseId(kind, s).ok, `Invalid ${kind} ID`)
    .transform((s) => unwrap(parseId(kind, s)).id);
export const entryId = z
  .string()
  .refine((s) => parseTimelineEntryId(s).ok, "Invalid timeline entry ID")
  .transform((s) => unwrap(parseTimelineEntryId(s)).id);
export const idempotency_key = z
  .string()
  .min(1)
  .max(200)
  .refine((key) => key.trim().length > 0, "Idempotency key must not be blank");
/**
 * C-202: plain-language summary ("人话概述"). Lengths and the jargon rules
 * are enforced by the domain so every path gives the same plain error.
 */
export const plainSummary = z.object({
  changed: z
    .string()
    .describe(
      `改了什么：一两句白话，最多 ${PLAIN_SUMMARY_LIMITS.changed} 字；不写交付号、审核号、提交号、接口名、英文枚举`,
    ),
  impact: z
    .string()
    .describe(
      `对人或系统行为的影响（开关默认状态等），最多 ${PLAIN_SUMMARY_LIMITS.impact} 字`,
    ),
  risk: z
    .string()
    .describe(
      `是否放宽权限、花钱、对外发布、删除数据、改角色规则；没有就写“无”，最多 ${PLAIN_SUMMARY_LIMITS.risk} 字`,
    ),
});
