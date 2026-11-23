import {
  type Actor,
  type Assignment,
  type CommandEffect,
  type Decision,
  type DecisionId,
  type Event,
  finishRun,
  issueInstruction,
  queueRun,
  type Result,
  type Run,
  type TimelineEntry,
  type WorkItem,
  type WorkItemId,
} from "../../index.js";
import {
  flowReviewFixture,
  required,
} from "../flow-review-limit/test-fixtures.js";
import { assignment, human, role } from "../test-fixtures.js";

type Fixture = ReturnType<typeof flowReviewFixture>["f"];

function ops(f: Fixture) {
  const { work_item_id: _work, ...base } = assignment(900, "pm");
  const owner: Assignment = {
    ...base,
    scope: "standing",
    standing_mode: "ops",
  };
  f.commit({
    ok: true,
    value: {
      data: null,
      changes: [{ collection: "assignments", entity: owner }],
      events: [],
      timeline: [],
      token_requests: [],
    },
  });
  return {
    kind: "assignment",
    project_id: f.state.project_id,
    assignment_id: owner.id,
    ...role("pm"),
  } satisfies Actor;
}

/**
 * The two legacy paths C-610 left on PM: a streak decision that predates the
 * alignment round (opened under flow 4, card now on 5), and a disputed round.
 */
export interface HeldReviewer {
  readonly f: Fixture;
  readonly q: Decision;
  readonly pm: Actor;
  readonly verifierId: WorkItemId;
  verifier(): WorkItem;
  ask(
    work_item_id?: WorkItemId,
    decision_id?: DecisionId,
  ): Result<CommandEffect<TimelineEntry | undefined>>;
  lastEvent(): Event;
  queue(trigger: Event): Result<CommandEffect<Run>>;
  finish(owner: Assignment): void;
}

export async function heldReviewer(
  path: "legacy" | "disputed",
): Promise<HeldReviewer> {
  const { f, review, reconcile, dispute } = flowReviewFixture(
    undefined,
    path === "legacy" ? 4 : 5,
  );
  // PM Ops exists before the streak, so the decision is routed to it.
  const pm = ops(f);
  for (let n = 0; n < 3; n++) {
    review(await f.deliver("code", (n + 1).toString().repeat(40)));
    if (n === 2 && path === "disputed") dispute();
    f.commit(reconcile());
  }
  if (path === "legacy")
    f.commit({
      ok: true,
      value: {
        data: null,
        changes: [
          {
            collection: "cards",
            entity: { ...required(f.state.cards[0]), flow_version: 5 },
          },
        ],
        events: [],
        timeline: [],
        token_requests: [],
      },
    });
  const q = required(f.state.decisions.at(-1));
  if (
    q.trigger !== "review_limit" ||
    q.status !== "open" ||
    q.decider !== "role:pm"
  )
    throw new Error(`Expected an open PM review-limit decision, got ${q.id}`);
  const verifierId = required(f.reviewer.work_item_id);
  const verifier = () =>
    required(f.state.work_items.find((w) => w.id === verifierId));
  if (verifier().status !== "waiting_decision")
    throw new Error("Expected the verifier to wait on the decision");
  const finish = (owner: Assignment) => {
    for (const r of f.state.runs.filter(
      (r) => r.assignment_id === owner.id && r.status === "running",
    ))
      f.commit(
        finishRun(
          f.state,
          f.actor(owner),
          { run_id: r.id, outcome: "completed", summary: "Answered" },
          f.io,
        ),
      );
  };
  finish(f.reviewer);
  const ask = (work_item_id = verifierId, decision_id = q.id) =>
    issueInstruction(
      f.state,
      pm,
      {
        card_id: f.card.id,
        work_item_id,
        decision_id,
        body: "请确认作者在卡上的续审方案方向，或补充意见。",
      },
      f.io,
    );
  const lastEvent = () => required(f.state.events.at(-1));
  const queue = (trigger: Event) =>
    queueRun(
      f.state,
      human,
      {
        assignment_id: f.reviewer.id,
        model: "fixture-model",
        agent_cli_version: "1",
        trigger_event_id: trigger.id,
      },
      f.io,
    );
  return { f, q, pm, verifierId, verifier, ask, lastEvent, queue, finish };
}
