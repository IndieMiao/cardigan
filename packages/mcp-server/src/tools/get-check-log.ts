import { type CardId, checkLogAttempts } from "@cardigan/domain";
import { z } from "zod";
import type { McpReadContext } from "../backend.js";
import { ToolError } from "../errors.js";
import { defineTool, type ToolContext } from "./types.js";

export interface CheckLogOptions {
  /** Host-owned reader of already-redacted private logs. No caller paths. */
  readonly checkLogReader?: (input: {
    project_id: string;
    attempt_id: string;
    offset: number;
    limit: number;
  }) => Promise<{ text: string; next_offset: number; size: number }>;
  readonly checkLogLimits?: {
    readonly per_read_bytes: number;
    readonly per_assignment_attempt_bytes: number;
  };
}

/** Also used to gate get_card's attempt list; standing PMs never inherit access. */
export function authorizeCheckLog(
  tx: McpReadContext,
  context: ToolContext,
  card: CardId,
) {
  const { identity } = context;
  const project = identity.actor.project_id;
  const assignment = tx.assignments.get(project, identity.actor.assignment_id);
  if (
    assignment?.status !== "active" ||
    assignment.scope !== "work_item" ||
    assignment.role_id === "host_ops" ||
    assignment.role_version !== identity.token.role_version
  )
    throw new ToolError("unauthorized", "当前指派无权读取检查日志。");
  const item = tx.work_items.get(project, assignment.work_item_id);
  if (
    !item ||
    item.card_id !== card ||
    (item.kind !== "produce" && item.kind !== "verify") ||
    item.assignment_id !== assignment.id ||
    item.status === "cancelled" ||
    !tx.cards.get(project, card)
  )
    throw ToolError.notFound("检查日志不存在或无权读取。");
  return checkLogAttempts(tx.events.listAfter(project, card, 0), card);
}

const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
export function getCheckLogTool(options: CheckLogOptions) {
  const limits = options.checkLogLimits ?? {
    per_read_bytes: 64 * 1024,
    per_assignment_attempt_bytes: 1024 * 1024,
  };
  if (
    !positive(limits.per_read_bytes) ||
    !positive(limits.per_assignment_attempt_bytes)
  )
    throw new Error("Invalid check log limits");
  return defineTool({
    name: "get_check_log",
    description:
      "Read this card's redacted check log by byte offset; repeated reads consume a persistent per-Assignment attempt budget (default 64 KiB/read, 1 MiB total).",
    input: z
      .object({
        card_id: z.string().min(1),
        attempt_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u),
        offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        limit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
      })
      .strict(),
    handler: async ({ card_id, attempt_id, offset = 0, limit }, context) => {
      const { store, identity } = context;
      const card = card_id as CardId;
      const authorize = (tx: McpReadContext) => {
        context.revalidateToken?.();
        const attempts = authorizeCheckLog(tx, context, card);
        if (!attempts.some((a) => a.attempt_id === attempt_id))
          throw ToolError.notFound("检查日志不存在或无权读取。");
      };
      store.uow.read(authorize);
      if (!options.checkLogReader || !store.withCheckLogBudget)
        throw ToolError.validation("检查日志读取未配置。");
      const requested = limit ?? limits.per_read_bytes;
      const readLimit = Math.min(requested, limits.per_read_bytes);
      let page: Awaited<
        ReturnType<NonNullable<CheckLogOptions["checkLogReader"]>>
      >;
      try {
        page = await options.checkLogReader({
          project_id: identity.actor.project_id,
          attempt_id,
          offset,
          limit: readLimit,
        });
      } catch {
        // Never pass a filesystem exception (and its private path) to the MCP error mapper.
        throw ToolError.notFound("检查日志不存在、已清理或不可安全读取。");
      }
      return store.withCheckLogBudget(
        {
          project_id: identity.actor.project_id,
          card_id: card,
          attempt_id,
          assignment_id: identity.actor.assignment_id,
        },
        limits.per_assignment_attempt_bytes,
        (remaining, tx) => {
          authorize(tx);
          if (remaining === 0)
            throw ToolError.validation("本指派对该检查的日志读取额度已耗尽。");
          const bytes = Buffer.from(page.text, "utf8");
          let end = Math.min(bytes.length, readLimit, remaining);
          while (
            end > 0 &&
            end < bytes.length &&
            ((bytes[end] ?? 0) & 0xc0) === 0x80
          )
            end--;
          const text = bytes.subarray(0, end).toString("utf8");
          const next =
            end === bytes.length
              ? page.next_offset
              : page.next_offset - (bytes.length - end);
          return {
            bytes: end,
            value: {
              card_id,
              attempt_id,
              offset,
              text,
              bytes: end,
              next_offset: next,
              truncated:
                next < page.size || requested > readLimit || end < bytes.length,
              eof: next >= page.size,
              remaining_bytes: remaining - end,
            },
          };
        },
      );
    },
  });
}
