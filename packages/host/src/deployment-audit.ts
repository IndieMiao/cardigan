import {
  type DeliveryId,
  type DeploymentRecord,
  hasPassedMergeCheck,
  type ProjectId,
  recordDeployment,
  recordDeploymentStop,
  requestDeploymentAction,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { recordNotification, type Store } from "@cardigan/store";

export function writeDeploymentStop(
  store: Store,
  project: ProjectId,
  record: DeploymentRecord,
) {
  return store.uow.run((tx) => {
    const effect = unwrap(
      recordDeploymentStop(
        loadCommandState(tx, project),
        { kind: "system", project_id: project },
        record,
        { ids: tx.ids, clock: { now: () => new Date().toISOString() } },
      ),
    );
    persistEffect(tx, project, effect);
    return effect.data;
  });
}

export function writeDeploymentRecord(
  store: Store,
  project: ProjectId,
  record: DeploymentRecord,
) {
  store.uow.run((tx) => {
    const actor = { kind: "system" as const, project_id: project };
    const clock = { now: () => new Date().toISOString() };
    const effect = unwrap(
      recordDeployment(loadCommandState(tx, project), actor, record, {
        ids: tx.ids,
        clock,
      }),
    );
    persistEffect(tx, project, effect);
    if (
      !["failed", "rolled_back", "waiting_for_evidence"].includes(
        record.status,
      ) &&
      !record.post_deploy_failed
    )
      return;
    const event = effect.events[0];
    if (!event) throw new Error("Deployment audit event missing");
    for (const a of tx.assignments.list(project)) {
      if (
        a.status !== "active" ||
        a.scope !== "standing" ||
        !(
          a.role_id === "host_ops" ||
          (a.role_id === "pm" && a.standing_mode === "office")
        )
      )
        continue;
      recordNotification(store.database, {
        project_id: project,
        event_id: event.id,
        seq: event.seq,
        kind:
          record.status === "waiting_for_evidence"
            ? "host_deployment_waiting"
            : "host_deployment_failed",
        at: clock.now(),
        recipient: { kind: "assignment", assignment_id: a.id },
      });
    }
    // A normal publish can still be committing its audit. Keep it visible to
    // operations without creating a manual blocker for this transient window.
    if (record.status === "waiting_for_evidence") return;
    persistEffect(
      tx,
      project,
      unwrap(
        requestDeploymentAction(
          loadCommandState(tx, project),
          actor,
          {
            key: `deployment:${record.attempt}`,
            instructions: `自动部署 ${record.from} → ${record.to}：${record.summary}。请主机管理员检查；Agent 不能部署或重启 server。`,
          },
          { ids: tx.ids, clock },
        ),
      ),
    );
  });
}

/** Prove every published segment has a real gate result; foreign main changes fail closed. */
export function deploymentMergeSegments(
  store: Store,
  project: ProjectId,
  from: string,
  to: string,
) {
  return store.uow.read((tx) => {
    const state = loadCommandState(tx, project);
    const segments = new Map<
      string,
      { sha: string; previous: string; tree: string }
    >();
    for (const event of state.events) {
      if (
        event.type !== "card_merged" ||
        event.actor.kind !== "system" ||
        !event.card_id
      )
        continue;
      const p = event.payload as {
        completion_id?: DeliveryId;
        result?: {
          kind?: string;
          merge_sha?: string;
          previous_sha?: string;
          tree_sha?: string;
        };
      };
      const r = p.result;
      if (
        r?.kind !== "merged" ||
        !r.merge_sha ||
        !r.previous_sha ||
        !r.tree_sha ||
        !p.completion_id ||
        !hasPassedMergeCheck(
          state.events,
          event.card_id,
          p.completion_id,
          r.tree_sha,
        )
      )
        continue;
      segments.set(r.merge_sha, {
        sha: r.merge_sha,
        previous: r.previous_sha,
        tree: r.tree_sha,
      });
    }
    const result = [];
    const seen = new Set<string>();
    let sha = to;
    while (sha !== from) {
      if (seen.has(sha)) return undefined;
      seen.add(sha);
      const segment = segments.get(sha);
      if (!segment) return undefined;
      result.push(segment);
      sha = segment.previous;
    }
    return result;
  });
}
