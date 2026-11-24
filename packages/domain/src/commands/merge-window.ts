import type { Actor, Card, Delivery, Event, WorkItem } from "../entities.js";
import {
  appendEvents,
  cardEventsOfType,
  eventsOfType,
} from "../event-index.js";
import type { CardId } from "../ids.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  text,
} from "./core.js";

export interface MergeWindow {
  readonly card_id: CardId;
  readonly opened_at: string;
  readonly refreshed_at: string;
  readonly files: readonly string[];
  readonly versions: readonly string[];
  readonly open: boolean;
}
const windowCache = new WeakMap<readonly Event[], readonly MergeWindow[]>();
export function mergeWindows(events: readonly Event[]) {
  const cached = windowCache.get(events);
  if (cached) return cached;
  const windows = new Map<CardId, MergeWindow>();
  for (const e of [...eventsOfType(events, "merge_window_changed")].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.seq - b.seq,
  )) {
    if (e.type !== "merge_window_changed" || !e.card_id) continue;
    windows.set(e.card_id, e.payload as unknown as MergeWindow);
  }
  const result = [...windows.values()];
  windowCache.set(events, result);
  return result;
}
// C-670: one pass per (deliveries, work_items) snapshot instead of a
// deliveries x work_items scan per card. Both arrays are immutable snapshots.
const versionCache = new WeakMap<
  readonly Delivery[],
  WeakMap<readonly WorkItem[], ReadonlyMap<CardId, readonly string[]>>
>();
const noVersions: readonly string[] = Object.freeze([]);
function versionsByCard(
  deliveries: readonly Delivery[],
  items: readonly WorkItem[],
) {
  let byItems = versionCache.get(deliveries);
  if (!byItems) {
    byItems = new WeakMap();
    versionCache.set(deliveries, byItems);
  }
  let index = byItems.get(items);
  if (!index) {
    // A delivery belongs to a card when any work item with its ID is on it.
    const cardsOf = new Map<string, Set<CardId>>();
    for (const w of items) {
      let cards = cardsOf.get(w.id);
      if (!cards) {
        cards = new Set();
        cardsOf.set(w.id, cards);
      }
      cards.add(w.card_id);
    }
    const map = new Map<CardId, string[]>();
    for (const v of deliveries) {
      if (
        v.kind === "card_completion" ||
        v.subject.kind !== "git_head" ||
        v.status === "superseded"
      )
        continue;
      for (const card of cardsOf.get(v.work_item_id) ?? []) {
        const list = map.get(card);
        if (list) list.push(v.id);
        else map.set(card, [v.id]);
      }
    }
    for (const list of map.values()) list.sort();
    index = map;
    byItems.set(items, index);
  }
  return index;
}
export function mergeWindowVersions(
  state: Pick<CommandState, "deliveries" | "work_items">,
  card: CardId,
): string[] {
  return [
    ...(versionsByCard(state.deliveries, state.work_items).get(card) ??
      noVersions),
  ];
}
function authority(d: CommandDraft, reason: string) {
  ensure(
    d.actor.kind === "human" ||
      (d.actor.kind === "assignment" &&
        d.actor.role_id === "pm" &&
        d.assignment?.scope === "standing" &&
        d.assignment.standing_mode === "ops"),
    "unauthorized",
    "Only the human or standing PM Ops can manage merge ordering",
  );
  text(reason, "reason");
}
export function setMergeSolo(
  state: CommandState,
  actor: Actor,
  p: { card_id: CardId; solo: boolean; reason: string },
  ports: CommandPorts,
) {
  return command(state, actor, "set_merge_solo", ports, (d) => {
    authority(d, p.reason);
    const card = d.card(p.card_id);
    ensure(
      !["done", "cancelled"].includes(card.status) &&
        typeof p.solo === "boolean",
      "illegal_transition",
      "Card is closed or solo flag is invalid",
    );
    if (!!card.merge_solo === p.solo) return card;
    const next = { ...card, merge_solo: p.solo };
    d.put("cards", next);
    d.emit(
      "merge_solo_set",
      card.id,
      { solo: p.solo, reason: p.reason },
      { type: "status_change", body: p.solo ? "单独批次" : "恢复批次合并" },
    );
    return next;
  });
}
function write(
  d: CommandDraft,
  window: MergeWindow,
  reason: string,
  byHold = false,
) {
  d.emit(
    "merge_window_changed",
    window.card_id,
    {
      card_id: window.card_id,
      opened_at: window.opened_at,
      refreshed_at: window.refreshed_at,
      files: [...window.files],
      versions: [...window.versions],
      open: window.open,
      reason,
      ...(byHold ? { closed_by_hold: true } : {}),
    },
    {
      type: "status_change",
      body: byHold
        ? "因暂停关闭合并窗口"
        : `${window.open ? "开启" : "关闭"}合并窗口：${reason}`,
    },
  );
}
/**
 * C-677: a held card cannot merge, so its window stops protecting it. Only the
 * human may close a sensitive card's window, so a sensitive card's window
 * yields only to a hold the human set.
 */
