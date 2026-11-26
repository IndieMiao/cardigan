import {
  type CardId,
  type DeliveryId,
  type DeploymentControl,
  type DeploymentOperation,
  type DeploymentReadyRetry,
  type DeploymentRecord,
  type Event,
  eventsOfType,
  eventsOfTypes,
  hasPassedMergeCheck,
  mergeBatches,
  type ProjectId,
  reconcileSupervisorNotice,
  recordDeployment,
  recordDeploymentStop,
  recordSupervisorUpgrade,
  requestDeploymentAction,
  type SupervisorUpgradeStatus,
  supervisorUpgradeState,
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

/**
 * C-650: the latest durable automatic-retry state of one target. Main and each
 * human pin are separate targets, so a new pin starts its own count.
 */
export function readReadyRetry(
  store: Store,
  project: ProjectId,
  to: string,
  controlEventId?: string,
): DeploymentReadyRetry | undefined {
  const rows = store.database
    .prepare(
      `SELECT doc FROM events WHERE project_id = ? AND card_id IS NULL AND type = 'host_deployment_recorded'
      AND json_extract(doc, '$.actor.kind') = 'system' AND json_extract(doc, '$.payload.to') = ?
      AND json_extract(doc, '$.payload.ready_retry') IS NOT NULL
      AND IFNULL(json_extract(doc, '$.payload.control_event_id'), '') = ?
      ORDER BY seq DESC LIMIT 1`,
    )
    .all(project, to, controlEventId ?? "") as { doc: string }[];
  const row = rows[0];
  if (!row) return undefined;
  const retry = (JSON.parse(row.doc) as Event)
    .payload as unknown as DeploymentRecord;
  return retry.ready_retry;
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
    const capacityWait = record.status === "waiting_for_capacity";
    const isWaiting = capacityWait || record.status === "waiting_for_evidence";
    if (isWaiting && waiting) {
      const latest = state.events.findLast(
        (e) =>
          e.type === "host_deployment_recorded" && e.actor.kind === "system",
      );
      const prior = latest?.payload as DeploymentRecord | undefined;
      const continuous =
        prior?.status === record.status &&
        prior.from === record.from &&
        prior.to === record.to;
      const since = continuous
        ? (prior.waiting_since ?? latest?.created_at)
        : clock.now();
      const started = Date.parse(since ?? "");
      const previouslyExceeded = capacityWait
        ? prior?.capacity_wait_exceeded
        : prior?.evidence_wait_exceeded;
      const exceeded =
        (continuous && previouslyExceeded) ||
        (Number.isFinite(started) &&
          waiting.now - started >= waiting.timeout_ms);
      const sameBlockers =
        !capacityWait ||
        JSON.stringify(prior?.blocking_checks) ===
          JSON.stringify(record.blocking_checks);
      if (continuous && sameBlockers && (previouslyExceeded || !exceeded))
        return;
      record = {
        ...record,
        ...(continuous ? { attempt: prior.attempt } : {}),
        waiting_since: Number.isFinite(started) && since ? since : clock.now(),
        ...(capacityWait
          ? { capacity_wait_exceeded: exceeded }
          : { evidence_wait_exceeded: exceeded }),
        ...(exceeded
          ? {
              summary: capacityWait
                ? "主机部署等待本机容量已达到提醒时长，保留未知占用，请后台核对阻塞检查"
                : "中心 main 持续等待合并门禁证据已达到提醒时长，保留当前服务，请后台分拣核对",
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
      ![
        "failed",
        "rolled_back",
        "waiting_for_evidence",
        "waiting_for_capacity",
      ].includes(record.status) &&
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
        kind: isWaiting ? "host_deployment_waiting" : "host_deployment_failed",
        at: clock.now(),
        recipient: { kind: "assignment", assignment_id: a.id },
      });
    }
    // A normal publish can still be committing its audit. Keep it visible to
    // operations without creating a manual blocker for this transient window.
    if (capacityWait) return; // Notification and durable timeout audit; never force unlock.
    // C-650: the previous build is back and an automatic retry is scheduled;
    // only a retry that is used up (or a failed rollback) needs a person.
    if (record.status === "rolled_back" && record.ready_retry?.next_at) return;
    if (
      record.status === "waiting_for_evidence" &&
      !record.evidence_wait_exceeded
    )
      return;
    // C-801: no role changed and the standing PMs are on duty; the
    // notifications above are the notice.
    if (record.post_deploy_failure?.notice_only) return;
    const postDeploy = record.post_deploy_failed
      ? record.post_deploy_failure?.attempts
          .map(
            (a, i) =>
              `第 ${i + 1} 次：${a.step}：${a.error}${a.output_tail ? `；输出尾部：${a.output_tail}` : ""}`,
          )
          .join("\n")
      : undefined;
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
            // C-801: the host operator checks a post-deploy failure on the
            // host; the owner is never pushed.
            ...(record.post_deploy_failed
              ? { executor: "operator" as const }
              : {}),
            instructions: `自动部署 ${record.from} → ${record.to}：${record.summary}。${record.log_tail ? `安全诊断：${record.log_tail}。` : ""}${postDeploy ? `角色同步失败原因：\n${postDeploy}\n` : ""}${record.backup_file ? `数据库备份：${record.backup_file}。` : ""}请核对部署记录；Agent 不能部署或重启 server。`,
          },
          { ids: tx.ids, clock },
        ),
      ),
    );
  });
}

