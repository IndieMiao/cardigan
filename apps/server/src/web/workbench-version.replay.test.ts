/**
 * C-634: synthetic measurement of the Workbench version endpoints. Skipped
 * unless CARDIGAN_WORKBENCH_REPLAY=1; it is a measurement harness, not a
 * regression gate. It seeds a project, then times the capacity revision an SSE
 * flush asks for and the needs-you version, both with no write in between and
 * with one MCP activity touch in between (the churn every tool call causes).
 *
 *   CARDIGAN_WORKBENCH_REPLAY=1 REPLAY_CARDS=200 pnpm --filter @cardigan/server \
 *     exec vitest run src/web/workbench-version.replay.test.ts --silent=false
 */
import { performance } from "node:perf_hooks";
import { type CardId, postComment } from "@cardigan/domain";
import { GithubDispatchJournal, readRunQueue } from "@cardigan/host";
import { expect, test } from "vitest";
import {
  acceptThroughMergeGate,
  m4Fixture,
  m4Scenario,
} from "../m4-fixtures.js";
import {
  ExecutionCapacityCache,
  executionCapacity,
  executionCapacityInputs,
  executionCapacityRevision,
} from "./execution-capacity.js";
import { NEEDS_PHASE_REFRESH_MS, readNeedsVersion } from "./needs-version.js";

const CARDS = Number(process.env.REPLAY_CARDS ?? 40);
const OPEN = Number(process.env.REPLAY_OPEN_CARDS ?? 20);
const COMMENTS = Number(process.env.REPLAY_COMMENTS ?? 10);
const ROUNDS = Number(process.env.REPLAY_ROUNDS ?? 20);
/** Bulk history appended after seeding: the production shape is history-heavy. */
const SYSTEM_EVENTS = Number(process.env.REPLAY_SYSTEM_EVENTS ?? 60_000);
const CARD_EVENTS = Number(process.env.REPLAY_CARD_EVENTS ?? 150);
/** Finished GitHub check dispatch phases per card, as every precheck leaves. */
const DISPATCH_EVENTS = Number(process.env.REPLAY_DISPATCH_EVENTS ?? 6);

