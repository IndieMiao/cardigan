import {
  type CardDependencyState,
  cardDependenciesAllowStart,
  unmetCardDependencies,
} from "../card-dependencies.js";
import type { Actor, Card } from "../entities.js";
import type { CardId } from "../ids.js";
import { transition } from "../transitions.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  text,
  unwrap,
} from "./core.js";

export interface CardDependencyInput {
  readonly depends_on_cards?: readonly CardId[];
  readonly wait_for_dependencies?: boolean;
  readonly early_start?: boolean;
  readonly dependency_reason?: string;
}

export function dependencyChangeNotice(
  card: Card,
  p: CardDependencyInput,
): string {
  const notes = [card.title];
  if (p.depends_on_cards !== undefined)
    notes.push(`前置卡：${card.depends_on_cards?.join("、") || "无"}`);
  if (p.wait_for_dependencies !== undefined)
    notes.push(
      p.wait_for_dependencies ? "已标记等待前置" : "已清除等待前置标记",
    );
  if (p.early_start !== undefined)
    notes.push(
      `${p.early_start ? "已启用" : "已清除"}提前开工：${p.dependency_reason?.trim() ?? ""}`,
    );
  return notes.join("\n");
}

export function dependencyState(d: CommandDraft): CardDependencyState {
  return {
    cards: d.list("cards"),
    events: [...d.state.events, ...d.events],
    card_templates: [
      ...(d.ports?.templates ?? []),
      ...d.list("card_templates"),
    ],
    work_items: d.list("work_items"),
    deliveries: d.list("deliveries"),
  };
}

export function requireCardDependencies(d: CommandDraft, card: Card) {
  if (!card.depends_on_cards?.length) return;
  const missing = unmetCardDependencies(dependencyState(d), card);
  ensure(
    !missing.length,
    "invariant_violation",
    `前置卡尚未正常完成：${missing.join("、")}`,
    { card_dependencies: missing },
  );
}

