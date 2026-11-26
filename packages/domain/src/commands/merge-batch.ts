import type { Actor, Event, JsonValue, MergeCheckView } from "../entities.js";
import { flowAtLeast } from "../flow.js";
import type { MergeBatchId } from "../ids.js";
import {
  activeMergeFamilies,
  batchStartupFailure,
  deferredMergeBatch,
  hasBatchFailureEvidence,
  type MergeBatch,
  type MergeBatchMember,
  mergeBatches,
  passedCardCheck,
} from "../merge-batch.js";
import { transition } from "../transitions.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  unwrap,
} from "./core.js";
import { type MergePlan, mergePlan, prepareMergePlan } from "./merge.js";
import {
  type CheckUpdate,
  systemReturnFailedCheck,
  validateMergeCheckUpdate,
} from "./merge-check.js";
import { latestMergeCheck } from "./merge-check-view.js";
import { hasVerifiedMergeNoop } from "./merge-preparation.js";
import { queueMergedPush } from "./merge-push.js";
import { heldByMergeWindow } from "./merge-window.js";

const sha = (s: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(s);
const failed = (check?: MergeCheckView) =>
  !!check && ["failed", "timed_out"].includes(check.status);
const batchOf = (state: CommandState, id: MergeBatchId) => {
  const batch = mergeBatches(state.events).find((b) => b.id === id);
  ensure(batch, "not_found", "Merge batch was not found");
  return batch;
};
const emit = (
  d: CommandDraft,
  type: string,
  batch: MergeBatch,
  extra: Record<string, JsonValue> = {},
) => d.emit(type, undefined, { batch_id: batch.id, ...extra });

export function mergeQueue(state: CommandState) {
  if (!state.project_settings?.merge_queue) return [];
  const owned = new Set(
    activeMergeFamilies(state.events).flatMap((b) =>
      b.members.map((m) => m.card_id),
    ),
  );
  const queue: {
    plan: MergePlan;
    priority: number;
    entered: string;
    solo: boolean;
  }[] = [];
  for (const card of state.cards) {
    if (
      owned.has(card.id) ||
      card.status !== "awaiting_merge" ||
      heldByMergeWindow(state, card.id)
    )
      continue;
    const plan = mergePlan(state, card.id);
    if (
      !plan.ok ||
      deferredMergeBatch(state.events, card.id, plan.value.completion_id) ||
      !passedCardCheck(state.events, card.id, plan.value.completion_id) ||
      hasVerifiedMergeNoop(state.events, card.id, plan.value.completion_id)
    )
      continue;
    const latest = latestMergeCheck(
      state.events,
      card.id,
      plan.value.completion_id,
    );
    if (
      latest?.level === "batch" &&
      failed(latest) &&
      !latest.recheck_requested
    )
      continue;
    const q = state.decisions.find(
      (q) =>
        q.card_id === card.id &&
        q.trigger === "merge_confirmation" &&
        q.kind === "approve" &&
        "delivery_id" in q.target &&
        q.target.delivery_id === plan.value.completion_id &&
        q.status === "resolved" &&
        q.resolution?.option === "merge",
    );
    const entered =
      q?.resolution?.at ??
      state.events.find(
        (e) =>
          e.card_id === card.id &&
          e.type === "merge_check_finished" &&
          (e.payload as unknown as MergeCheckView).completion_id ===
            plan.value.completion_id &&
          (e.payload as unknown as MergeCheckView).status === "passed",
      )?.created_at;
    if (entered)
      queue.push({
        plan: plan.value,
        priority: card.priority,
        entered,
        solo: card.merge_solo === true,
      });
  }
  return queue.sort(
    (a, b) =>
      b.priority - a.priority ||
      a.entered.localeCompare(b.entered) ||
      a.plan.card_id.localeCompare(b.plan.card_id),
  );
}

/** Publication and formation re-evaluate every member's current authorization. */
export function validateMergeBatchMembers(
  state: CommandState,
  batch: MergeBatch,
) {
  return validateMembers(state, batch, mergePlan);
}

/** Negative evidence only: a hold may fence running/publishing without erasing
 * a timeout already incurred on the still-current set of completions. */
export function validateBatchStartupObservation(
  state: CommandState,
  batch: MergeBatch,
) {
  return validateMembers(state, batch, prepareMergePlan);
}

function validateMembers(
  state: CommandState,
  batch: MergeBatch,
  planFor: typeof mergePlan,
) {
  for (const member of batch.members) {
    const plan = unwrap(planFor(state, member.card_id));
    ensure(
      plan.completion_id === member.completion_id &&
        passedCardCheck(state.events, member.card_id, member.completion_id),
      "stale_target",
      "Batch member changed",
    );
  }
}

/** The baseline branch a batch is built on: that of its members' cards. */
export function mergeBatchBranch(
  state: CommandState,
  batch: Pick<MergeBatch, "members">,
): string | undefined {
  const first = batch.members[0]?.card_id;
  return state.cards.find((c) => c.id === first)?.base_branch;
}

export function formMergeBatch(
  state: CommandState,
  actor: Actor,
  p: {
    base_sha: string;
    members: readonly MergeBatchMember[];
    solo: boolean;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_merge_batch", ports, (d) => {
    const config = state.project_settings?.merge_queue;
    ensure(
      config && state.project_settings?.merge_gate_enabled,
      "illegal_transition",
      "Merge queue is not enabled",
    );

    ensure(
      p.members.length > 0 &&
        p.members.length <= config.max_batch_size &&
        new Set(p.members.map((m) => m.card_id)).size === p.members.length &&
        new Set(p.members.map((m) => m.merge_sha)).size === p.members.length &&
        sha(p.base_sha) &&
        p.members.every(
          (m) =>
            sha(m.merge_sha) &&
            sha(m.tree_sha) &&
            m.merge_sha.length === p.base_sha.length &&
            m.tree_sha.length === p.base_sha.length,
        ),
      "validation_failed",
      "Invalid batch members or commit identities",
    );
    const queue = mergeQueue(state);
    const members = p.members.map((m) => {
      const item = queue.find(
        (q) =>
          q.plan.card_id === m.card_id &&
          q.plan.completion_id === m.completion_id,
      );
      ensure(
        item,
        "illegal_transition",
        "Only confirmed cards with a passed card check may enter a batch",
      );
      return item;
    });
    ensure(
      p.solo ? members.length === 1 : members.every((m) => !m.solo),
      "illegal_transition",
      "Solo cards require a separate batch",
    );
    // One candidate chain is built on one central branch; each branch owns
    // its own queue, so a stuck family never blocks another branch.
    ensure(
      new Set(members.map((m) => m.plan.base_branch)).size === 1,
      "illegal_transition",
      "A merge batch must share one baseline branch",
    );
    const branch = members[0]?.plan.base_branch;
    ensure(
      !activeMergeFamilies(state.events).some(
        (b) => mergeBatchBranch(state, b) === branch,
      ),
      "illegal_transition",
      "Another batch family owns the queue",
    );
    const last = p.members[p.members.length - 1] as MergeBatchMember;
    const batch: MergeBatch = {
      id: d.ids.next(state.project_id, "merge_batch"),
      project_id: state.project_id,
      purpose: "main",
      base_sha: p.base_sha,
      members: p.members,
      final_sha: last.merge_sha,
      final_tree_sha: last.tree_sha,
      solo: p.solo,
      priority: Math.max(...members.map((m) => m.priority)),
      formed_at: d.now,
      status: "checking",
    };
    const { check: _check, ...metadata } = batch;
    d.emit("merge_batch_formed", undefined, {
      ...metadata,
      members: batch.members.map((m) => ({ ...m })),
    });
    stage(d, batch, "batch_checking");
    return batch;
  });
}

