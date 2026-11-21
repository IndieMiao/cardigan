import {
  type Assignment,
  assignmentCardHeld,
  assignmentDependenciesAllowStart,
  type CardId,
  type CommandState,
  eventsOfType,
  hasRunTarget,
  type Notification,
  runById,
  runsOf,
  stoppedByHuman,
} from "@cardigan/domain";

export function dispatchStallMs() {
  const value = Number(process.env.CARDIGAN_DISPATCH_STALL_MS ?? 600_000);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("Invalid CARDIGAN_DISPATCH_STALL_MS");
  return value;
}
export type StallKind =
  | "notification_backlog"
  | "resume_not_dispatched"
  | "standing_backlog"
  | "owner_not_woken";
export interface DispatchStall {
  kind: StallKind;
  assignment_id: Assignment["id"];
  card_id: CardId | null;
  cause_id: string;
  age_ms: number;
  runtime_state: Assignment["runtime_state"];
  machine_id: string;
  restart_blocked: string | null;
}

/** Only current actionable work: an old rejection, held card or retired assignee is not a restart request. */
export function dispatchStalls(
  state: CommandState,
  notes: readonly Notification[],
  now: string,
  threshold = dispatchStallMs(),
) {
  const found = new Map<string, DispatchStall>();
  const assignments = new Map(state.assignments.map((a) => [a.id, a]));
  const items = new Map(state.work_items.map((w) => [w.id, w]));
  const cards = new Map(state.cards.map((c) => [c.id, c]));
  const latestQueue = new Map<string, string>();
  for (const e of eventsOfType(state.events, "run_queued")) {
    const id = (e.payload as { assignment_id: string }).assignment_id;
    const last = latestQueue.get(id);
    if (!last || e.created_at > last) latestQueue.set(id, e.created_at);
  }
  function add(
    kind: StallKind,
    a: Assignment | undefined,
    cause: string,
    at: string,
    sourceCard?: CardId,
  ) {
    const age = Date.parse(now) - Date.parse(at);
    if (
      !(age >= threshold) ||
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
    const blocked = (() => {
      if (stoppedByHuman(state.events, a.id)) return "human_stopped";
      if (a.role_upgrade || a.idle_retirement?.phase === "stopping")
        return "session_maintenance";
      const parent = card && cards.get(card);
      if (parent && ["done", "cancelled"].includes(parent.status))
        return "closed_card";
      if (parent?.hold || assignmentCardHeld(a, state)) return "card_held";
      if (!assignmentDependenciesAllowStart(state, a)) return "dependencies";
      if (!hasRunTarget(a, state)) return "no_target";
      if (
        w &&
        !["in_progress", "ready", "todo", "changes_requested"].includes(
          w.status,
        )
      )
        return "work_item_wait";
      return null;
    })();
    if (
      blocked &&
      (kind === "resume_not_dispatched" || kind === "owner_not_woken")
    )
      return;
    const runs = runsOf(state.runs, a.id);
    if (
      runs.some(
        (r) =>
          !["completed", "cancelled", "failed"].includes(r.status) ||
          r.dispatch_stop ||
          r.inactivity_stop,
      )
    )
      return;
    if (
      (kind === "owner_not_woken" || kind === "resume_not_dispatched") &&
      (latestQueue.get(a.id) ?? "") >= at
    )
      return;
    const key = `${a.id}/${kind}/${card ?? ""}`;
    if ((found.get(key)?.age_ms ?? -1) >= age) return;
    found.set(key, {
      kind,
      assignment_id: a.id,
      card_id: card ?? null,
      cause_id: cause,
      age_ms: age,
      runtime_state: a.runtime_state,
      restart_blocked: blocked,
      machine_id: a.machine_id,
    });
  }
  for (const n of notes) {
    if (
      !["pending", "belled", "delivery_failed"].includes(n.status) ||
      n.recipient.kind === "needs_you" ||
      (n.next_attempt_at && n.next_attempt_at > now)
    )
      continue;
    const sent = n.run_id && runById(state.runs, n.run_id);
    const a =
      n.recipient.kind === "assignment"
        ? assignments.get(n.recipient.assignment_id)
        : sent
          ? assignments.get(sent.assignment_id)
          : state.assignments.find(
              (a) =>
                a.scope === "standing" &&
                a.status === "active" &&
                a.role_id === "pm" &&
                a.standing_mode ===
                  (n.recipient.kind === "pm_ops" ? "ops" : "office"),
            );
    if (
      !a ||
      state.cursors.some(
        (c) =>
          c.assignment_id === a.id &&
          c.card_id === (n.card_id ?? "") &&
          c.acked_seq >= n.seq,
      )
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
      n.id,
      last,
      n.card_id,
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
      add("resume_not_dispatched", a, e.id, e.created_at, e.card_id);
  }
  // Instructions carry a structured recipient even when their notification was lost.
  for (const e of eventsOfType(state.events, "instruction_issued")) {
    const w = items.get(
      (e.payload as { work_item_id: NonNullable<Assignment["work_item_id"]> })
        .work_item_id,
    );
    if (w?.assignment_id)
      add(
        "owner_not_woken",
        assignments.get(w.assignment_id),
        e.id,
        e.created_at,
        e.card_id,
      );
  }
  const deliveries = new Map(state.deliveries.map((d) => [d.id, d]));
  const currentDelivery = new Map(
    state.deliveries.map((d) => [d.work_item_id, d.id]),
  );
  const currentReviews = new Set<string>(
    state.reviews.filter((r) => !r.withdrawn).map((r) => r.id),
  );
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
    if (
      w?.assignment_id &&
      currentDelivery.get(w.id) === d?.id &&
      currentReviews.has(p.review_id)
    )
      add(
        "owner_not_woken",
        assignments.get(w.assignment_id),
        e.id,
        e.created_at,
        e.card_id,
      );
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
      add(
        "owner_not_woken",
        assignments.get(w.assignment_id),
        reply.id,
        reply.created_at,
        q.card_id,
      );
  }
  return [...found.values()];
}
