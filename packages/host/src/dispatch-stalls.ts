import { createHash } from "node:crypto";
import {
  type Assignment,
  assignmentCardHeld,
  assignmentDependenciesAllowStart,
  type CardId,
  type CommandState,
  decisionFollowupBlocked,
  type Event,
  eventById,
  eventsOfType,
  type HostOpsExecution,
  hasRunTarget,
  type Notification,
  pmNotificationState,
  retirementStallHandoff,
  reviewDiscussionInstruction,
  reviewWakeBlocked,
  runById,
  runsOf,
  sharedStallRegistration,
  stoppedByHuman,
  systemEndedTurn,
  untouchedStallSuccessor,
} from "@cardigan/domain";
import type { standingResolver } from "@cardigan/store";

export function turnSessionKey(a: Assignment) {
  return createHash("sha256")
    .update(JSON.stringify([a.session_ref, a.runtime_ref]))
    .digest("hex");
}
export function dispatchStallMs() {
  const value = Number(process.env.CARDIGAN_DISPATCH_STALL_MS ?? 600_000);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("Invalid CARDIGAN_DISPATCH_STALL_MS");
  return value;
}
export type StallKind =
  | "retirement_wait"
  | "running_wait"
  | "queued_successor"
  | "notification_backlog"
  | "resume_not_dispatched"
  | "standing_backlog"
  | "owner_not_woken";
export interface DispatchStall {
  kind: StallKind;
  assignment_id: Assignment["id"];
  card_id: CardId | null;
  cause_id: string;
  review_trigger_id?: Event["id"];
  handoff_event_id?: Event["id"];
  system_finished_run_id?: string;
  retirement_handoff?: NonNullable<HostOpsExecution["retirement_handoff"]>;
  age_ms: number;
  runtime_state: Assignment["runtime_state"];
  machine_id: string;
  restart_blocked: string | null;
}

export function dispatchHandoffs(state: CommandState) {
  // A durable dispatch handoff retires the original bell, not the incident. Never
  // use unrelated needs_attention rows (e.g. retry exhaustion) to stop a session.
  const handoffs = new Map<string, { owner: string; event: Event }>();
  for (const type of [
    "standing_inbox_stalled",
    "bell_wake_escalated",
    "bell_turn_recovery_due",
  ]) {
    for (const event of eventsOfType(state.events, type)) {
      const p = event.payload as {
        assignment_id: string;
        reason: string;
        notification_ids?: string[];
      };
      if (
        event.actor.kind !== "system" ||
        !Array.isArray(p.notification_ids) ||
        !(type === "standing_inbox_stalled"
          ? p.reason === "pending_without_run"
          : ["system_finished_turn", "unread_reminder"].includes(p.reason))
      )
        continue;
      for (const id of p.notification_ids)
        handoffs.set(id, { owner: p.assignment_id, event });
    }
  }
  return handoffs;
}