function stage(d: CommandDraft, batch: MergeBatch, value: string) {
  for (const member of batch.members)
    d.emit(
      "merge_batch_stage_changed",
      member.card_id,
      { batch_id: batch.id, stage: value },
      {
        type: "status_change",
        body: `${batch.id}：${value === "batch_checking" ? "批次检查中" : value === "bisecting" ? "二分定位中" : "重新排队"}`,
      },
    );
}

export function startMergeBatchBisect(
  state: CommandState,
  actor: Actor,
  p: { batch_id: MergeBatchId },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_merge_batch", ports, (d) => {
    const batch = batchOf(state, p.batch_id);
    ensure(
      batch.purpose === "main" &&
        batch.status === "failed" &&
        hasBatchFailureEvidence(batch.check),
      "illegal_transition",
      "Only a failed main batch can bisect",
    );
    emit(d, "merge_batch_bisect_started", batch);
    stage(d, batch, "bisecting");
    return batch.id;
  });
}

export function formBisectProbe(
  state: CommandState,
  actor: Actor,
  p: { batch_id: MergeBatchId; length: number },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_merge_batch", ports, (d) => {
    const parent = batchOf(state, p.batch_id);
    ensure(
      parent.purpose === "main" &&
        parent.status === "bisecting" &&
        hasBatchFailureEvidence(parent.check) &&
        Number.isSafeInteger(p.length) &&
        p.length > 0 &&
        p.length < parent.members.length,
      "illegal_transition",
      "Probe must be a proper prefix of a bisecting main batch",
    );
    const previous = mergeBatches(state.events).find(
      (b) =>
        b.parent_batch_id === parent.id &&
        b.members.length === p.length &&
        b.status !== "aborted",
    );
    if (previous) return previous;
    validateMergeBatchMembers(state, parent);
    const members = parent.members.slice(0, p.length);
    const last = members[members.length - 1] as MergeBatchMember;
    const batch: MergeBatch = {
      id: d.ids.next(state.project_id, "merge_batch"),
      project_id: state.project_id,
      purpose: "bisect",
      parent_batch_id: parent.id,
      base_sha: parent.base_sha,
      members,
      final_sha: last.merge_sha,
      final_tree_sha: last.tree_sha,
      solo: false,
      priority: parent.priority,
      formed_at: d.now,
      status: "checking",
    };
    const { check: _check, ...metadata } = batch;
    d.emit("merge_batch_formed", undefined, {
      ...metadata,
      members: members.map((m) => ({ ...m })),
    });
    return batch;
  });
}

