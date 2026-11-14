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
import type { ServerLogAudit } from "./deployment-server-log.js";

/** Only generated names and fixed statuses cross the host-only log boundary. */
export function writeServerLogAudit(store: Store, entry: ServerLogAudit) {
  store.uow.run((tx) => {
    tx.events.append("cardigan", {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence("cardigan"),
      type: "host_server_log_recorded",
      actor: { kind: "system", project_id: "cardigan" },
      created_at: new Date().toISOString(),
      payload: { ...entry },
    });
  });
}

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

/** Recover the candidate from the durable pre-stop audit, including the gap before start(). */
export function readInterruptedDeployment(
  store: Store,
  project: ProjectId,
  currentSha: string,
): DeploymentRecord | undefined {
  return store.uow.read((tx) => {
    const event = loadCommandState(tx, project).events.findLast(
      (e) => e.type === "host_deployment_recorded" && e.actor.kind === "system",
    );
    const record = event?.payload as DeploymentRecord | undefined;
    // A terminal success must prevent old stopping records from being replayed.
    if (
      record?.from !== currentSha ||
      (!record.stop_snapshot &&
        !(record.backup_file && record.to !== currentSha))
    )
      return undefined;
    return record.status === "stopping" ||
      (record.status === "failed" && !record.ready)
      ? record
      : undefined;
  });
}

export function writeDeploymentRecord(
  store: Store,
  project: ProjectId,
  record: DeploymentRecord,
  waiting?: { timeout_ms: number; now: number },
) {
  store.uow.run((tx) => {
    const actor = { kind: "system" as const, project_id: project };
    const clock = {
      now: () => new Date(waiting?.now ?? Date.now()).toISOString(),
    };
    const state = loadCommandState(tx, project);
    if (record.status === "waiting_for_evidence" && waiting) {
      const latest = state.events.findLast(
        (e) => e.type === "host_deployment_recorded",
      );
      const prior = latest?.payload as DeploymentRecord | undefined;
      const continuous =
        prior?.status === "waiting_for_evidence" &&
        prior.from === record.from &&
        prior.to === record.to;
      const since = continuous
        ? (prior.waiting_since ?? latest?.created_at)
        : clock.now();
      const started = Date.parse(since ?? "");
      const exceeded =
        Number.isFinite(started) && waiting.now - started >= waiting.timeout_ms;
      if (continuous && (prior.evidence_wait_exceeded || !exceeded)) return;
      record = {
        ...record,
        waiting_since: Number.isFinite(started) && since ? since : clock.now(),
        evidence_wait_exceeded: exceeded,
        ...(exceeded
          ? {
              summary:
                "中心 main 持续等待合并门禁证据已达到提醒时长，保留当前服务，请后台分拣核对",
            }
          : {}),
      };
    }
    const effect = unwrap(
      recordDeployment(state, actor, record, {
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
    if (
      record.status === "waiting_for_evidence" &&
      !record.evidence_wait_exceeded
    )
      return;
    persistEffect(
      tx,
      project,
      unwrap(
        requestDeploymentAction(
          loadCommandState(tx, project),
          actor,
          {
            key:
              record.status === "waiting_for_evidence"
                ? `deployment-evidence:${record.to}`
                : `deployment:${record.attempt}`,
            ...(record.status === "waiting_for_evidence"
              ? { reason: "evidence_wait" as const }
              : {}),
            instructions: `自动部署 ${record.from} → ${record.to}：${record.summary}。${record.log_tail ? `安全诊断：${record.log_tail}。` : ""}${record.backup_file ? `数据库备份：${record.backup_file}。` : ""}请核对部署记录；Agent 不能部署或重启 server。`,
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