export function windowYieldsToHold(card: Card) {
  return !!card.hold && (!card.sensitive || card.hold.set_by === "human");
}
/** C-677: close the card's open window in the same transaction as its hold. */
export function closeHeldWindow(d: CommandDraft, card: Card) {
  if (!windowYieldsToHold(card)) return;
  const window = mergeWindows(appendEvents(d.state.events, d.events)).find(
    (w) => w.card_id === card.id && w.open,
  );
  if (window) write(d, { ...window, open: false }, "卡片已暂停", true);
}
export function setMergeWindow(
  state: CommandState,
  actor: Actor,
  p: { card_id: CardId; open: boolean; reason: string },
  ports: CommandPorts,
) {
  return command(state, actor, "set_merge_window", ports, (d) => {
    authority(d, p.reason);
    const card = d.card(p.card_id);
    ensure(
      typeof p.open === "boolean" &&
        !["done", "cancelled"].includes(card.status),
      "illegal_transition",
      "Card is closed or window flag is invalid",
    );
    ensure(
      p.open || !card.sensitive || actor.kind === "human",
      "unauthorized",
      "Only the human may close a sensitive card's window",
    );
    const old = mergeWindows(state.events).find((w) => w.card_id === card.id);
    if (!!old?.open === p.open) return old;
    const window: MergeWindow = {
      card_id: card.id,
      open: p.open,
      files: [],
      versions: [],
      opened_at: d.now,
      refreshed_at: d.now,
    };
    write(d, window, p.reason);
    return window;
  });
}
export function openConflictWindow(d: CommandDraft, card: Card) {
  const config = d.state.project_settings?.merge_queue;
  if (!config) return;
  // C-677: a held card cannot merge; its next conflict after release reopens.
  if (card.hold) return;
  const events = appendEvents(d.state.events, d.events);
  if (mergeWindows(events).some((w) => w.card_id === card.id && w.open)) return;
  if (
    cardEventsOfType(events, card.id, "merge_conflicted").length <
    (config.conflict_threshold ?? 2)
  )
    return;
  write(
    d,
    {
      card_id: card.id,
      open: true,
      files: [],
      versions: [],
      opened_at: d.now,
      refreshed_at: d.now,
    },
    "重复合并冲突",
  );
}
export function refreshMergeWindows(
  state: CommandState,
  actor: Actor,
  p: {
    paths: readonly {
      card_id: CardId;
      versions: readonly string[];
      files: readonly string[];
    }[];
  },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_merge_batch", ports, (d) => {
    for (const path of p.paths) {
      ensure(
        JSON.stringify(path.versions) ===
          JSON.stringify(mergeWindowVersions(state, path.card_id)) &&
          path.files.every(
            (f) =>
              f.length > 0 &&
              !f.startsWith("/") &&
              !f.split("/").includes(".."),
          ),
        "stale_target",
        "Merge window paths do not match current deliveries",
      );
      const old = cardEventsOfType(
        state.events,
        path.card_id,
        "merge_queue_paths",
      ).at(-1);
      if (JSON.stringify(old?.payload) !== JSON.stringify(path))
        d.emit("merge_queue_paths", path.card_id, {
          ...path,
          versions: [...path.versions],
          files: [...path.files],
        });
    }
    for (const window of mergeWindows(state.events).filter((w) => w.open)) {
      const card = d.card(window.card_id);
      const changed = p.paths.find(
        (p) =>
          p.card_id === card.id &&
          JSON.stringify(p.versions) !== JSON.stringify(window.versions),
      );
      const updatedPaths = p.paths.find(
        (p) =>
          p.card_id === card.id &&
          JSON.stringify(p.files) !== JSON.stringify(window.files),
      );
      // C-677: windows held before this rule shipped close on the first refresh.
      if (windowYieldsToHold(card))
        write(d, { ...window, open: false }, "卡片已暂停", true);
      else if (
        ["done", "cancelled"].includes(card.status) ||
        (!changed &&
          Date.parse(d.now) - Date.parse(window.refreshed_at) >=
            (state.project_settings?.merge_queue?.window_timeout_ms ??
              86_400_000))
      ) {
        write(
          d,
          { ...window, open: false },
          ["done", "cancelled"].includes(card.status)
            ? "保护卡已结束"
            : "窗口到期",
        );
      } else if (changed)
        write(
          d,
          { ...window, ...changed, refreshed_at: d.now },
          "产出版本已更新",
        );
      else if (updatedPaths)
        write(d, { ...window, files: updatedPaths.files }, "保护范围已更新");
    }
  });
}
/** C-677: which window holds a card, the overlapping files and whether its card is held. */
export interface MergeWindowHold {
  readonly card_id: CardId;
  /** Empty when either side's paths are not known yet, which fails closed. */
  readonly files: readonly string[];
  readonly held: boolean;
}
export function mergeWindowHold(
  state: CommandState,
  card: CardId,
): MergeWindowHold | undefined {
  const open = mergeWindows(state.events).filter((w) => w.open);
  if (!open.length) return undefined;
  const cards = new Map(state.cards.map((c) => [c.id, c]));
  const windows = open
    .filter((w) => {
      const owner = cards.get(w.card_id);
      return (
        !!owner &&
        !["done", "cancelled"].includes(owner.status) &&
        !windowYieldsToHold(owner)
      );
    })
    .sort(
      (a, b) =>
        a.opened_at.localeCompare(b.opened_at) ||
        a.card_id.localeCompare(b.card_id),
    );
  // Windows protect files of one baseline branch; other branches never collide.
  const branch = (id: CardId) => cards.get(id)?.base_branch;
  const active: MergeWindow[] = [];
  for (const window of windows) {
    if (
      !active.some(
        (old) =>
          branch(old.card_id) === branch(window.card_id) &&
          (!old.versions.length ||
            !window.versions.length ||
            window.files.some((f) => old.files.includes(f))),
      )
    )
      active.push(window);
  }
  const paths = cardEventsOfType(state.events, card, "merge_queue_paths").at(-1)
    ?.payload as unknown as { versions: string[]; files: string[] } | undefined;
  // Paths of an older version are unknown, like missing paths.
  const known =
    paths &&
    JSON.stringify(paths.versions) ===
      JSON.stringify(mergeWindowVersions(state, card))
      ? paths.files
      : undefined;
  const window = active.find(
    (w) =>
      w.card_id !== card &&
      branch(w.card_id) === branch(card) &&
      (!known || !w.versions.length || known.some((f) => w.files.includes(f))),
  );
  if (!window) return undefined;
  return {
    card_id: window.card_id,
    files:
      known && window.versions.length
        ? known.filter((f) => window.files.includes(f))
        : [],
    held: !!cards.get(window.card_id)?.hold,
  };
}
export function heldByMergeWindow(
  state: CommandState,
  card: CardId,
): CardId | undefined {
  return mergeWindowHold(state, card)?.card_id;
}