export function recordMergeBatchCheck(
  state: CommandState,
  actor: Actor,
  p: {
    batch_id: MergeBatchId;
    completion_ids: readonly string[];
    check: CheckUpdate;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_merge_batch", ports, (d) => {
    const batch = batchOf(state, p.batch_id),
      check = p.check;
    ensure(
      batch.status === "checking" ||
        (batch.check?.attempt_id === check.attempt_id &&
          batch.check.status === check.status),
      "illegal_transition",
      "Batch is not accepting a check",
    );
    ensure(
      check.level === "batch" &&
        check.scope?.kind === "full" &&
        check.scope.packages === undefined &&
        check.base_sha === batch.base_sha &&
        check.candidate_sha === batch.final_sha &&
        check.tree_sha === batch.final_tree_sha &&
        check.completion_id === batch.members.at(-1)?.completion_id &&
        check.card_id === batch.members.at(-1)?.card_id &&
        JSON.stringify([...p.completion_ids].sort()) ===
          JSON.stringify(batch.members.map((m) => m.completion_id).sort()),
      "stale_target",
      "Batch check must bind the exact final tree and completion set",
    );
    if (
      "startup_failure" in check &&
      check.startup_failure === "repository_busy"
    )
      validateBatchStartupObservation(state, batch);
    else validateMergeBatchMembers(state, batch);
    if (batch.purpose === "bisect")
      ensure(
        batchOf(state, batch.parent_batch_id as MergeBatchId).status ===
          "bisecting",
        "stale_target",
        "Probe family has already settled",
      );
    const replay = validateMergeCheckUpdate(
      check,
      batch.check,
      batch.check,
      state.events.some(
        (e) =>
          e.type.startsWith("merge_batch_check_") &&
          (e.payload as unknown as { check: MergeCheckView }).check
            ?.attempt_id === check.attempt_id,
      ),
    );
    if (replay) return replay;
    const value: MergeCheckView = {
      ...check,
      batch_id: batch.id,
      checks: "checks" in check ? check.checks : [],
      updated_at: d.now,
    };
    const suffix =
      check.status === "queued"
        ? "queued"
        : check.status === "running"
          ? "started"
          : "finished";
    emit(d, `merge_batch_check_${suffix}`, batch, {
      card_id: check.card_id,
      completion_ids: [...p.completion_ids],
      check: { ...value, checks: value.checks.map((c) => ({ ...c })) },
    });
    return value;
  });
}