/**
 * C-609: audit a batching or operation wait once per distinct situation.
 * Never notifies or opens a human action: these waits are bounded and always
 * end in a deployment.
 */
export function writeOperationWait(
  store: Store,
  project: ProjectId,
  record: DeploymentRecord,
) {
  if (
    record.status !== "waiting_for_batch" &&
    record.status !== "waiting_for_operations"
  )
    throw new Error("Not an operation wait");
  store.uow.run((tx) => {
    const now = new Date().toISOString();
    const state = loadCommandState(tx, project);
    const latest = state.events.findLast(
      (e) => e.type === "host_deployment_recorded" && e.actor.kind === "system",
    );
    const prior = latest?.payload as DeploymentRecord | undefined;
    const continuous =
      prior?.status === record.status &&
      prior.from === record.from &&
      prior.to === record.to;
    if (
      continuous &&
      JSON.stringify(prior.deferred_operations ?? []) ===
        JSON.stringify(record.deferred_operations ?? [])
    )
      return;
    const effect = unwrap(
      recordDeployment(
        state,
        { kind: "system", project_id: project },
        {
          ...record,
          ...(continuous ? { attempt: prior.attempt } : {}),
          waiting_since: continuous
            ? (prior.waiting_since ?? latest?.created_at ?? now)
            : now,
        },
        { ids: tx.ids, clock: { now: () => now } },
      ),
    );
    persistEffect(tx, project, effect);
  });
}

/**
 * C-609: one timeline note per operation on its own card, in its own project.
 * Only that card's readers see which operation it was; the deployment
 * project's record keeps per-kind counts.
 */
function writeOperationNotes(
  store: Store,
  type:
    | "host_deployment_operation_deferred"
    | "host_deployment_operation_interrupted",
  attempt: string,
  ops: readonly DeploymentOperation[],
  body: (op: DeploymentOperation) => string,
) {
  store.uow.run((tx) => {
    const now = new Date().toISOString();
    for (const op of ops) {
      if (!op.card_id) continue;
      const project = op.project_id as ProjectId;
      const card = op.card_id as CardId;
      if (!tx.cards.get(project, card)) continue;
      const event: Event = {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project, card),
        card_id: card,
        type,
        actor: { kind: "system", project_id: project },
        payload: {
          attempt,
          kind: op.kind,
          label: op.label,
          started_at: op.started_at,
        },
        created_at: now,
      };
      tx.events.append(project, event);
      const entry = tx.ids.nextTimelineEntryId(project, card);
      tx.timeline.put(project, {
        id: entry,
        short_id: entry,
        card_id: card,
        event_seq: event.seq,
        type: "system",
        author: "system",
        refs: [],
        mentions: [],
        retracted: false,
        created_at: now,
        body: body(op),
      });
    }
  });
}

