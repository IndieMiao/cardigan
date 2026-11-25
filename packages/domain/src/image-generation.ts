import {
  attempt,
  CommandDraft,
  type CommandState,
  ensure,
} from "./commands/core.js";
import type { Actor } from "./entities.js";
import type { Result } from "./errors.js";
import type { AssignmentId, CardId, WorkItemId } from "./ids.js";

/**
 * C-734: host-run image generation. The host owns the credential, the
 * provider call and the attachments; identity comes only from the token.
 */
export const IMAGE_GENERATION_MAX_REFERENCES = 16;
export const IMAGE_GENERATION_MAX_PROMPT = 32_000;
export const IMAGE_QUALITIES = [
  "auto",
  "low",
  "medium",
  "high",
  "standard",
  "hd",
] as const;
export const IMAGE_BACKGROUNDS = ["auto", "transparent", "opaque"] as const;
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];
export type ImageBackground = (typeof IMAGE_BACKGROUNDS)[number];
/** `auto` or `<width>x<height>`; the provider decides which it supports. */
export const IMAGE_SIZE = /^(?:auto|[1-9][0-9]{1,4}x[1-9][0-9]{1,4})$/u;

export interface ImageGenerationRequester {
  readonly project_id: string;
  readonly card_id: CardId;
  readonly work_item_id: WorkItemId;
  readonly assignment_id: AssignmentId;
  readonly role_id: string;
}

/** The active owner of a produce item on an open, unheld card. */
export function authorizeImageGeneration(
  state: CommandState,
  actor: Actor,
): Result<ImageGenerationRequester> {
  return attempt(() => {
    const d = new CommandDraft(state, actor, "generate_image");
    const a = d.assignment;
    ensure(
      actor.kind === "assignment" &&
        a?.scope === "work_item" &&
        a.status === "active",
      "unauthorized",
      "只有本卡当前的产出负责人可以生图",
    );
    const item = d.ownWork(a.work_item_id);
    ensure(
      item.kind === "produce" &&
        item.assignment_id === a.id &&
        item.status !== "cancelled",
      "unauthorized",
      "只有产出项负责人可以生图",
    );
    const card = d.card(item.card_id);
    ensure(!card.hold, "illegal_transition", "卡片已暂停，请先解除暂停");
    ensure(
      !["done", "cancelled"].includes(card.status),
      "illegal_transition",
      "已关闭的卡片不能生图",
    );
    return {
      project_id: state.project_id,
      card_id: card.id,
      work_item_id: item.id,
      assignment_id: a.id,
      role_id: a.role_id,
    } satisfies ImageGenerationRequester;
  });
}

/** Reference images must be distinct attachments of the requester's card. */
export function imageReferencesOnCard(
  state: Pick<CommandState, "attachments">,
  card_id: CardId,
  ids: readonly string[],
): string | undefined {
  if (ids.length > IMAGE_GENERATION_MAX_REFERENCES)
    return `参考图最多 ${IMAGE_GENERATION_MAX_REFERENCES} 张`;
  if (new Set(ids).size !== ids.length) return "参考图不能重复";
  for (const id of ids) {
    const found = state.attachments.find((a) => a.id === id);
    if (!found || found.card_id !== card_id)
      return `参考图 ${id} 不是本卡的附件`;
    if (!/^image\/(?:png|jpeg|webp)$/u.test(found.mime))
      return `参考图 ${id} 不是 PNG、JPEG 或 WebP 图片`;
  }
  return undefined;
}