/** One confirmation rerun; interrupted/unreachable attempts do not spend it. */
export function requeueMergeBatch(
  state: CommandState,
  actor: Actor,
  p: { batch_id: MergeBatchId },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_merge_batch", ports, (d) => {
    const batch = batchOf(state, p.batch_id);
    ensure(
      ["failed", "bisecting"].includes(batch.status) &&
        hasBatchFailureEvidence(batch.check),
      "illegal_transition",
      "Batch has no failed check to confirm",
    );
    ensure(
      !state.events.some(
        (e) =>
          e.type === "merge_batch_requeued" &&
          (e.payload as { batch_id?: string }).batch_id === batch.id,
      ),
      "illegal_transition",
      "Batch confirmation rerun already consumed",
    );
    emit(d, "merge_batch_requeued", batch);
    return batch.id;
  });
}

export function batchFailures(events: readonly Event[], id: MergeBatchId) {
  return events.filter(
    (e) =>
      e.actor.kind === "system" &&
      !e.card_id &&
      e.type === "merge_batch_check_finished" &&
      (e.payload as unknown as { batch_id: string }).batch_id === id &&
      hasBatchFailureEvidence(
        (e.payload as unknown as { check: MergeCheckView }).check,
      ),
  );
}

export function identifyMergeBatchCulprit(
  state: CommandState,
  actor: Actor,
  p: {
    batch_id: MergeBatchId;
    failed_batch_id: MergeBatchId;
    passed_prefix_id?: MergeBatchId;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_merge_batch", ports, (d) => {
    const batch = batchOf(state, p.batch_id),
      probe = batchOf(state, p.failed_batch_id);
    ensure(
      batch.purpose === "main" &&
        ["failed", "bisecting"].includes(batch.status) &&
        (probe.id === batch.id || probe.parent_batch_id === batch.id) &&
        hasBatchFailureEvidence(batch.check) &&
        hasBatchFailureEvidence(probe.check),
      "illegal_transition",
      "Invalid failed prefix evidence",
    );
    const length = probe.members.length;
    const prefix = p.passed_prefix_id && batchOf(state, p.passed_prefix_id);
    ensure(
      length === 1
        ? !prefix
        : prefix &&
            prefix.parent_batch_id === batch.id &&
            prefix.status === "passed" &&
            prefix.members.length === length - 1,
      "invariant_violation",
      "Culprit requires an immediately preceding passed prefix",
    );
    ensure(
      batchFailures(state.events, batch.id).length +
        (probe.id === batch.id
          ? 0
          : batchFailures(state.events, probe.id).length) >=
        2,
      "invariant_violation",
      "Culprit requires two failed attempts",
    );
    validateMergeBatchMembers(state, batch);
    const member = probe.members[length - 1] as MergeBatchMember;
    emit(d, "merge_batch_culprit_identified", batch, {
      culprit: member.card_id,
      completion_id: member.completion_id,
      failed_batch_id: probe.id,
      ...(prefix ? { published_prefix: prefix.id } : {}),
      evidence: [
        ...batchFailures(state.events, batch.id),
        ...(probe.id === batch.id ? [] : batchFailures(state.events, probe.id)),
      ].map((e) => e.id),
    });
    const check = probe.check as MergeCheckView;
    d.emit(
      "merge_check_finished",
      member.card_id,
      {
        ...check,
        completion_id: member.completion_id,
        level: "batch",
        batch_id: batch.id,
        checks: check.checks.map((c) => ({ ...c })),
      },
      {
        type: "status_change",
        body: `${batch.id} 定位到本卡检查失败：${check.summary ?? check.status}`,
      },
    );
    if (flowAtLeast(d.card(member.card_id), 2))
      systemReturnFailedCheck(d, member.card_id, {
        ...check,
        completion_id: member.completion_id,
        level: "batch",
        batch_id: batch.id,
        // C-766: bisection is the evidence; the prefix without this card passed.
        failure_class: prefix
          ? {
              label: "genuine",
              basis: `批次二分：不含本卡的前缀 ${prefix.id} 已通过，加入本卡后 ${probe.id} 失败`,
            }
          : {
              label: "unknown",
              basis: `批次二分只剩本卡（${probe.id}）仍失败，无法区分本卡改动与基线`,
            },
      });
    return member.card_id;
  });
}