/** Only current actionable work: an old rejection, held card or retired assignee is not a restart request. */
export function dispatchStallCauses(
  state: CommandState,
  notes: readonly Notification[],
  handoffs: ReturnType<typeof dispatchHandoffs>,
  now: string,
  standing: ReturnType<typeof standingResolver>,
  threshold = dispatchStallMs(),
) {
  const found: DispatchStall[] = [];
  const assignments = new Map(state.assignments.map((a) => [a.id, a]));
  const items = new Map(state.work_items.map((w) => [w.id, w]));
  const cards = new Map(state.cards.map((c) => [c.id, c]));
  const deliveries = new Map(state.deliveries.map((d) => [d.id, d]));
  const currentDelivery = new Map(
    state.deliveries.map((d) => [d.work_item_id, d.id]),
  );
  const currentReviews = new Set<string>(
    state.reviews.filter((r) => !r.withdrawn).map((r) => r.id),
  );
  // Check the live rejection for both the durable notification and the missing-bell path.
  function staleOwnerRejection(
    e: Event,
    w: CommandState["work_items"][number],
  ) {
    if (e.type !== "review_submitted") return false;
    const p = e.payload as {
      verdict?: string;
      rework_allowed?: boolean;
      review_id: string;
      delivery_id: CommandState["deliveries"][number]["id"];
    };
    const d = deliveries.get(p.delivery_id);
    return (
      p.verdict === "reject" &&
      d?.work_item_id === w.id &&
      (!p.rework_allowed ||
        d.status !== "rejected" ||
        currentDelivery.get(w.id) !== d.id ||
        !currentReviews.has(p.review_id))
    );
  }
  const acked = new Map(
    state.cursors.map((c) => [`${c.assignment_id}/${c.card_id}`, c.acked_seq]),
  );
  const recipients = new Map<
    "pm_ops" | "pm_office",
    Assignment["id"] | undefined
  >();
  function logicalOwner(kind: "pm_ops" | "pm_office") {
    if (!recipients.has(kind))
      recipients.set(kind, standing(state.project_id, kind, state));
    return recipients.get(kind);
  }
  const latestQueue = new Map<string, string>();
  for (const e of eventsOfType(state.events, "run_queued")) {
    const id = (e.payload as { assignment_id: string }).assignment_id;
    const last = latestQueue.get(id);
    if (!last || e.created_at > last) latestQueue.set(id, e.created_at);
  }
  function add(
    kind: StallKind,
    a: Assignment | undefined,
    source: Pick<Event, "seq" | "card_id" | "created_at"> & { id: string },
    trigger = eventById(state.events, source.id),
    handoff?: Event,
    auditOnly?: string,
    transfer?: HostOpsExecution["retirement_handoff"],
  ) {
    const { id: cause, created_at: at, card_id: sourceCard, seq } = source;
    const age = Date.parse(now) - Date.parse(at);
    const due =
      handoff?.type === "bell_turn_recovery_due" ? handoff : undefined;
    const binding = due?.payload as
      | { run_id: string; session_key: string; queued_run_id?: string }
      | undefined;
    if (
      (!auditOnly && !due && !transfer && !(age >= threshold)) ||
      !a ||
      at < a.created_at ||
      a.status !== "active" ||
      a.external
    )
      return;
    const w = a.scope === "work_item" ? items.get(a.work_item_id) : undefined;
    const card = sourceCard ?? w?.card_id;
    if (
      (a.scope === "work_item" && (!w || w.assignment_id !== a.id)) ||
      (card && !cards.has(card))
    )
      return;
    // Sequence numbers are local to the source stream, not to the displayed card.
    if (
      kind !== "retirement_wait" &&
      kind !== "running_wait" &&
      kind !== "queued_successor" &&
      (acked.get(`${a.id}/${sourceCard ?? ""}`) ?? -1) >= seq
    )
      return;
    const runs = runsOf(state.runs, a.id);
    const unfinished = runs.some(
      (r) =>
        !["completed", "cancelled", "failed"].includes(r.status) ||
        r.dispatch_stop ||
        r.inactivity_stop,
    );
    const onlySuccessor =
      (!!binding || !!transfer) &&
      runs.some((r) => untouchedStallSuccessor(state, a, r));
    if (unfinished && !due && !auditOnly && !transfer) return;
    const blocked = (() => {
      // A preflight incident has no stop authority, but still reports a real
      // human stop, work-item wait or active execution in preference to it.
      if (auditOnly && auditOnly !== "launch_snapshot_unavailable")
        return auditOnly;
      if (sharedStallRegistration(state, a)) return "shared_registration";
      if (
        binding?.queued_run_id &&
        !runs.some(
          (r) =>
            r.id === binding.queued_run_id &&
            untouchedStallSuccessor(state, a, r),
        )
      )
        return "queue_changed";
      if (unfinished && !onlySuccessor) return "unfinished_run";
      // Our own recovery settled the session, then its successor launch was
      // refused: the unbound queue is still this incident, for Ops to take over.
      const settledByRefusal =
        !!binding &&
        !a.runtime_ref &&
        eventsOfType(state.events, "retained_writer_refused").some((e) => {
          const p = e.payload as {
            assignment_id?: string;
            run_id?: string;
            system_finished_run_id?: string;
          };
          return (
            p.assignment_id === a.id &&
            p.system_finished_run_id === binding.run_id &&
            (!binding.queued_run_id || p.run_id === binding.queued_run_id)
          );
        });
      if (
        binding &&
        ((binding.session_key !== turnSessionKey(a) && !settledByRefusal) ||
          systemEndedTurn(state, a)?.id !== binding.run_id)
      )
        return "turn_binding_changed";
      if (stoppedByHuman(state.events, a.id)) return "human_stopped";
      if (a.role_upgrade || (a.idle_retirement && !transfer))
        return "session_maintenance";
      const parent = card && cards.get(card);
      if (parent && ["done", "cancelled"].includes(parent.status))
        return "closed_card";
      if (parent?.hold || assignmentCardHeld(a, state)) return "card_held";
      if (!assignmentDependenciesAllowStart(state, a)) return "dependencies";
      if (
        trigger &&
        (decisionFollowupBlocked(state, trigger.id, a.id) ||
          (w &&
            (reviewWakeBlocked(state, trigger, w.id) ||
              staleOwnerRejection(trigger, w))))
      )
        return "trigger_blocked";
      if (!hasRunTarget(a, state)) return "no_target";
      if (
        w &&
        !(
          w.status === "waiting_decision" &&
          reviewDiscussionInstruction(w, trigger, state)
        ) &&
        // C-618: a delivered author is asked to supply unblocked evidence.
        !(w.status === "delivered" && evidenceUnblockedInstruction(trigger)) &&
        !["in_progress", "ready", "todo", "changes_requested"].includes(
          w.status,
        )
      )
        return "work_item_wait";
      return auditOnly ?? null;
    })();
    if (
      blocked &&
      (kind === "resume_not_dispatched" || kind === "owner_not_woken")
    )
      return;
    if (
      (kind === "owner_not_woken" || kind === "resume_not_dispatched") &&
      (latestQueue.get(a.id) ?? "") >= at
    )
      return;
    found.push({
      kind,
      assignment_id: a.id,
      card_id: card ?? null,
      cause_id: due?.id ?? cause,
      ...(binding ? { system_finished_run_id: binding.run_id } : {}),
      ...(transfer ? { retirement_handoff: transfer } : {}),
      ...(handoff ? { handoff_event_id: handoff.id } : {}),
      ...(trigger &&
      (trigger.type === "review_submitted" ||
        trigger.type === "decision_resolved" ||
        (w && reviewDiscussionInstruction(w, trigger, state)))
        ? { review_trigger_id: trigger.id }
        : {}),
      age_ms: age,
      runtime_state: a.runtime_state,
      restart_blocked: blocked,
      machine_id: a.machine_id,
    });
  }
  // A preflight rejection happened before a bell or Run existed. It describes
  // missing launch configuration, not a missing process. Link only the exact
  // undelivered notes in the host failure; a retry/ACK/new queue retires it.
  const failures = new Map<string, Event>();
  const failed = new Set(
    notes
      .filter((n) => n.status === "delivery_failed" && !n.run_id && !n.attempts)
      .map((n) => n.id),
  );
  if (failed.size) {
    for (const event of eventsOfType(state.events, "bell_delivery_failed")) {
      const p = event.payload as {
        reason?: string;
        run_id?: string;
        notification_ids?: string[];
      };
      if (
        event.actor.kind !== "system" ||
        p.reason !== "snapshot_unavailable" ||
        p.run_id ||
        !Array.isArray(p.notification_ids)
      )
        continue;
      for (const id of p.notification_ids)
        if (failed.has(id)) failures.set(id, event);
    }
  }
  const preflightOwners = new Set<Assignment["id"]>();
  for (const n of notes) {
    if (
      !["pending", "belled", "delivery_failed", "needs_attention"].includes(
        n.status,
      ) ||
      n.recipient.kind === "needs_you" ||
      (n.next_attempt_at && n.next_attempt_at > now)
    )
      continue;
    // The original incident remains visible. Deliver its PM reminder normally,
    // but never open a second stall solely because that reminder is still unread.
    if (
      eventById(state.events, n.event_id)?.type ===
      "dispatch_stall_handoff_overdue"
    )
      continue;
    const sent = n.run_id && runById(state.runs, n.run_id);
    const owner =
      n.recipient.kind === "assignment"
        ? n.recipient.assignment_id
        : sent
          ? sent.assignment_id
          : logicalOwner(n.recipient.kind);
    const a = owner && assignments.get(owner);
    if (!a) continue;
    const failure = failures.get(n.id);
    if (
      failure &&
      a.scope === "work_item" &&
      a.runtime_ref &&
      n.recipient.kind === "assignment" &&
      (failure.payload as { assignment_id?: string }).assignment_id === a.id &&
      failure.created_at >= n.created_at
    ) {
      // Superseded failures must not fall back into the generic backlog.
      if (
        (acked.get(`${a.id}/${n.card_id ?? ""}`) ?? -1) >= n.seq ||
        (latestQueue.get(a.id) ?? "") > n.created_at
      )
        continue;
      preflightOwners.add(a.id);
      add(
        "notification_backlog",
        a,
        { ...n, id: failure.id },
        eventById(state.events, n.event_id),
        failure,
        "launch_snapshot_unavailable",
      );
      continue;
    }
    const entry = handoffs.get(n.id);
    const handoff =
      n.status === "needs_attention" ||
      (n.status === "pending" &&
        entry?.event.type === "bell_turn_recovery_due" &&
        entry.owner === a.id)
        ? entry
        : undefined;
    if (
      n.status === "needs_attention" &&
      (!handoff ||
        handoff.owner !== a.id ||
        handoff.event.created_at !== n.updated_at ||
        (latestQueue.get(a.id) ?? "") >= n.updated_at ||
        (a.standing_mode === "ops" &&
          pmNotificationState(state, n) === "obsolete"))
    )
      continue;
    const last =
      a.scope === "standing"
        ? runsOf(state.runs, a.id).reduce(
            (v, r) => (r.started_at && r.started_at > v ? r.started_at : v),
            n.created_at > a.created_at ? n.created_at : a.created_at,
          )
        : n.created_at;
    add(
      a.scope === "standing" ? "standing_backlog" : "notification_backlog",
      a,
      { ...n, created_at: last },
      eventById(state.events, n.event_id),
      handoff?.event,
    );
  }
  // Expose existing supervisor incidents, without treating their age as stop
  // authority. Do not turn ordinary comments on a working Run into incidents.
  for (const e of eventsOfType(state.events, "run_queued")) {
    const p = e.payload as { assignment_id: Assignment["id"]; run_id: string };
    const a = assignments.get(p.assignment_id);
    if (!a?.idle_retirement?.handoff) continue;
    const queue = runById(state.runs, p.run_id);
    if (queue?.status !== "queued") continue;
    const handoff = retirementStallHandoff(state, a, e.id);
    add(
      "retirement_wait",
      a,
      e,
      eventById(state.events, queue.trigger_event_id),
      undefined,
      handoff ? undefined : "retirement_handoff_changed",
      handoff,
    );
  }
  for (const a of state.assignments) {
    const wait = a.idle_retirement?.dispatch_wait;
    const event = wait && eventById(state.events, wait.event_id);
    const queue =
      event &&
      runById(state.runs, (event.payload as { run_id: string }).run_id);
    if (
      !a.idle_retirement?.handoff &&
      event?.type === "session_maintenance_attention" &&
      event.actor.kind === "system" &&
      queue?.assignment_id === a.id &&
      queue.status === "queued" &&
      a.idle_retirement?.phase === "waiting"
    ) {
      add(
        "retirement_wait",
        a,
        event,
        event,
        undefined,
        "retirement_exit_unconfirmed",
      );
    }
  }
  const liveNotes = new Set(
    notes.filter((n) => n.status !== "needs_attention").map((n) => n.id),
  );
  const belled = new Set(
    notes.filter((n) => n.status === "belled").map((n) => n.run_id),
  );
  for (const type of ["run_inbox_stalled", "run_inactive"])
    for (const event of eventsOfType(state.events, type)) {
      const p = event.payload as {
        assignment_id: Assignment["id"];
        run_id: string;
        notification_ids?: string[];
      };
      const r = runById(state.runs, p.run_id);
      if (
        event.actor.kind !== "system" ||
        r?.status !== "running" ||
        r.assignment_id !== p.assignment_id ||
        !(type === "run_inactive"
          ? belled.has(r.id)
          : p.notification_ids?.some((id) => liveNotes.has(id)))
      )
        continue;
      add(
        "running_wait",
        assignments.get(p.assignment_id),
        event,
        event,
        undefined,
        "client_execution_unconfirmed",
      );
    }
  // An empty bell has no Notification row. Bind it to this precise queue, not
  // whatever happens to be waiting at the address when the next patrol runs.
  for (const e of eventsOfType(state.events, "bell_turn_recovery_due")) {
    const p = e.payload as {
      queued_run_id?: string;
      run_id?: string;
      assignment_id: string;
      session_key?: string;
    };
    if (!p.queued_run_id || e.actor.kind !== "system") continue;
    const owner = assignments.get(p.assignment_id as Assignment["id"]),
      queue = runById(state.runs, p.queued_run_id);
    if (
      owner &&
      queue &&
      untouchedStallSuccessor(state, owner, queue) &&
      p.session_key === turnSessionKey(owner) &&
      systemEndedTurn(state, owner)?.id === p.run_id
    )
      add(
        "queued_successor",
        owner,
        e,
        eventById(state.events, queue.trigger_event_id),
        e,
      );
  }
  for (const e of eventsOfType(state.events, "work_item_resume_requested")) {
    const p = e.payload as {
      assignment_id: Assignment["id"];
      work_item_id: string;
      role_version?: number;
    };
    const a = assignments.get(p.assignment_id);
    if (
      a?.work_item_id === p.work_item_id &&
      (!p.role_version || p.role_version === a?.role_version)
    )
      add("resume_not_dispatched", a, e);
  }
  // Instructions carry a structured recipient even when their notification was lost.
  for (const e of eventsOfType(state.events, "instruction_issued")) {
    const w = items.get(
      (e.payload as { work_item_id: NonNullable<Assignment["work_item_id"]> })
        .work_item_id,
    );
    if (w?.assignment_id)
      add("owner_not_woken", assignments.get(w.assignment_id), e);
  }
  for (const e of eventsOfType(state.events, "review_submitted")) {
    const p = e.payload as {
      review_id: string;
      verdict: string;
      rework_allowed?: boolean;
      delivery_id: CommandState["deliveries"][number]["id"];
    };
    if (p.verdict !== "reject" || !p.rework_allowed) continue;
    const d = deliveries.get(p.delivery_id);
    const w = d && items.get(d.work_item_id);
    if (w?.assignment_id)
      add("owner_not_woken", assignments.get(w.assignment_id), e);
  }
  // A reviewer can reply to the current proposal without confirming it. Match the reply and the designated verifier, not words in the comment.
  for (const q of state.decisions) {
    const b = q.review_intervention;
    if (
      q.status !== "resolved" ||
      !b?.proposal ||
      b.confirmation ||
      q.resolution?.option !== "change_approach"
    )
      continue;
    const w = items.get(b.producer_id);
    const verifier = state.work_items.find(
      (v) =>
        v.kind === "verify" &&
        v.review_plan_target === q.id &&
        v.status !== "cancelled",
    );
    const reply =
      verifier?.assignment_id &&
      state.timeline.findLast(
        (t) =>
          t.reply_to === b.proposal &&
          !t.retracted &&
          t.author === `assignment:${verifier.assignment_id}`,
      );
    if (w?.assignment_id && reply)
      add("owner_not_woken", assignments.get(w.assignment_id), {
        ...reply,
        seq: reply.event_seq,
      });
  }
  // The same resume/instruction may also be visible through its source event
  // or a sibling notification. None is a second, address-based restart path.
  return found.filter(
    (s) =>
      !preflightOwners.has(s.assignment_id) ||
      s.restart_blocked ||
      s.system_finished_run_id ||
      s.retirement_handoff,
  );
}

/** C-618: the system's one-time request to supply evidence after a platform blocker. */
function evidenceUnblockedInstruction(trigger: Event | undefined): boolean {
  return (
    trigger?.type === "instruction_issued" &&
    trigger.actor.kind === "system" &&
    Array.isArray(
      (trigger.payload as { evidence_unblocked?: unknown } | null)
        ?.evidence_unblocked,
    )
  );
}
