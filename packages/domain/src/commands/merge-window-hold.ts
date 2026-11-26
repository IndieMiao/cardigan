import type { Actor } from "../entities.js";
import { appendEvents } from "../event-index.js";
import type { CardId } from "../ids.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
} from "./core.js";
import { mergeQueue } from "./merge-batch.js";
import {
  DEFAULT_MERGE_WINDOW_HOLD_LIMIT_MS,
  DEFAULT_MERGE_WINDOW_TIMEOUT_MS,
  MERGE_QUEUE_HELD,
  MERGE_QUEUE_HOLD_RELEASED,
  mergeWindowHold,
  mergeWindows,
  mergeWindowVersions,
} from "./merge-window.js";

const minute = (at: string) => `${at.slice(0, 16).replace("T", " ")}Z`;
const fileList = (files: readonly string[]) =>
  !files.length
    ? "改动文件未知"
    : files.length > 3
      ? `${files.slice(0, 3).join("、")} 等 ${files.length} 个文件`
      : files.join("、");

/**
 * C-803: make a merge window's hold observable on the held card and bound it.
 * A card that would be in the merge queue but for a window gets one
 * `merge_queue_held` per hold (window instance and the card's versions). Once
 * it waited `window_hold_limit_ms`, `merge_queue_hold_released` lets it join
 * a batch; the batch check still guards the merged result.
 */
export function recordMergeWindowHolds(
  state: CommandState,
  actor: Actor,
  _p: Record<string, never>,
  ports: CommandPorts,
) {
  return command(state, actor, "manage_merge_batch", ports, (d) => {
    if (!state.project_settings?.merge_queue) return;
    if (!mergeWindows(state.events).some((w) => w.open)) return;
    const limit =
      state.project_settings.merge_queue.window_hold_limit_ms ??
      DEFAULT_MERGE_WINDOW_HOLD_LIMIT_MS;
    for (const item of mergeQueue(state, { ignoreWindows: true })) {
      const card = item.plan.card_id;
      const current = afterDraft(d);
      const hold = mergeWindowHold(current, card);
      if (!hold) continue;
      const key = {
        window_card_id: hold.card_id,
        window_opened_at: hold.opened_at,
        versions: mergeWindowVersions(current, card),
      };
      if (!hold.since) {
        const release_at = new Date(Date.parse(d.now) + limit).toISOString();
        d.emit(
          MERGE_QUEUE_HELD,
          card,
          {
            ...key,
            files: [...hold.files],
            expires_at: hold.expires_at,
            release_at,
          },
          {
            type: "system",
            author: "system",
            body: `合并排队被 ${hold.card_id} 的合并窗口挡住（${fileList(hold.files)}）；窗口 ${minute(hold.expires_at)} 到期，最迟 ${minute(release_at)} 可进入批次`,
          },
        );
        continue;
      }
      const waited = Date.parse(d.now) - Date.parse(hold.since);
      if (!(waited >= limit)) continue;
      d.emit(
        MERGE_QUEUE_HOLD_RELEASED,
        card,
        {
          ...key,
          held_since: hold.since,
          waited_ms: waited,
          limit_ms: limit,
        },
        {
          type: "system",
          author: "system",
          body: `被 ${hold.card_id} 的合并窗口挡了 ${Math.floor(waited / 60_000)} 分钟，超过等待上限，可进入批次，由批次检查兜底`,
        },
      );
    }
  });
}
const afterDraft = (d: CommandDraft): CommandState =>
  d.events.length
    ? { ...d.state, events: appendEvents(d.state.events, d.events) }
    : d.state;

export interface MergeWindowHolding {
  readonly card_id: CardId;
  readonly opened_at: string;
  readonly expires_at: string;
  readonly files: readonly string[];
  /** Cards this window holds now (awaiting merge and on overlapping files). */
  readonly holding: readonly {
    readonly card_id: CardId;
    readonly files: readonly string[];
    readonly since?: string;
    readonly release_at?: string;
  }[];
}

/** C-803: open windows and the cards each one holds, for PM Ops. */
export function mergeWindowHoldings(
  state: CommandState,
): readonly MergeWindowHolding[] {
  const open = mergeWindows(state.events).filter((w) => w.open);
  if (!open.length) return [];
  const holds = state.cards
    .filter((c) => c.status === "awaiting_merge")
    .flatMap((c) => {
      const hold = mergeWindowHold(state, c.id);
      return hold ? [{ card: c.id, hold }] : [];
    });
  const timeout =
    state.project_settings?.merge_queue?.window_timeout_ms ??
    DEFAULT_MERGE_WINDOW_TIMEOUT_MS;
  return open.map((w) => ({
    card_id: w.card_id,
    opened_at: w.opened_at,
    expires_at: new Date(Date.parse(w.refreshed_at) + timeout).toISOString(),
    files: [...w.files],
    holding: holds
      .filter(({ hold }) => hold.card_id === w.card_id)
      .map(({ card, hold }) => ({
        card_id: card,
        files: [...hold.files],
        ...(hold.since ? { since: hold.since } : {}),
        ...(hold.release_at ? { release_at: hold.release_at } : {}),
      })),
  }));
}
