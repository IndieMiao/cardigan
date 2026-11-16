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

interface ReferenceReadTarget {
  readonly id: CardId;
  readonly full: boolean;
}

/** Project audit only: no timeline entry and no reader-controlled identity. */
export function auditReferenceRead(
  context: ToolContext,
  cardIds: readonly CardId[],
  tool: ToolName,
  full = true,
) {
  auditReferenceReads(
    context,
    cardIds.map((id) => ({ id, full })),
    tool,
    false,
  );
}

/** Recheck full and summary cards atomically, then record one snapshot read. */
export function auditProjectSnapshotRead(
  context: ToolContext,
  targets: readonly ReferenceReadTarget[],
) {
  auditReferenceReads(context, targets, "project_snapshot", true);
}

function auditReferenceReads(
  context: ToolContext,
  targets: readonly ReferenceReadTarget[],
  tool: ToolName,
  aggregate: boolean,
) {
  if (targets.length === 0) return;
  try {
    context.store.uow.run((tx) => {
      const references: ReturnType<typeof referenceCard>[] = [];
      for (const { id, full } of new Map(
        targets.map((target) => [target.id, target]),
      ).values()) {
        const read = referenceCard(tx, context, id, tool === "get_check_log");
        if (full && read.access !== "full")
          throw ToolError.notFound("卡片不存在或无权读取。");
        if (read.reference) references.push(read);
      }
      const append = (
        read: ReturnType<typeof referenceCard>,
        cards:
          | { card_id: CardId }
          | { card_ids: readonly CardId[]; card_count: number },
      ) =>
        tx.events.append(context.identity.actor.project_id, {
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(context.identity.actor.project_id),
          type: "cross_card_read",
          actor: context.identity.actor,
          created_at: new Date().toISOString(),
          payload: {
            ...cards,
            tool,
            assignment_id: read.assignment.id,
            employee_id: read.assignment.employee_id ?? null,
          },
        });
      if (aggregate) {
        const first = references[0];
        if (first)
          append(first, {
            card_ids: references.map((read) => read.card.id),
            card_count: references.length,
          });
      } else {
        for (const read of references) append(read, { card_id: read.card.id });
      }
    });
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw ToolError.validation("跨卡读取审计失败。");
  }
}
