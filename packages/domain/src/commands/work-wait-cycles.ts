import type { Actor, Event, WorkItem } from "../entities.js";
import { eventsOfType, eventsOfTypes } from "../event-index.js";
import type { CardId } from "../ids.js";
import { runsOf } from "../run-index.js";
import {
  describeWaitCycle,
  type WaitEdge,
  WaitGraph,
  type WaitItem,
  waitChain,
  waitCycleItems,
  waitCycles,
} from "../work-wait-graph.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";

/** C-851: an assigned producer waiting this long on dependencies is reported once. */
export const DEFAULT_WORK_DEPENDENCY_STALL_MS = 2 * 60 * 60_000;

export const WORK_WAIT_CYCLE_DETECTED = "work_wait_cycle_detected";
export const WORK_WAIT_CYCLE_CLEARED = "work_wait_cycle_cleared";
export const WORK_DEPENDENCY_STALLED = "work_dependency_stalled";

const payload = (e: Event) => e.payload as Record<string, unknown>;
const ACTIVE_RUN = new Set(["queued", "dispatched", "acked", "running"]);

/**
 * C-851: refuse a work-item change that makes dependencies and verification
 * targets wait on each other. `items` is the card's work items after the
 * change; only a cycle through `changed` is refused, so an older cycle
 * elsewhere (reported by the patrol) never blocks an unrelated edit.
 */
export function requireNoWaitCycle(
  items: readonly WaitItem[],
  changed: string,
) {
  const graph = new WaitGraph(items);
  const cycle = graph.cycleOf(changed);
  ensure(
    !cycle,
    "validation_failed",
    cycle
      ? `工作项依赖与验证目标成环，无法开工：${describeWaitCycle(graph, cycle)}。环上的工作项：${waitCycleItems(cycle).join("、")}。请调整依赖、验证目标或必需标记`
      : "",
    cycle ? { work_items: waitCycleItems(cycle) } : undefined,
  );
}

function itemLabel(graph: WaitGraph, id: string) {
  const item = graph.items.get(id);
  if (!item) return id;
  return `${id}${item.title ? `「${item.title}」` : ""}（${item.kind === "produce" ? "产出" : "验证"}，${item.status}，${item.assignment_id ? `指派 ${item.assignment_id}` : "未指派"}）`;
}

/** Concrete ways out, each naming an edge PM can actually change. */
function cycleSuggestions(graph: WaitGraph, cycle: readonly WaitEdge[]) {
  const out: string[] = [];
  for (const edge of cycle) {
    if (edge.via === "verifier") {
      const verifier = graph.items.get(edge.to.item);
      if (verifier && !verifier.template_key)
        out.push(
          `若 ${edge.from.item} 接受前不必等 ${edge.to.item}，把 ${edge.to.item} 改为非必需或取消它，改在 ${edge.from.item} 接受后另建验证`,
        );
    }
    if (edge.via === "dependency")
      out.push(
        `若 ${edge.from.item} 不该等 ${edge.to.item}，由 PM Ops 用 update_work_item 去掉 ${edge.from.item} 的依赖 ${edge.to.item}`,
      );
  }
  return out.length
    ? out
    : ["取消环上建错的工作项，按正确的依赖和验证目标重建"];
}

function openCycleNotices(state: CommandState) {
  const open = new Map<string, Event>();
  for (const e of eventsOfTypes(state.events, [
    WORK_WAIT_CYCLE_DETECTED,
    WORK_WAIT_CYCLE_CLEARED,
  ])) {
    if (e.actor.kind !== "system") continue;
    const signature = payload(e).signature;
    if (typeof signature !== "string") continue;
    if (e.type === WORK_WAIT_CYCLE_DETECTED) open.set(signature, e);
    else open.delete(signature);
  }
  return open;
}

/**
 * C-851 patrol: tell PM Ops once about each dependency/verification cycle
 * (again only after it cleared and came back), and once per assignment whose
 * producer has waited `stallMs` on unmet dependencies, with the wait chain.
 * Changes no work item; events are the durable notice ledger.
 */
