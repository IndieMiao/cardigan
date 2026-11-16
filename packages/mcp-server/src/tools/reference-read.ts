import {
  type CardId,
  CROSS_CARD_REFERENCE_NOTICE,
  cardReadAccess,
  isReferenceCard,
  type ToolName,
} from "@cardigan/domain";
import type { McpReadContext } from "../backend.js";
import { ToolError } from "../errors.js";
import type { ToolContext } from "./types.js";

export function safeReferenceQuery<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw ToolError.validation("参考资料读取失败。");
  }
}

function readReferenceCard(
  tx: McpReadContext,
  context: ToolContext,
  id: CardId,
  check_log = false,
) {
  try {
    context.revalidateToken?.();
  } catch {
    throw new ToolError("unauthorized", "Token 已失效。");
  }
  const { identity } = context;
  const project = identity.actor.project_id;
  const assignment = tx.assignments.get(project, identity.actor.assignment_id);
  if (
    assignment?.status !== "active" ||
    assignment.role_version !== identity.token.role_version ||
    assignment.role_id !== identity.actor.role_id
  )
    throw new ToolError("unauthorized", "当前指派已失效。");
  const card = tx.cards.get(project, id);
  const items = tx.work_items.list(project);
  const access = cardReadAccess({
    project_id: project,
    assignment,
    card,
    work_items: items,
    preferences: tx.project_preferences?.get(project, project),
    check_log,
  });
  if (!card || access === "none")
    throw ToolError.notFound("卡片不存在或无权读取。");
  const reference = isReferenceCard(assignment, card, items);
  return {
    card,
    assignment,
    access,
    reference,
    work_items: items.filter((item) => item.card_id === id),
    provenance: reference
      ? { source_card_id: id, reference_notice: CROSS_CARD_REFERENCE_NOTICE }
      : {},
  };
}

export function referenceCard(
  tx: McpReadContext,
  context: ToolContext,
  id: CardId,
  check_log = false,
) {
  try {
    return readReferenceCard(tx, context, id, check_log);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw ToolError.validation("检查日志列表读取失败。");
  }
}

/** Project audit only: no timeline entry and no reader-controlled identity. */
export function auditReferenceRead(
  context: ToolContext,
  cardIds: readonly CardId[],
  tool: ToolName,
  full = true,
) {
  if (cardIds.length === 0) return;
  try {
    context.store.uow.run((tx) => {
      for (const id of new Set(cardIds)) {
        const read = referenceCard(tx, context, id, tool === "get_check_log");
        if (full && read.access !== "full")
          throw ToolError.notFound("卡片不存在或无权读取。");
        if (!read.reference) continue;
        tx.events.append(context.identity.actor.project_id, {
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(context.identity.actor.project_id),
          type: "cross_card_read",
          actor: context.identity.actor,
          created_at: new Date().toISOString(),
          payload: {
            card_id: id,
            tool,
            assignment_id: read.assignment.id,
            employee_id: read.assignment.employee_id ?? null,
          },
        });
      }
    });
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw ToolError.validation("跨卡读取审计失败。");
  }
}
