import type { Actor, Card, Event } from "../entities.js";
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
  for (const e of events
    .filter((e) => e.type === "merge_window_changed")
    .sort(
      (a, b) => a.created_at.localeCompare(b.created_at) || a.seq - b.seq,
    )) {
    if (e.type !== "merge_window_changed" || !e.card_id) continue;
    windows.set(e.card_id, e.payload as unknown as MergeWindow);
  }
  const result = [...windows.values()];
  windowCache.set(events, result);
  return result;
}
export function mergeWindowVersions(state: CommandState, card: CardId) {
  return state.deliveries
    .filter(
      (v) =>
        v.kind !== "card_completion" &&
        v.subject.kind === "git_head" &&
        v.status !== "superseded" &&
        state.work_items.some(
          (w) => w.id === v.work_item_id && w.card_id === card,
        ),
    )
    .map((v) => v.id)
    .sort();
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
function write(d: CommandDraft, window: MergeWindow, reason: string) {
  d.emit(
    "merge_window_changed",
    window.card_id,
    {
      ...window,
      files: [...window.files],
      versions: [...window.versions],
      reason,
    },
    {
      type: "status_change",
      body: `${window.open ? "开启" : "关闭"}合并窗口：${reason}`,
    },
  );
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
  const events = [...d.state.events, ...d.events];
  if (mergeWindows(events).some((w) => w.card_id === card.id && w.open)) return;
  if (
    events.filter((e) => e.card_id === card.id && e.type === "merge_conflicted")
      .length < (config.conflict_threshold ?? 2)
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
      const old = state.events.findLast(
        (e) => e.card_id === path.card_id && e.type === "merge_queue_paths",
      );
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
      if (
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
export function heldByMergeWindow(
  state: CommandState,
  card: CardId,
): CardId | undefined {
  const windows = mergeWindows(state.events)
    .filter(
      (w) =>
        w.open &&
        state.cards.some(
          (c) =>
            c.id === w.card_id && !["done", "cancelled"].includes(c.status),
        ),
    )
    .sort(
      (a, b) =>
        a.opened_at.localeCompare(b.opened_at) ||
        a.card_id.localeCompare(b.card_id),
    );
  // Windows protect files of one baseline branch; other branches never collide.
  const branch = (id: CardId) =>
    state.cards.find((c) => c.id === id)?.base_branch;
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
  const paths = state.events.findLast(
    (e) => e.card_id === card && e.type === "merge_queue_paths",
  )?.payload as unknown as { versions: string[]; files: string[] } | undefined;
  return active.find(
    (w) =>
      w.card_id !== card &&
      branch(w.card_id) === branch(card) &&
      (!paths ||
        !w.versions.length ||
        JSON.stringify(paths.versions) !==
          JSON.stringify(mergeWindowVersions(state, card)) ||
        paths.files.some((f) => w.files.includes(f))),
  )?.card_id;
}
