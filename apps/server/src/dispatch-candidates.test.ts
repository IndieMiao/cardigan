/**
 * C-244: `Dispatcher.candidates` now resolves owners once, memoizes the
 * standing PM per pass, groups without copying and finds queued Runs by key.
 * The pre-C-244 algorithm is kept below verbatim as the reference; random
 * inboxes over one world must produce the same candidates in the same order.
 */
import {
  type Assignment,
  type CommandState,
  type compareDispatchOrder,
  decisionFollowupBlocked,
  hasRunTarget,
  type Notification,
  type ProjectId,
  postComment,
  queueRun,
  unreadableCommentTrigger,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { type Store, unfinishedBellAttempts } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { standingResolver } from "./assembly.js";
import { Dispatcher } from "./dispatch.js";
import { notificationOwner, type StandingResolver } from "./dispatch-inbox.js";
import { queuedRun, runById } from "./run-index.js";

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
  let compared = 0;
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
                    assignment_id: (target?.assignment.id ?? "A-1") as never,
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
    // One standing resolution per kind per pass, however many rows need it.
    expect(resolve.mock.calls.length).toBeLessThanOrEqual(2);
    const expected = view(referenceCandidates(f.store, f.project, real));
    expect(actual, `round ${round}`).toEqual(expected);
    compared += expected.length;
  }
  expect(compared).toBeGreaterThan(40);
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