test.skipIf(process.env.CARDIGAN_WORKBENCH_REPLAY !== "1")(
  "time Workbench version reads against production-shaped synthetic data",
  async () => {
    const f = m4Fixture();
    const seeded = performance.now();
    let last: ReturnType<typeof m4Scenario> | undefined;
    for (let i = 0; i < CARDS; i++) {
      const s = m4Scenario(f);
      last = s;
      if (i < OPEN)
        await acceptThroughMergeGate(f, s, i.toString(16).padStart(40, "a"));
      for (let c = 0; c < COMMENTS; c++)
        f.apply((st, a, p) =>
          postComment(st, a, { card_id: s.card.id, body: `c${c}` }, p),
        );
    }
    f.store.uow.run((tx) => {
      const append = (card: CardId | undefined, n: number) => {
        for (let i = 0; i < n; i++)
          tx.events.append(f.project_id, {
            id: tx.ids.nextEventId(),
            seq: tx.ids.nextEventSequence(f.project_id, card),
            ...(card ? { card_id: card } : {}),
            type: "comment_posted",
            actor: f.human,
            payload: {},
            created_at: f.clock.now(),
          });
      };
      append(undefined, SYSTEM_EVENTS);
      for (const card of tx.cards.list(f.project_id)) {
        append(card.id, CARD_EVENTS);
        for (let i = 0; i < DISPATCH_EVENTS; i++)
          tx.events.append(f.project_id, {
            id: tx.ids.nextEventId(),
            seq: tx.ids.nextEventSequence(f.project_id, card.id),
            card_id: card.id,
            type: "github_check_dispatch",
            actor: { kind: "system", project_id: f.project_id },
            payload: {
              project: f.project_id,
              card: card.id,
              attempt: `attempt-${i >> 1}`,
              key: "k".repeat(64),
              startedAt: f.clock.now(),
              phase: "dispatching",
              executor: "github-actions",
              candidate: {
                repo: "o/r",
                ref: `refs/heads/ci/${i}`,
                sha: "a".repeat(40),
              },
              externalRun: {
                provider: "github",
                run_id: i,
                run_attempt: 1,
                html_url: "https://example.invalid/run",
              },
              ...(i % 2 ? { finished: true } : {}),
            },
            created_at: f.clock.now(),
          });
      }
    });
    const st = f.state();
    const gate = {
      status: "enabled" as const,
      checks: [],
      env: {},
      totalTimeoutMs: 1000,
    };
    const mergeGate = { errors: [], forProject: () => gate };
    const now = f.clock.now();
    const capacity = () =>
      executionCapacityRevision(
        f.store,
        () => 4,
        mergeGate as never,
        undefined,
        undefined,
        undefined,
        f.project_id,
        now,
      );
    const cache = new ExecutionCapacityCache({
      now: () => now,
      inputs: (at) => executionCapacityInputs(f.store, at),
      build: (project, at) =>
        executionCapacity(
          f.store,
          () => 4,
          mergeGate as never,
          undefined,
          undefined,
          undefined,
          project,
          at,
        ),
    });
    const cached = () => cache.revision(f.project_id);
    // The pre-C-634 SSE reads: a history read per card stream.
    const perCardStreams = (since: number) =>
      f.store.uow.read((tx) =>
        [undefined, ...tx.cards.list(f.project_id).map((c) => c.id)].map(
          (card) => tx.events.listAfter(f.project_id, card, since).at(-1),
        ),
      );
    let clockAt = Date.parse(now);
    const needs = () =>
      readNeedsVersion(
        f.store,
        f.project_id,
        "ctx",
        now,
        undefined,
        () => null,
        () => undefined,
      );
    const touch = () =>
      f.store.touchAssignmentActivity(
        f.project_id,
        last?.coder.id as never,
        new Date().toISOString(),
      );
    const time = (read: () => unknown, write?: () => unknown) => {
      read();
      let total = 0;
      for (let i = 0; i < ROUNDS; i++) {
        write?.();
        const start = performance.now();
        read();
        total += performance.now() - start;
      }
      return Number((total / ROUNDS).toFixed(3));
    };
    const report = {
      shape: {
        seed_ms: Math.round(performance.now() - seeded),
        cards: st.cards.length,
        work_items: st.work_items.length,
        deliveries: st.deliveries.length,
        events: st.events.length,
      },
      ms_per_call: {
        sse_connect_before: time(() => perCardStreams(0)),
        sse_connect_after: time(() =>
          f.store.uow.read(() => f.store.latestEventSeqs(f.project_id)),
        ),
        sse_idle_flush_before: time(() => perCardStreams(1e9)),
        sse_idle_flush_after: time(() =>
          f.store.uow.read(() => f.store.eventStreamCounters(f.project_id)),
        ),
        capacity_inputs: time(() => executionCapacityInputs(f.store, now)),
        capacity_cached_unchanged: time(cached),
        capacity_cached_after_touch: time(cached, touch),
        sse_queue_revision: time(() =>
          JSON.stringify(
            readRunQueue(f.store).filter((r) => r.project_id === f.project_id),
          ),
        ),
        journal_clone_all: time(() =>
          f.store.uow.read((tx) =>
            new GithubDispatchJournal(f.store)
              .allAt(tx)
              .filter((intent) => !intent.finished),
          ),
        ),
        journal_executors: time(() =>
          f.store.uow.read((tx) =>
            new GithubDispatchJournal(f.store).unfinishedExecutorsAt(tx),
          ),
        ),
        capacity_unchanged: time(capacity),
        capacity_after_touch: time(capacity, touch),
        // Each call a refresh interval later: the pre-C-634 cost per call.
        needs_unchanged_recomputed: time(() => {
          clockAt += NEEDS_PHASE_REFRESH_MS;
          return readNeedsVersion(
            f.store,
            f.project_id,
            "ctx",
            new Date(clockAt).toISOString(),
            undefined,
            () => null,
            () => undefined,
          );
        }),
        needs_unchanged: time(needs),
        needs_after_touch: time(needs, touch),
      },
    };
    console.log(JSON.stringify(report));
    expect(report.shape.cards).toBe(CARDS);
    f.close();
  },
  600_000,
);
