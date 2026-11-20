import {
  type CardId,
  checkLogAttempts,
  mergeBatchReadScope,
} from "@cardigan/domain";
import { z } from "zod";
import type { McpReadContext } from "../backend.js";
import { ToolError } from "../errors.js";
import {
  auditReferenceRead,
  referenceCard,
  safeReferenceQuery,
} from "./reference-read.js";
import { defineTool, type ToolContext } from "./types.js";

/** Expected authorization refusal, distinct from repository/program failures. */
export class CheckLogAccessError extends ToolError {
  constructor(code: "unauthorized" | "not_found") {
    super(
      code,
      code === "unauthorized"
        ? "当前指派无权读取检查日志。"
        : "检查日志不存在或无权读取。",
    );
  }
}

/** Reader-port refusal: no complete UTF-8 character fits the requested limit. */
export class CheckLogReadLimitError extends ToolError {
  constructor() {
    super(
      "validation_failed",
      "单次读取上限不足以容纳下一个完整 UTF-8 字符，请增大 limit 或联系主机管理员调整单次上限。",
      { reason: "read_limit_too_small" },
    );
  }
}

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

/** Also gates attempt metadata; reference access never bypasses sensitive-card checks. */
export function authorizeCheckLog(
  tx: McpReadContext,
  context: ToolContext,
  card: CardId,
) {
  // The request can wait for its body after entry authentication.
  try {
    context.revalidateToken?.();
  } catch {
    throw new ToolError("unauthorized", "Token 已失效。");
  }
  const project = context.identity.actor.project_id;
  try {
    if (referenceCard(tx, context, card, true).access !== "full")
      throw new CheckLogAccessError("not_found");
  } catch (error) {
    if (
      error instanceof ToolError &&
      ["not_found", "unauthorized"].includes(error.code)
    )
      throw new CheckLogAccessError(error.code as "not_found" | "unauthorized");
    throw error;
  }
  const batchEvents =
    tx.projectMergeEvents?.(project) ??
    tx.events.listAfter(project, undefined, 0);
  const events = [...tx.events.listAfter(project, card, 0), ...batchEvents];
  const scope = mergeBatchReadScope(
    {
      project_id: project,
      cards: tx.cards.list(project),
      work_items: tx.work_items.list(project),
      project_preferences: tx.project_preferences?.list(project) ?? [],
      events,
    },
    referenceCard(tx, context, card, true).assignment,
  );
  const visible = events.filter((event) => !scope.restricted(event));
  return checkLogAttempts(visible, card);
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
      "Read an accessible card's redacted check log by byte offset; repeated reads consume a persistent per-Assignment attempt budget (default 64 KiB/read, 1 MiB total).",
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
        const attempts = authorizeCheckLog(tx, context, card);
        if (!attempts.some((a) => a.attempt_id === attempt_id))
          throw new CheckLogAccessError("not_found");
      };
      safeReferenceQuery(() => store.uow.read(authorize));
      if (!options.checkLogReader || !store.withCheckLogBudget)
        throw ToolError.validation("检查日志读取未配置。");
      const withBudget = store.withCheckLogBudget.bind(store);
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
      } catch (error) {
        if (error instanceof CheckLogReadLimitError)
          throw new CheckLogReadLimitError();
        // Never pass a filesystem exception (and its private path) to the MCP error mapper.
        throw ToolError.notFound("检查日志不存在、已清理或不可安全读取。");
      }
      const result = safeReferenceQuery(() =>
        withBudget(
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
              throw ToolError.validation(
                "本指派对该检查的日志读取额度已耗尽。",
              );
            const bytes = Buffer.from(page.text, "utf8");
            let end = Math.min(bytes.length, readLimit, remaining);
            while (
              end > 0 &&
              end < bytes.length &&
              ((bytes[end] ?? 0) & 0xc0) === 0x80
            )
              end--;
            if (end === 0 && bytes.length > 0) {
              if (remaining <= readLimit)
                throw ToolError.validation(
                  "本指派累计余额不足以容纳下一个完整 UTF-8 字符，无法继续读取此位置。",
                  {
                    reason: "attempt_budget_too_small",
                    remaining_bytes: remaining,
                  },
                );
              throw new CheckLogReadLimitError();
            }
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
                  next < page.size ||
                  requested > readLimit ||
                  end < bytes.length,
                eof: next >= page.size,
                remaining_bytes: remaining - end,
              },
            };
          },
        ),
      );
      const read = store.uow.read((tx) =>
        referenceCard(tx, context, card, true),
      );
      auditReferenceRead(context, [card], "get_check_log");
      return { ...result, ...read.provenance };
    },
  });
}