export function refreshWorkWaits(
  state: CommandState,
  actor: Actor,
  ports: CommandPorts,
  stallMs = DEFAULT_WORK_DEPENDENCY_STALL_MS,
) {
  return command(state, actor, "refresh_work_waits", ports, (d) => {
    const open = new Set(
      d
        .list("cards")
        .filter((c) => c.status !== "done" && c.status !== "cancelled")
        .map((c) => c.id),
    );
    const byCard = new Map<CardId, WorkItem[]>();
    for (const item of d.list("work_items"))
      if (open.has(item.card_id)) {
        const list = byCard.get(item.card_id) ?? [];
        list.push(item);
        byCard.set(item.card_id, list);
      }
    // Every cycle contains a dependency edge; cards without one are skipped.
    const relevant = [...byCard].filter(([, items]) =>
      items.some((w) => w.depends_on.length),
    );
    const notices = openCycleNotices(state);
    const current = new Set<string>();
    for (const [cardId, items] of relevant) {
      const graph = new WaitGraph(items);
      for (const found of waitCycles(items)) {
        const signature = JSON.stringify([cardId, found.work_items]);
        current.add(signature);
        if (notices.has(signature)) continue;
        const ordered = waitCycleItems(found.cycle);
        const notice = [
          `${cardId} 的工作项依赖与验证目标互相等待，谁都无法开工或完成：${describeWaitCycle(graph, found.cycle)}。`,
          `环上的工作项：${ordered.map((id) => itemLabel(graph, id)).join("；")}。`,
          `建议：${cycleSuggestions(graph, found.cycle).join("；")}。`,
        ].join("\n");
        d.emit(
          WORK_WAIT_CYCLE_DETECTED,
          cardId,
          { signature, work_items: ordered, notice },
          { type: "system", author: "system", body: notice },
        );
      }
    }
    for (const [signature, e] of notices)
      if (!current.has(signature) && e.card_id)
        d.emit(WORK_WAIT_CYCLE_CLEARED, e.card_id, {
          signature,
          detected_event_id: e.id,
        });
    const reported = new Set(
      eventsOfType(state.events, WORK_DEPENDENCY_STALLED)
        .filter((e) => e.actor.kind === "system")
        .map((e) => payload(e).assignment_id),
    );
    const now = Date.parse(d.now);
    for (const [cardId, items] of relevant) {
      const card = d.card(cardId);
      if (card.hold || card.status === "backlog") continue;
      let graph: WaitGraph | undefined;
      for (const item of items) {
        if (
          item.kind !== "produce" ||
          item.status !== "todo" ||
          !item.assignment_id ||
          reported.has(item.assignment_id)
        )
          continue;
        const assignment = d
          .list("assignments")
          .find((a) => a.id === item.assignment_id);
        if (
          assignment?.status !== "active" ||
          !Number.isFinite(Date.parse(assignment.created_at)) ||
          now - Date.parse(assignment.created_at) < stallMs ||
          runsOf(d.list("runs"), assignment.id).some((r) =>
            ACTIVE_RUN.has(r.status),
          )
        )
          continue;
        graph ??= new WaitGraph(items);
        const chain = waitChain(graph, { item: item.id, stage: "delivery" });
        if (!chain.steps.length) continue;
        const hours = Math.floor(
          (now - Date.parse(assignment.created_at)) / 3_600_000,
        );
        const notice = [
          `${item.id} 的指派 ${assignment.id}（${assignment.runtime_state}）已 ${hours} 小时未开工，在等依赖：`,
          chain.steps.join("；"),
          chain.cyclic
            ? "等待链成环，不会自行解开，请调整依赖、验证目标或必需标记。"
            : "请确认等待链末端有人在推进。",
        ].join("\n");
        d.emit(
          WORK_DEPENDENCY_STALLED,
          cardId,
          {
            assignment_id: assignment.id,
            work_item_id: item.id,
            chain: chain.steps,
            cyclic: chain.cyclic,
            notice,
          },
          {
            type: "system",
            author: "system",
            body: notice,
            work_item_id: item.id,
          },
        );
      }
    }
    return null;
  });
}