/** Called inside the same write transaction as creation/update; never from a stale read. */
export function applyCardDependencies(
  d: CommandDraft,
  card: Card,
  p: CardDependencyInput,
): Card {
  if (
    p.depends_on_cards === undefined &&
    p.wait_for_dependencies === undefined &&
    p.early_start === undefined &&
    p.dependency_reason === undefined
  )
    return card;
  d.pm();
  d.projectAccess();
  ensure(
    !["done", "cancelled"].includes(card.status),
    "illegal_transition",
    "已结束卡片不能修改依赖排期",
  );
  if (p.wait_for_dependencies !== undefined)
    ensure(
      typeof p.wait_for_dependencies === "boolean",
      "validation_failed",
      "等待前置标记必须为布尔值",
    );
  if (p.dependency_reason !== undefined)
    ensure(
      p.early_start !== undefined,
      "validation_failed",
      "提前开工理由须与标记一同提交",
    );
  let result = card;
  if (p.depends_on_cards !== undefined) {
    ensure(
      Array.isArray(p.depends_on_cards),
      "validation_failed",
      "依赖须为卡号数组，清空请传 []",
    );
    const ids = [...new Set(p.depends_on_cards)];
    for (const id of ids) {
      const before = d.list("cards").find((c) => c.id === id);
      ensure(
        id !== card.id,
        "validation_failed",
        `依赖成环：${card.id} → ${card.id}`,
      );
      ensure(
        before && before.project_id === card.project_id,
        "validation_failed",
        `前置卡 ${id} 不存在或不属于当前项目`,
      );
    }
    result = { ...result, depends_on_cards: ids };
    const graph = new Map(
      d.list("cards").map((c) => [c.id, c.depends_on_cards ?? []]),
    );
    graph.set(card.id, ids);
    const path: CardId[] = [card.id];
    const positions = new Map<CardId, number>([[card.id, 0]]);
    const done = new Set<CardId>();
    const stack = [{ id: card.id, next: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (!frame) break;
      const next = graph.get(frame.id)?.[frame.next++];
      if (!next) {
        done.add(frame.id);
        positions.delete(frame.id);
        stack.pop();
        path.pop();
        continue;
      }
      const at = positions.get(next);
      ensure(
        at === undefined,
        "validation_failed",
        `依赖成环：${[...path.slice(at ?? 0), next].join(" → ")}`,
      );
      if (done.has(next)) continue;
      positions.set(next, path.length);
      path.push(next);
      stack.push({ id: next, next: 0 });
    }
  }
  if (p.wait_for_dependencies !== undefined)
    result = { ...result, wait_for_dependencies: p.wait_for_dependencies };
  if (p.early_start !== undefined) {
    ensure(
      typeof p.early_start === "boolean",
      "validation_failed",
      "提前开工标记必须为布尔值",
    );
    ensure(!card.hold, "illegal_transition", "卡片已暂停，请先解除暂停");
    text(p.dependency_reason, "提前开工变更理由");
    const { early_start: _previous, ...rest } = result;
    result = {
      ...rest,
      ...(p.early_start
        ? {
            early_start: {
              reason: p.dependency_reason.trim(),
              set_by: d.author,
              set_at: d.now,
            },
          }
        : {}),
    };
  }
  return result;
}

export function requireCardDependencyStart(d: CommandDraft, card: Card) {
  if (!card.depends_on_cards?.length || card.early_start) return;
  if (!cardDependenciesAllowStart(dependencyState(d), card))
    requireCardDependencies(d, card);
}

/** Existing system tick replays this against fresh state; events are the durable notice ledger. */
export function refreshCardDependencies(
  state: CommandState,
  actor: Actor,
  ports: CommandPorts,
) {
  return command(state, actor, "refresh_card_dependencies", ports, (d) => {
    if (
      !state.cards.some(
        (c) => c.depends_on_cards?.length || c.wait_for_dependencies,
      )
    )
      return null;
    const snapshot = dependencyState(d);
    for (const card of d.list("cards")) {
      if (
        ["done", "cancelled"].includes(card.status) ||
        (!card.depends_on_cards?.length && !card.wait_for_dependencies)
      )
        continue;
      const missing = unmetCardDependencies(snapshot, card);
      const exceptions = missing.filter((id) => {
        const before = snapshot.cards.find((c) => c.id === id);
        return !before || ["done", "cancelled"].includes(before.status);
      });
      const signature = JSON.stringify([
        card.early_start?.set_at,
        (card.depends_on_cards ?? []).map((id) => {
          const before = snapshot.cards.find((c) => c.id === id);
          return [
            id,
            before?.status,
            before?.resolution,
            before?.superseded_by,
          ];
        }),
      ]);
      const once = (type: string, body: string) => {
        if (
          snapshot.events.some(
            (e) =>
              e.card_id === card.id &&
              e.type === type &&
              (e.payload as Record<string, unknown>)?.dependency_signature ===
                signature,
          )
        )
          return;
        d.emit(
          type,
          card.id,
          {
            card_id: card.id,
            dependency_signature: signature,
            depends_on_cards: card.depends_on_cards ?? [],
            notice: body,
          },
          { type: "system", author: "system", body },
        );
      };
      if (exceptions.length)
        once(
          "card_dependencies_attention",
          `前置卡异常，等待 PM 处理：${exceptions.join("、")}。原依赖关系保留。`,
        );
      if (missing.length) continue;
      if (card.early_start && card.depends_on_cards?.length)
        once(
          "card_dependencies_ready",
          "前置卡已全部正常完成，请提前开工的负责人同步基线后继续。",
        );
      if (card.status !== "backlog" || !card.wait_for_dependencies || card.hold)
        continue;
      const next = {
        ...card,
        status: unwrap(transition("card", card.status, "set_todo")),
        wait_for_dependencies: false,
      };
      d.put("cards", next);
      d.emit(
        "card_dependencies_released",
        card.id,
        { card_id: card.id, depends_on_cards: card.depends_on_cards ?? [] },
        {
          type: "status_change",
          author: "system",
          body: "前置卡已全部正常完成，已转为待办。",
        },
      );
    }
    return null;
  });
}
