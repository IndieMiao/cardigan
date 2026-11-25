import type { Store } from "@cardigan/store";
import { deploymentFenceOccupied } from "./deployment-capacity.js";
import type { MaintenanceBusyItem } from "./deployment-maintenance.js";
import { liveLongOperations } from "./long-operations.js";
import { runningMergeChecks } from "./merge-check-capacity.js";

/** A Run in these states may still be working; unknown is never "finished". */
const UNFINISHED_RUN = new Set(["dispatched", "acked", "running", "unknown"]);

export interface MaintenanceActivity {
  /** Work that must end (or that the human must accept) before services stop. */
  readonly busy: readonly MaintenanceBusyItem[];
  /** Standing sessions keep running; they are listed, not waited for. */
  readonly standing: readonly MaintenanceBusyItem[];
}

function checkRows(store: Store): MaintenanceBusyItem[] {
  try {
    const rows = store.database
      .prepare(`SELECT project_id, card_id, attempt_id FROM check_recovery_attempts
        WHERE json_extract(doc, '$.status') = 'running' ORDER BY project_id, card_id, attempt_id`)
      .all() as { project_id: string; card_id: string; attempt_id: string }[];
    return rows.map((r) => ({
      kind: "check",
      id: r.attempt_id,
      project_id: r.project_id,
      card_id: r.card_id,
      status: "running",
    }));
  } catch {
    return [];
  }
}

/** One read of everything a maintenance window waits for. */
export function maintenanceActivity(store: Store): MaintenanceActivity {
  const busy: MaintenanceBusyItem[] = [];
  const standing: MaintenanceBusyItem[] = [];
  store.uow.read((tx) => {
    for (const project of store.listProjects()) {
      const assignments = new Map(
        tx.assignments.list(project.id).map((a) => [a.id, a]),
      );
      const cards = new Map(
        tx.work_items.list(project.id).map((w) => [w.id, w.card_id]),
      );
      for (const run of tx.runs.list(project.id)) {
        if (!UNFINISHED_RUN.has(run.status)) continue;
        const assignment = assignments.get(run.assignment_id);
        const card =
          assignment?.scope === "work_item"
            ? cards.get(assignment.work_item_id)
            : undefined;
        const item: MaintenanceBusyItem = {
          kind: "run",
          id: run.id,
          project_id: project.id,
          status: run.status,
          label: run.assignment_id,
          ...(card ? { card_id: card } : {}),
        };
        (assignment?.scope === "standing" ? standing : busy).push(item);
      }
    }
    busy.push(...checkRows(store));
    const local = [...runningMergeChecks(store).entries()];
    const tracked = busy.filter((b) => b.kind === "check").length;
    const counted = local.reduce((sum, [, n]) => sum + n, 0);
    // Capacity held by a check whose event has not been written yet.
    if (counted > tracked)
      busy.push({
        kind: "check",
        id: "capacity",
        status: "running",
        label: `${counted - tracked} 个检查占用中`,
      });
    if (deploymentFenceOccupied(store))
      busy.push({ kind: "deployment", id: "self-deploy", status: "running" });
  });
  for (const op of liveLongOperations(store))
    busy.push({
      kind: "operation",
      id: op.id,
      project_id: op.project_id,
      ...(op.card_id ? { card_id: op.card_id } : {}),
      status: op.kind,
      label: op.label,
    });
  return { busy, standing };
}

export function describeBusy(item: MaintenanceBusyItem): string {
  const where = [item.project_id, item.card_id].filter(Boolean).join("/");
  const kind = {
    run: "Run",
    check: "检查",
    operation: "长操作",
    deployment: "自动部署",
  }[item.kind];
  return `${kind} ${item.id}${where ? `（${where}）` : ""}${item.status ? ` ${item.status}` : ""}${item.label ? ` ${item.label}` : ""}`;
}