export function beginMergeBatchPublish(
  state: CommandState,
  actor: Actor,
  p: { batch_id: MergeBatchId },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_merge_batch", ports, (d) => {
    const batch = batchOf(state, p.batch_id);
    if (batch.status === "publishing") return batch;
    ensure(
      batch.status === "passed" && batch.check?.status === "passed",
      "illegal_transition",
      "Batch has not passed",
    );
    validateMergeBatchMembers(state, batch);
    if (batch.purpose === "bisect") {
      const parent = batchOf(state, batch.parent_batch_id as MergeBatchId);
      ensure(
        parent.status === "resolved" && parent.published_prefix === batch.id,
        "illegal_transition",
        "Only the proven prefix may publish",
      );
    }
    emit(d, "merge_batch_publishing", batch, {
      base_sha: batch.base_sha,
      final_sha: batch.final_sha,
    });
    return { ...batch, status: "publishing" as const };
  });
}

export function recordMergeBatchResult(
  state: CommandState,
  actor: Actor,
  p: { batch_id: MergeBatchId },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_merge_batch", ports, (d) => {
    const batch = batchOf(state, p.batch_id);
    if (batch.status === "published") return batch;
    ensure(
      batch.status === "publishing" && batch.check?.status === "passed",
      "illegal_transition",
      "Batch publication intent is required",
    );
    validateMergeBatchMembers(state, batch);
    emit(d, "merge_batch_published", batch, {
      previous_sha: batch.base_sha,
      final_sha: batch.final_sha,
      final_tree_sha: batch.final_tree_sha,
      members: batch.members.map((m) => ({ ...m })),
    });
    let previous = batch.base_sha;
    for (const member of batch.members) {
      const card = d.card(member.card_id);
      d.put("cards", {
        ...card,
        status: unwrap(transition("card", card.status, "merge_succeeded")),
        resolution: "done",
      });
      const peers = batch.members
        .filter((m) => m.card_id !== card.id)
        .map((m) => m.card_id);
      const event = d.emit(
        "card_merged",
        card.id,
        {
          completion_id: member.completion_id,
          batch_id: batch.id,
          batch_peers: peers,
          result: {
            kind: "merged",
            merge_sha: member.merge_sha,
            previous_sha: previous,
            tree_sha: member.tree_sha,
          },
        },
        {
          type: "status_change",
          body: `随 ${batch.id} 合并${peers.length ? `，同批 ${peers.join("、")}` : ""}`,
        },
      );
      queueMergedPush(d, {
        merge_event_id: event.id,
        card_id: card.id,
        completion_id: member.completion_id,
        sha: member.merge_sha,
        base_branch: card.base_branch,
      });
      previous = member.merge_sha;
    }
    return { ...batch, status: "published" as const };
  });
}