/** C-609: an automatic deployment is waiting for these operations (bounded). */
export function writeDeferredOperations(
  store: Store,
  attempt: string,
  ops: readonly DeploymentOperation[],
  /** C-799: the supervisor self-upgrade waits the same way. */
  cause: "deployment" | "supervisor_upgrade" = "deployment",
) {
  writeOperationNotes(
    store,
    "host_deployment_operation_deferred",
    attempt,
    ops,
    (op) =>
      cause === "supervisor_upgrade"
        ? `部署监督器自动升级正在等待本卡的${op.label}（${op.started_at} 开始）结束后再重启服务端；等待有上限，到时照常重启。`
        : `自动部署正在等待本卡的${op.label}（${op.started_at} 开始）结束后再重启服务端；等待有上限，到时照常部署。`,
  );
}

/**
 * C-609: the server is being stopped while these operations still run; they
 * resume or are requeued by the next server.
 */
export function writeInterruptedOperations(
  store: Store,
  attempt: string,
  ops: readonly DeploymentOperation[],
  cause: "deployment" | "supervisor_upgrade" = "deployment",
) {
  writeOperationNotes(
    store,
    "host_deployment_operation_interrupted",
    attempt,
    ops,
    (op) =>
      `${cause === "supervisor_upgrade" ? "部署监督器自动升级" : "自动部署"}等待已达上限，服务端照常重启；本卡的${op.label}（${op.started_at} 开始）仍在进行，重启后续跑或重排。`,
  );
}

