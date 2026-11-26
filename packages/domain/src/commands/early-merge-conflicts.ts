import type { Actor, Event, WorkItem } from "../entities.js";
import { eventsOfType } from "../event-index.js";
import type { CardId, DeliveryId, WorkItemId } from "../ids.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";
import { currentPreMergeVersions } from "./pre-merge-check-view.js";
import { stoppedByHuman } from "./stop-state.js";

/**
 * C-782: after main advances, the host trial-merges delivered heads on the new
 * baseline. A conflict is told to the author once per delivery, only while the
 * author has no unfinished Run; later baseline moves are folded into that one
 * notice. Advisory only: no card, work item or review state changes, and the
 * merge gate still prepares and checks the real candidate.
 */
export const EARLY_MERGE_CONFLICT = "early_merge_conflict_detected";

export interface EarlyConflictTarget {
  readonly card_id: CardId;
  readonly work_item_id: WorkItemId;
  readonly delivery_id: DeliveryId;
  readonly head_sha: string;
}
export interface EarlyConflictProbe extends EarlyConflictTarget {
  readonly files: readonly string[];
}

const fullSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const payload = (e: Event) => e.payload as Record<string, unknown>;

function notifiedDeliveries(
  state: Pick<CommandState, "events" | "project_id">,
) {
  return new Set(
    eventsOfType(state.events, EARLY_MERGE_CONFLICT)
      .filter(
        (e) =>
          e.actor.kind === "system" && e.actor.project_id === state.project_id,
      )
      .map((e) => payload(e).delivery_id),
  );
}

/** Current product deliveries in review or awaiting merge, not yet told about a conflict. */
export function earlyConflictTargets(
  state: CommandState,
  base_branch: string,
): EarlyConflictTarget[] {
  const notified = notifiedDeliveries(state);
  return state.cards
    .filter(
      (c) =>
        ["review", "awaiting_merge"].includes(c.status) &&
        c.base_branch === base_branch &&
        !c.hold,
    )
    .flatMap((card) =>
      currentPreMergeVersions(card, state.work_items, state.deliveries).flatMap(
        (v) => {
          const delivery = state.deliveries.find((d) => d.id === v.delivery_id);
          const item = state.work_items.find((w) => w.id === v.work_item_id);
          if (
            delivery?.subject.kind !== "git_head" ||
            !fullSha.test(delivery.subject.value) ||
            !item ||
            !["delivered", "accepted"].includes(item.status) ||
            notified.has(delivery.id)
          )
            return [];
          return [
            {
              card_id: card.id,
              work_item_id: item.id,
              delivery_id: delivery.id,
              head_sha: delivery.subject.value,
            },
          ];
        },
      ),
    );
}

/** Why the author cannot be told now; the next sweep retries. */
export function earlyConflictDeferral(
  state: CommandState,
  target: Pick<EarlyConflictTarget, "work_item_id">,
): string | undefined {
  const item = state.work_items.find((w) => w.id === target.work_item_id);
  const owner = state.assignments.find((a) => a.id === item?.assignment_id);
  if (
    !item ||
    !owner ||
    owner.status !== "active" ||
    owner.scope !== "work_item" ||
    owner.work_item_id !== item.id
  )
    return "没有当前负责人";
  if (stoppedByHuman(state.events, owner.id)) return "指派已被人工停止";
  if (
    state.runs.some(
      (r) =>
        r.assignment_id === owner.id &&
        !["completed", "failed", "cancelled"].includes(r.status),
    )
  )
    return "作者有未结束的 Run";
}

const short = (sha: string) => sha.slice(0, 8);

function notice(
  item: WorkItem,
  probe: EarlyConflictProbe,
  base_branch: string,
  baseline_sha: string,
  files: readonly string[],
) {
  const shown =
    files.length > 10
      ? `${files.slice(0, 10).join("、")} 等 ${files.length} 个文件`
      : files.join("、");
  return `${item.id} 的交付 ${probe.delivery_id}（${short(probe.head_sha)}）在 ${base_branch} 最新基线 ${short(baseline_sha)} 上试合并冲突：${shown}。请合入最新基线、解决冲突后重新预检并交付；本交付不再重复提醒。`;
}

export function notifyEarlyMergeConflicts(
  state: CommandState,
  actor: Actor,
  p: {
    readonly base_branch: string;
    readonly baseline_sha: string;
    readonly probes: readonly EarlyConflictProbe[];
  },
  ports: CommandPorts,
) {
  return command(state, actor, "notify_early_merge_conflicts", ports, (d) => {
    ensure(
      fullSha.test(p.baseline_sha),
      "validation_failed",
      "试合并基线须为完整 SHA",
    );
    const targets = earlyConflictTargets(d.state, p.base_branch);
    const notified: DeliveryId[] = [];
    for (const probe of p.probes) {
      ensure(
        probe.files.length > 0 &&
          probe.files.every((f) => typeof f === "string" && f.length > 0),
        "validation_failed",
        "试合并冲突须列出文件",
      );
      // Evidence for a superseded, accepted-elsewhere or already told delivery is stale.
      const target = targets.find(
        (t) =>
          t.card_id === probe.card_id &&
          t.work_item_id === probe.work_item_id &&
          t.delivery_id === probe.delivery_id &&
          t.head_sha === probe.head_sha,
      );
      if (!target || notified.includes(target.delivery_id)) continue;
      if (earlyConflictDeferral(d.state, target)) continue;
      const item = d.work(target.work_item_id);
      const files = [...new Set(probe.files)].sort();
      const body = notice(item, probe, p.base_branch, p.baseline_sha, files);
      d.emit(
        EARLY_MERGE_CONFLICT,
        target.card_id,
        {
          work_item_id: item.id,
          assignment_id: item.assignment_id ?? null,
          delivery_id: target.delivery_id,
          head_sha: target.head_sha,
          base_branch: p.base_branch,
          baseline_sha: p.baseline_sha,
          files,
          body,
        },
        { type: "system", body, work_item_id: item.id },
      );
      notified.push(target.delivery_id);
    }
    return notified;
  });
}