export function abortMergeBatch(
  state: CommandState,
  actor: Actor,
  p: {
    batch_id: MergeBatchId;
    reason: "stale" | "member_left" | "interrupted" | "repository_busy";
  },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_merge_batch", ports, (d) => {
    const batch = batchOf(state, p.batch_id);
    ensure(
      batch.status !== "publishing" && batch.status !== "published",
      "illegal_transition",
      "正在合并",
    );
    if (batch.status === "aborted") return batch;
    ensure(
      !mergeBatches(state.events).some(
        (b) => b.parent_batch_id === batch.id && b.status === "publishing",
      ),
      "illegal_transition",
      "正在合并",
    );
    const family = mergeBatches(state.events).filter(
      (b) => b.id === batch.id || b.parent_batch_id === batch.id,
    );
    if (p.reason === "repository_busy") {
      const failed = batchStartupFailure(family);
      ensure(
        batch.purpose === "main" &&
          ["failed", "bisecting"].includes(batch.status) &&
          failed &&
          !family.some((b) => b.status === "checking"),
        "illegal_transition",
        "Batch has no settled startup failure",
      );
      for (const m of batch.members)
        d.emit(
          "merge_batch_member_deferred",
          m.card_id,
          {
            batch_id: batch.id,
            failed_batch_id: failed.id,
            completion_id: m.completion_id,
          },
          {
            type: "status_change",
            body: `${batch.id} 因仓库忙停止，未判定卡片失败。锁释放后可用 cardigan merge recheck ${m.card_id} 重新排队。`,
          },
        );
    }
    for (const b of family)
      if (!["published", "aborted"].includes(b.status)) {
        if (b.check && ["queued", "running"].includes(b.check.status))
          emit(d, "merge_batch_check_finished", b, {
            card_id: b.members.at(-1)?.card_id ?? "",
            completion_ids: b.members.map((m) => m.completion_id),
            check: {
              ...b.check,
              status: "interrupted",
              checks: [],
              summary: "批次已中止",
              updated_at: d.now,
            },
          });
        emit(d, "merge_batch_aborted", b, { reason: p.reason });
      }
    if (p.reason !== "repository_busy") stage(d, batch, "requeued");
    return batch;
  });
}

/** Host has verified the observed baseline neither equals nor contains final_sha. */
export function abortMergeBatchPublish(
  state: CommandState,
  actor: Actor,
  p: {
    batch_id: MergeBatchId;
    observed_base_sha: string;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_merge_batch", ports, (d) => {
    const batch = batchOf(state, p.batch_id);
    ensure(
      batch.status === "publishing" &&
        sha(p.observed_base_sha) &&
        p.observed_base_sha !== batch.base_sha &&
        p.observed_base_sha !== batch.final_sha,
      "illegal_transition",
      "Invalid stale publication recovery",
    );
    emit(d, "merge_batch_aborted", batch, {
      reason: "stale",
      observed_base_sha: p.observed_base_sha,
    });
    stage(d, batch, "requeued");
    return batch;
  });
}

export function recordMergeQueueConfiguration(
  state: CommandState,
  actor: Actor,
  _p: Record<string, never>,
  ports: CommandPorts,
) {
  return command(state, actor, "manage_merge_batch", ports, (d) => {
    const config = state.project_settings?.merge_queue ?? null;
    const previous = state.events.findLast(
      (e) => !e.card_id && e.type === "merge_queue_configured",
    );
    if (
      (!previous && !config) ||
      JSON.stringify(previous?.payload) === JSON.stringify(config)
    )
      return;
    d.emit("merge_queue_configured", undefined, config ? { ...config } : null);
  });
}