/** Prove every published segment has a real gate result; foreign main changes fail closed. */
export async function deploymentMergeSegments(
  store: Store,
  project: ProjectId,
  from: string,
  to: string,
  /** Host Git proof that the requested start is inside the collected chain. */
  coversStart?: (start: string, end: string) => Promise<boolean>,
) {
  const segments = store.uow.read((tx) => {
    const state = loadCommandState(tx, project);
    const segments = new Map<
      string,
      { sha: string; previous: string; tree: string }
    >();
    // C-671: merged cards are closed; read them through the type index.
    for (const event of eventsOfTypes(state.events, [
      "host_deployment_controlled",
      "card_merged",
    ])) {
      if (
        event.type === "host_deployment_controlled" &&
        event.actor.kind === "human" &&
        event.actor.project_id === project
      ) {
        const control = event.payload as DeploymentControl;
        if (control.action === "adopt")
          segments.set(control.to, {
            sha: control.to,
            previous: control.from,
            tree: control.tree,
          });
        continue;
      }
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
    for (const batch of mergeBatches(state.events)) {
      if (
        batch.status !== "published" ||
        batch.check?.status !== "passed" ||
        batch.check.level !== "batch" ||
        batch.check.tree_sha !== batch.final_tree_sha ||
        batch.check.base_sha !== batch.base_sha
      )
        continue;
      const complete = batch.members.every((m) =>
        eventsOfType(state.events, "card_merged").some((e) => {
          if (
            e.actor.kind !== "system" ||
            e.card_id !== m.card_id ||
            e.type !== "card_merged"
          )
            return false;
          const p = e.payload as {
            batch_id?: string;
            completion_id?: string;
            result?: { merge_sha?: string; tree_sha?: string };
          };
          return (
            p.batch_id === batch.id &&
            p.completion_id === m.completion_id &&
            p.result?.merge_sha === m.merge_sha &&
            p.result.tree_sha === m.tree_sha
          );
        }),
      );
      if (complete)
        segments.set(batch.final_sha, {
          sha: batch.final_sha,
          previous: batch.base_sha,
          tree: batch.final_tree_sha,
        });
    }
    return segments;
  });
  const result = [];
  const seen = new Set<string>();
  let sha = to;
  while (sha !== from) {
    if (seen.has(sha)) return undefined;
    seen.add(sha);
    const segment = segments.get(sha);
    if (!segment) return undefined;
    result.push(segment);
    // A pinned side-branch commit may be inside the whole chain without being
    // inside any single segment. Keep every original segment for the caller's
    // ancestry/tree validation; only the coverage proof uses the outer bounds.
    if (
      segment.previous === from ||
      (await coversStart?.(segment.previous, to))
    )
      return result;
    sha = segment.previous;
  }
  return result;
}

/** Safe, durable and deduplicated notices, even when no deployment can start. */
export function writeDeploymentNotice(
  store: Store,
  key: string,
  instructions: string,
) {
  store.uow.run((tx) => {
    persistEffect(
      tx,
      "cardigan",
      unwrap(
        requestDeploymentAction(
          loadCommandState(tx, "cardigan"),
          { kind: "system", project_id: "cardigan" },
          { key, instructions },
          { ids: tx.ids, clock: { now: () => new Date().toISOString() } },
        ),
      ),
    );
  });
}

export function writeSupervisorComparison(
  store: Store,
  supervisor: string,
  main: string,
  affected: string[],
  automatic = false,
) {
  store.uow.run((tx) => {
    persistEffect(
      tx,
      "cardigan",
      unwrap(
        reconcileSupervisorNotice(
          loadCommandState(tx, "cardigan"),
          { kind: "system", project_id: "cardigan" },
          { supervisor, main, affected, ...(automatic ? { automatic } : {}) },
          { ids: tx.ids, clock: { now: () => new Date().toISOString() } },
        ),
      ),
    );
  });
}

/** Project activity only: an incomplete comparison is neither a deployment record nor a human action. */
export function writeSupervisorComparisonUnavailable(
  store: Store,
  supervisor: string,
  main: string,
) {
  const type = "host_deployment_supervisor_comparison_unavailable";
  store.uow.run((tx) => {
    if (
      store.database
        .prepare(`SELECT 1 FROM events WHERE project_id = ? AND type = ? AND card_id IS NULL
      AND json_extract(doc, '$.payload.supervisor') = ? AND json_extract(doc, '$.payload.main') = ? LIMIT 1`)
        .get("cardigan", type, supervisor, main)
    )
      return;
    tx.events.append("cardigan", {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence("cardigan"),
      type,
      actor: { kind: "system", project_id: "cardigan" },
      created_at: new Date().toISOString(),
      payload: { supervisor, main },
    });
  });
}

/** C-767: audit one stage of an automatic supervisor self-upgrade. */
export function writeSupervisorUpgrade(
  store: Store,
  input: {
    attempt: string;
    from: string;
    to: string;
    status: SupervisorUpgradeStatus;
    summary: string;
  },
) {
  store.uow.run((tx) => {
    persistEffect(
      tx,
      "cardigan",
      unwrap(
        recordSupervisorUpgrade(
          loadCommandState(tx, "cardigan"),
          { kind: "system", project_id: "cardigan" },
          input,
          { ids: tx.ids, clock: { now: () => new Date().toISOString() } },
        ),
      ),
    );
  });
}

/** C-767: only this project's self-upgrade audit, never the whole event log. */
export function readSupervisorUpgradeState(store: Store, supervisor: string) {
  return store.uow.read(() => {
    const events = (
      store.database
        .prepare(
          "SELECT doc FROM events WHERE project_id = ? AND type = ? AND card_id IS NULL ORDER BY seq",
        )
        .all("cardigan", "host_supervisor_upgrade") as { doc: string }[]
    ).map((row) => JSON.parse(row.doc) as Event);
    return supervisorUpgradeState(events, "cardigan", supervisor);
  });
}
