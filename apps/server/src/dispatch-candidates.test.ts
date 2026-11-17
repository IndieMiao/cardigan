/**
 * C-244: `Dispatcher.candidates` is maintained across passes (CandidateIndex):
 * only Assignments touched by a changed row are evaluated again. The pre-C-244
 * algorithm is kept below verbatim as the reference; one long-lived dispatcher
 * over random world changes must produce the same candidates in the same order
 * as a from-scratch run of the reference after every round.
 */
import {
  type Actor,
  type Assignment,
  assign,
  type CommandState,
  type compareDispatchOrder,
  decisionFollowupBlocked,
  dispatchRunKind,
  dispatchTier,
  hasRunTarget,
  type Notification,
  type ProjectId,
  postComment,
  queuedRun,
  queueRun,
  runById,
  unreadableCommentTrigger,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { type Store, unfinishedBellAttempts } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { standingResolver } from "./assembly.js";
import type { CandidateIndex } from "./candidate-index.js";
import { Dispatcher } from "./dispatch.js";
import { notificationOwner, type StandingResolver } from "./dispatch-inbox.js";

interface Candidate {
  readonly project: ProjectId;
  readonly notes: readonly Notification[];
  readonly assignment: Assignment;
  readonly order: Parameters<typeof compareDispatchOrder>[0];
}

/** Pre-C-244 `Dispatcher.candidates`, verbatim apart from `this`. */
function referenceCandidates(
  store: Store,
  project: ProjectId,
  standing: StandingResolver | undefined,
): Candidate[] {
  const owner = (n: Notification, state: CommandState) =>
    notificationOwner(n, state, standing);
  const queued = (state: CommandState, a: Assignment) =>
    state.runs.find((r) => r.assignment_id === a.id && r.status === "queued");
  const claimed = new Set(
    unfinishedBellAttempts(store.database, project).flatMap(
      (a) => a.notification_ids,
    ),
  );
  const state = store.uow.read((tx) => loadCommandState(tx, project)),
    groups = new Map<string, Notification[]>();
  for (const n of store.listNotifications({
    project_id: project,
    status: "pending",
  })) {
    if (claimed.has(n.id)) continue;
    const o = owner(n, state);
    if (!o || decisionFollowupBlocked(state, n.event_id, o)) continue;
    const key = `${o}/${n.card_id ?? ""}/${n.attempts ? n.run_id : ""}`;
    groups.set(key, [...(groups.get(key) ?? []), n]);
  }
  const candidates: Candidate[] = [];
  const add = (assignment: Assignment, notes: Notification[]) => {
    if (!hasRunTarget(assignment, state)) return;
    const q = queued(state, assignment);
    if (q && unreadableCommentTrigger(state, q)) return;
    const cause = notes.find((n) => !n.run_id) ?? notes[0];
    const trigger = q?.trigger_event_id ?? cause?.event_id;
    const event = state.events.find((e) => e.id === trigger);
    if (!event) return;
    candidates.push({
      project,
      notes,
      assignment,
      order: {
        ...dispatchTier(
          state,
          assignment,
          q,
          event,
          q?.kind ??
            dispatchRunKind(event, assignment, cause?.kind === "review"),
        ),
        priority:
          state.cards.find(
            (c) =>
              c.id ===
              state.work_items.find((w) => w.id === assignment.work_item_id)
                ?.card_id,
          )?.priority ?? 0,
        project_id: project,
        assignment_id: assignment.id,
        created_at: event.created_at,
        trigger_event_id: event.id,
      },
    });
  };
  for (const notes of groups.values()) {
    notes.sort((a, b) => {
      const left = state.events.find((e) => e.id === a.event_id);
      const right = state.events.find((e) => e.id === b.event_id);
      return (
        (left?.created_at ?? a.created_at).localeCompare(
          right?.created_at ?? b.created_at,
        ) || a.event_id.localeCompare(b.event_id)
      );
    });
    const first = notes[0];
    const assignment =
      first && state.assignments.find((a) => a.id === owner(first, state));
    if (assignment) add(assignment, notes);
  }
  for (const assignment of state.assignments)
    if (
      (queued(state, assignment)?.queue_reason !== undefined ||
        queued(state, assignment)?.dispatch_target_wait !== undefined) &&
      !candidates.some((c) => c.assignment.id === assignment.id)
    )
      add(assignment, []);
  return candidates;
}

const view = (candidates: readonly Candidate[]) =>
  candidates.map((c) => ({
    assignment: c.assignment.id,
    notes: c.notes.map((n) => n.id),
    order: c.order,
  }));

function rng(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

let f: ReturnType<typeof dispatchFixture>;
beforeEach(() => {
  f = dispatchFixture();
});
afterEach(() => f.close());

const indexOf = (d: Dispatcher) =>
  (d as unknown as { candidateIndex: CandidateIndex }).candidateIndex;

/** A resolved decision raised by `assignment`, with its `decision_resolved` event. */
function resolveDecision(card: string, assignment: string): string {
  const human: Actor = { kind: "human", project_id: f.project };
  const id = `Q-${card}-${f.state().events.length}`;
  return f.apply((s, _a, p) => {
    const event = {
      id: p.ids.nextEventId(),
      card_id: card,
      seq: p.ids.nextEventSequence(s.project_id, card as never),
      type: "decision_resolved",
      actor: human,
      payload: { decision_id: id },
      created_at: p.clock.now(),
    };
    return {
      ok: true as const,
      value: {
        data: event.id,
        changes: [
          {
            collection: "decisions",
            entity: {
              id,
              key: id,
              kind: "choose",
              card_id: card,
              raised_by: `assignment:${assignment}`,
              question: "q",
              context: "c",
              options: [{ key: "go", description: "go", impact: "i" }],
              recommended: "go",
              affected_cards: [],
              affected_work_items: [],
              blocking: false,
              decider: "human",
              doc_refs: [],
              status: "resolved",
              resolution: {
                option: "go",
                rationale: "r",
                resolved_by: "human",
                via: "needs_you",
                raw_quote: "go",
                via_chain: [],
                at: p.clock.now(),
              },
            },
          },
        ],
        events: [event],
        timeline: [],
        token_requests: [],
      },
    } as never;
  }) as string;
}

test("C-244: candidates match the pre-C-244 algorithm over random inboxes", () => {
  const work = Array.from({ length: 6 }, () => f.create());
  // A busy PM Ops and an idle PM Office; legacy rows resolve through tokens.
  const standing = (["ops", "office", undefined] as const).map((mode, i) => {
    const owner = work[i]?.assignment;
    if (owner?.scope !== "work_item") throw new Error("missing assignment");
    const { work_item_id: _w, ...base } = owner;
    const pm: Assignment = {
      ...base,
      id: `A-9${i}` as Assignment["id"],
      scope: "standing",
      role_id: "pm",
      ...(mode ? { standing_mode: mode } : {}),
    };
    f.store.uow.run((tx) => tx.assignments.put(f.project, pm));
    return pm;
  });
  f.store.issueToken({
    project_id: f.project,
    assignment_id: standing[2]?.id as never,
    role: { role_version: 1, allowed_tools: ["get_updates"] },
  });
  f.session(standing[0] as Assignment, false);
  const real = standingResolver(f.store);
  const resolve = vi.fn<StandingResolver>((p, kind, s) => real(p, kind, s));
  const dispatcher = new Dispatcher({
    store: f.store,
    runtime: {} as never,
    clock: f.clock,
    standing: resolve,
    snapshot: async () => ({ model: "m", agent_cli_version: "v" }),
    startRun: async () => {},
  });
  const candidatesOf = () =>
    (
      dispatcher as unknown as { candidates(p: ProjectId): Candidate[] }
    ).candidates(f.project);
  const pick = rng(244);
  const events: string[] = [];
  const modes = new Set<string>();
  // Reviewers on the verification item: candidates only with a live target.
  for (const w of work.slice(0, 3)) {
    const verify = f
      .state()
      .work_items.find((x) => x.card_id === w.card.id && x.kind === "verify");
    if (verify)
      f.apply((s, a, p) =>
        assign(s, a, { work_item_id: verify.id, role_id: "reviewer" }, p),
      );
  }
  const reviewers = f
    .state()
    .assignments.filter((a) => a.role_id === "reviewer")
    .map((a) => a.id);
  expect(reviewers.length).toBe(3);
  let compared = 0;
  let reviewed = 0;
  for (let round = 0; round < 40; round++) {
    // Random world changes: comments (events), releases, queued Runs.
    for (let i = pick(4); i > 0; i--) {
      const w = work[pick(work.length)];
      if (!w) continue;
      f.advance(1 + pick(3) * 1000);
      f.apply((s, a, p) =>
        postComment(s, a, { card_id: w.card.id, body: `r${round}` }, p),
      );
      const latest = f.state().events.at(-1);
      if (latest) events.push(latest.id);
    }
    const state = f.state();
    if (pick(6) === 0) {
      const a = state.assignments.find(
        (x) => x.id === work[pick(work.length)]?.assignment.id,
      );
      if (a)
        f.store.uow.run((tx) =>
          tx.assignments.put(f.project, { ...a, status: "released" }),
        );
    }
    if (pick(3) === 0) {
      const a = work[pick(work.length)]?.assignment;
      const live = a && f.state().assignments.find((x) => x.id === a.id);
      if (live?.status === "active" && !queuedRun(f.state().runs, live.id)) {
        const run = f.apply((s, actor, p) =>
          queueRun(
            s,
            actor,
            {
              assignment_id: live.id,
              model: "m",
              agent_cli_version: "v",
              ...(events.length
                ? { trigger_event_id: events[pick(events.length)] as never }
                : {}),
            },
            p,
          ),
        );
        if (pick(2))
          f.store.uow.run((tx) =>
            tx.runs.put(f.project, {
              ...run,
              queue_reason: "concurrency_limit",
            }),
          );
      }
    }
    // Card priorities, work item states (decision-blocked results), live and
    // superseded deliveries (verification targets) and resolved decisions.
    if (pick(4) === 0) {
      const card = f
        .state()
        .cards.find((c) => c.id === work[pick(work.length)]?.card.id);
      if (card)
        f.store.uow.run((tx) =>
          tx.cards.put(f.project, { ...card, priority: pick(5) }),
        );
    }
    if (pick(4) === 0) {
      const item = f
        .state()
        .work_items.find((w) => w.id === work[pick(work.length)]?.item.id);
      if (item)
        f.store.uow.run((tx) =>
          tx.work_items.put(f.project, {
            ...item,
            status: item.status === "blocked" ? "in_progress" : "blocked",
          }),
        );
    }
    if (pick(3) === 0) {
      const w = work[pick(work.length)];
      const id = `D-${w?.item.id}`;
      const live = f.state().deliveries.find((d) => d.id === id);
      const runId = f.state().runs[0]?.id ?? "R-1";
      if (w)
        f.store.uow.run((tx) =>
          tx.deliveries.put(f.project, {
            id,
            work_item_id: w.item.id,
            run_id: runId,
            kind: "code",
            summary: "fixture",
            subject: { kind: "git_head", value: "abc" },
            evidence: [],
            attachments: [],
            known_gaps: [],
            requested_verifiers: [],
            status: live?.status === "submitted" ? "superseded" : "submitted",
            created_at: f.clock.now(),
          } as never),
        );
    }
    if (pick(3) === 0) {
      const w = work[pick(work.length)];
      if (w) events.push(resolveDecision(w.card.id, w.assignment.id));
    }
    // Some pending notifications are acknowledged; claims come and go.
    for (const n of f.store.listNotifications({
      project_id: f.project,
      status: "pending",
    }))
      if (pick(12) === 0)
        f.store.uow.run(() =>
          f.store.database
            .prepare(
              "UPDATE notifications SET status = 'acked', doc = json_set(doc, '$.status', 'acked') WHERE project_id = ? AND id = ?",
            )
            .run(f.project, n.id),
        );
    // Capacity waits come and go on queued Runs.
    for (const r of f.state().runs)
      if (r.status === "queued" && pick(2)) {
        const { queue_reason: _q, ...rest } = r;
        f.store.uow.run((tx) =>
          tx.runs.put(
            f.project,
            pick(2) ? { ...rest, queue_reason: "concurrency_limit" } : rest,
          ),
        );
      }
    // Random notifications: own Assignments, standing kinds and needs-you.
    for (let i = 1 + pick(8); i > 0; i--) {
      const kind = pick(5);
      const target = work[pick(work.length)];
      // Events are foreign keys; a missing trigger is covered by Run triggers.
      const eventId = events[pick(events.length)];
      if (!eventId) continue;
      const runs = f.state().runs;
      f.store.recordNotification({
        project_id: f.project,
        event_id: eventId as never,
        seq: 1 + pick(50),
        kind: "comment",
        ...(pick(4) ? { card_id: target?.card.id } : {}),
        recipient:
          kind === 0
            ? { kind: "pm_ops" }
            : kind === 1
              ? { kind: "pm_office" }
              : kind === 2
                ? { kind: "needs_you" }
                : {
                    kind: "assignment",
                    assignment_id: (pick(3) === 0
                      ? reviewers[pick(reviewers.length)]
                      : (target?.assignment.id ?? "A-1")) as never,
                  },
      });
      // Some notifications already carry a Run (retries group by Run).
      if (pick(4) === 0 && runs.length) {
        const note = f.store
          .listNotifications({ project_id: f.project })
          .at(-1) as Notification;
        f.store.uow.run(() =>
          f.store.database
            .prepare(
              "UPDATE notifications SET doc = json_set(doc, '$.run_id', ?, '$.attempts', ?) WHERE project_id = ? AND id = ?",
            )
            .run(
              runs[pick(runs.length)]?.id ?? "R-1",
              pick(3),
              f.project,
              note.id,
            ),
        );
      }
    }
    resolve.mockClear();
    const actual = view(candidatesOf());
    modes.add(indexOf(dispatcher).lastStats?.mode ?? "none");
    // One standing resolution per kind per pass, however many rows need it.
    expect(resolve.mock.calls.length).toBeLessThanOrEqual(2);
    const expected = view(referenceCandidates(f.store, f.project, real));
    expect(actual, `round ${round}`).toEqual(expected);
    compared += expected.length;
    reviewed += expected.filter((c) =>
      reviewers.includes(c.assignment as never),
    ).length;
  }
  expect(compared).toBeGreaterThan(40);
  expect(reviewed).toBeGreaterThan(0);
  // After the first pass the index is maintained, not rebuilt.
  expect(modes).toContain("incremental");
});

test("C-244: an unchanged pass reads nothing; a change re-evaluates only its Assignment", () => {
  const [a, b, c] = [f.create(), f.create(), f.create()];
  const comment = (card: string) =>
    f.apply((s, actor, p) =>
      postComment(s, actor, { card_id: card, body: "x" }, p),
    );
  for (const w of [a, b, c]) {
    if (!w) throw new Error("fixture");
    const event = comment(w.card.id);
    f.store.recordNotification({
      project_id: f.project,
      event_id:
        (event as { event_id?: string }).event_id ??
        (f.state().events.at(-1)?.id as never),
      seq: 1,
      kind: "comment",
      card_id: w.card.id,
      recipient: { kind: "assignment", assignment_id: w.assignment.id },
    } as never);
  }
  const dispatcher = new Dispatcher({
    store: f.store,
    runtime: {} as never,
    clock: f.clock,
    snapshot: async () => ({ model: "m", agent_cli_version: "v" }),
    startRun: async () => {},
  });
  const internal = dispatcher as unknown as {
    candidates(p: ProjectId): Candidate[];
    loadState: (...args: unknown[]) => CommandState;
  };
  let loads = 0;
  internal.loadState = (tx, project) => {
    loads++;
    return loadCommandState(tx as never, project as never);
  };
  const reads = vi.spyOn(f.store, "listNotifications");
  const pass = () => {
    loads = 0;
    reads.mockClear();
    const candidates = view(internal.candidates(f.project));
    expect(candidates).toEqual(
      view(referenceCandidates(f.store, f.project, undefined)),
    );
    reads.mockClear();
    return { candidates, stats: indexOf(dispatcher).lastStats };
  };
  const first = pass();
  expect(first.stats?.mode).toBe("reset");
  expect(first.candidates.map((x) => x.assignment).sort()).toEqual(
    [a, b, c].map((w) => w?.assignment.id).sort(),
  );
  // Nothing changed: the same list, without loading the state or the inbox.
  loads = 0;
  reads.mockClear();
  const again = view(internal.candidates(f.project));
  expect(again).toEqual(first.candidates);
  expect(loads).toBe(0);
  expect(reads).not.toHaveBeenCalled();
  expect(indexOf(dispatcher).lastStats).toEqual({
    mode: "reused",
    dirty: 0,
    evaluated: 0,
  });
  // A queued Run of `b` dirties `b` only; its candidate follows the Run.
  if (!b) throw new Error("fixture");
  f.apply((s, actor, p) =>
    queueRun(
      s,
      actor,
      { assignment_id: b.assignment.id, model: "m", agent_cli_version: "v" },
      p,
    ),
  );
  const queued = pass();
  expect(queued.stats).toMatchObject({
    mode: "incremental",
    dirty: 1,
    evaluated: 1,
  });
  // A card priority change dirties the Assignments on that card only.
  if (!c) throw new Error("fixture");
  const card = f.state().cards.find((x) => x.id === c.card.id);
  f.store.uow.run((tx) =>
    tx.cards.put(f.project, { ...(card as never), priority: 3 }),
  );
  const prioritized = pass();
  expect(prioritized.stats).toMatchObject({ dirty: 1, evaluated: 1 });
  expect(
    prioritized.candidates.find((x) => x.assignment === c.assignment.id)?.order
      .priority,
  ).toBe(3);
  // An appended event alone re-evaluates nothing, but is not a reuse.
  comment(c.card.id);
  expect(pass().stats).toMatchObject({ mode: "incremental", evaluated: 0 });
  // Releasing `a` and acknowledging its bell drops it; nobody else is evaluated.
  if (!a) throw new Error("fixture");
  const note = f.store
    .listNotifications({ project_id: f.project, status: "pending" })
    .find(
      (n) =>
        n.recipient.kind === "assignment" &&
        n.recipient.assignment_id === a.assignment.id,
    );
  f.store.uow.run(() =>
    f.store.database
      .prepare(
        "UPDATE notifications SET status = 'acked', doc = json_set(doc, '$.status', 'acked') WHERE project_id = ? AND id = ?",
      )
      .run(f.project, note?.id ?? ""),
  );
  const acked = pass();
  expect(acked.candidates.map((x) => x.assignment)).not.toContain(
    a.assignment.id,
  );
  expect(acked.stats).toMatchObject({ evaluated: 0 });
  // A new dispatcher (restart) rebuilds once from the full state.
  const restarted = new Dispatcher({
    store: f.store,
    runtime: {} as never,
    clock: f.clock,
    snapshot: async () => ({ model: "m", agent_cli_version: "v" }),
    startRun: async () => {},
  }) as unknown as { candidates(p: ProjectId): Candidate[] };
  expect(view(restarted.candidates(f.project))).toEqual(acked.candidates);
});

test("C-244: keyed Run lookups match the linear scans and follow new snapshots", () => {
  const w = f.create();
  f.session(w.assignment);
  const before = f.state().runs;
  const run = f.apply((s, a, p) =>
    queueRun(
      s,
      a,
      { assignment_id: w.assignment.id, model: "m", agent_cli_version: "v" },
      p,
    ),
  );
  const after = f.state().runs;
  expect(after).not.toBe(before);
  expect(queuedRun(before, w.assignment.id)).toBeUndefined();
  expect(queuedRun(after, w.assignment.id)?.id).toBe(run.id);
  for (const runs of [before, after])
    for (const r of [...runs, { id: "R-404" }]) {
      expect(runById(runs, r.id)).toBe(runs.find((x) => x.id === r.id));
      expect(queuedRun(runs, w.assignment.id)).toBe(
        runs.find(
          (x) => x.assignment_id === w.assignment.id && x.status === "queued",
        ),
      );
    }
  expect(runById(after, undefined)).toBeUndefined();
});

test("C-370 candidate ranks and start fences refresh when another card changes or clears the last edge", () => {
  const a = f.create(),
    b = f.create();
  for (const w of [a, b]) {
    f.apply((s, actor, p) =>
      postComment(s, actor, { card_id: w.card.id, body: "Start" }, p),
    );
    const event = f.state().events.at(-1);
    if (!event) throw new Error("Missing event");
    f.store.recordNotification({
      project_id: f.project,
      event_id: event.id,
      seq: event.seq,
      kind: "comment",
      card_id: w.card.id,
      recipient: { kind: "assignment", assignment_id: w.assignment.id },
    });
  }
  const dispatcher = new Dispatcher({
    store: f.store,
    runtime: {} as never,
    clock: f.clock,
    snapshot: async () => ({ model: "m", agent_cli_version: "v" }),
    startRun: async () => {},
  });
  const candidates = () =>
    (
      dispatcher as unknown as { candidates(p: ProjectId): Candidate[] }
    ).candidates(f.project);
  expect(candidates()).toHaveLength(2);
  f.store.uow.run((tx) =>
    tx.cards.put(f.project, { ...b.card, depends_on_cards: [a.card.id] }),
  );
  const dependent = candidates();
  expect(dependent.map((c) => c.assignment.id)).toEqual([a.assignment.id]);
  expect(dependent[0]?.order.critical_path_length).toBe(2);
  f.store.uow.run((tx) =>
    tx.cards.put(f.project, { ...b.card, depends_on_cards: [] }),
  );
  const cleared = candidates();
  expect(cleared).toHaveLength(2);
  expect(cleared.every((c) => c.order.critical_path_length === undefined)).toBe(
    true,
  );
});
