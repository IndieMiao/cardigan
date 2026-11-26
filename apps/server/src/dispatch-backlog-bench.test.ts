import { writeFileSync } from "node:fs";
import { type CardId, createCard } from "@cardigan/domain";
import { recordNotification } from "@cardigan/store";
import { test } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { Dispatcher } from "./dispatch.js";
import {
  profileTick,
  setTickProfiler,
  TickProfiler,
  tickStoreObserver,
} from "./tick-profile.js";

/**
 * C-788: opt-in measurement of one dispatcher tick over an unread backlog
 * shaped like the 11-26 snapshot (an external Office, PM Office role rows and
 * owner notices nobody consumes in the loop). Not part of the normal suite:
 *
 *   BENCH=1 BENCH_CARDS=250 BENCH_OUT=/tmp/out.json \
 *     pnpm --filter @cardigan/server exec vitest run src/dispatch-backlog-bench.test.ts
 */
const CARDS = Number(process.env.BENCH_CARDS ?? 250);
const TICKS = 8;

test.runIf(process.env.BENCH === "1")(
  "bench: dispatcher tick with an unconsumed backlog",
  { timeout: 600_000 },
  async () => {
    const f = recoveryFixture();
    const legacy = f.pm();
    const office = f.store.uow.run((tx) => {
      const a = {
        ...legacy,
        id: tx.ids.next(f.project, "assignment"),
        standing_mode: "office" as const,
        external: true,
      };
      tx.assignments.put(f.project, a);
      return a;
    });
    const cards: CardId[] = [];
    for (let i = 0; i < CARDS; i++)
      cards.push(
        f.apply((s, a, p) =>
          createCard(
            s,
            a,
            {
              title: `Bench ${i}`,
              goal: "bench",
              acceptance_criteria: ["x"],
              repo: "fixture/repo",
              base_branch: "main",
              source: { kind: "quote", text: "bench" },
            },
            p,
          ),
        ).id,
      );
    f.skipEvents();
    // Per card: 3 rows for the external Office, 3 PM Office role rows, 2
    // owner notices (about the 11-26 mix of 729 / 809 / 613).
    const recipients = [
      ...Array(3).fill({ kind: "assignment", assignment_id: office.id }),
      ...Array(3).fill({ kind: "pm_office" }),
      ...Array(2).fill({ kind: "needs_you" }),
    ];
    f.store.uow.run((tx) => {
      for (const card of cards)
        for (const recipient of recipients) {
          const e = {
            type: "comment_posted",
            payload: { body: "bench" },
            id: tx.ids.nextEventId(),
            seq: tx.ids.nextEventSequence(f.project, card),
            card_id: card,
            created_at: f.clock.now(),
            actor: { kind: "system" as const, project_id: f.project },
          };
          tx.events.append(f.project, e);
          recordNotification(f.store.database, {
            project_id: f.project,
            event_id: e.id,
            card_id: card,
            seq: e.seq,
            at: e.created_at,
            kind: "comment",
            recipient,
          });
        }
    });
    f.skipEvents();
    // Overdue for the standing-inbox check, as in production.
    f.advance(11 * 60_000);
    const lines: Array<Record<string, unknown>> = [];
    const profiler = new TickProfiler({
      log: (l) => lines.push(l as Record<string, unknown>),
      reportIntervalMs: 0,
    });
    setTickProfiler(profiler);
    let count = { transactions: 0, writes: 0 };
    f.store.observe({
      ...tickStoreObserver,
      transaction: (kind, ms) => {
        count.transactions++;
        tickStoreObserver.transaction(kind, ms);
      },
      writeLock: (wait, hold) => {
        count.writes++;
        tickStoreObserver.writeLock(wait, hold);
      },
    });
    const d = new Dispatcher({
      ...f.options,
      roleUpgradePass: "beside",
      standing: (_p, kind) => (kind === "pm_office" ? office.id : undefined),
    });
    const ticks: unknown[] = [];
    try {
      for (let i = 0; i < TICKS; i++) {
        f.advance(1_000);
        count = { transactions: 0, writes: 0 };
        const started = performance.now();
        await profileTick("dispatch", () => d.tick());
        ticks.push({
          tick: i,
          ms: Math.round(performance.now() - started),
          ...count,
        });
        await d.roleUpgradesSettled();
      }
    } finally {
      setTickProfiler(undefined);
      await d.close();
    }
    const steady = lines
      .filter((l) => l.loop === "dispatch" && l.spans)
      .slice(-4)
      .map((l) => l.spans as Record<string, number>);
    const spans: Record<string, number> = {};
    for (const s of steady)
      for (const [k, v] of Object.entries(s))
        spans[k] = Math.round(((spans[k] ?? 0) + v / steady.length) * 10) / 10;
    const pending = f.store.listNotifications({
      project_id: f.project,
      status: "pending",
    });
    writeFileSync(
      process.env.BENCH_OUT ?? "/dev/stderr",
      `${JSON.stringify(
        {
          cards: CARDS,
          ticks,
          spans: Object.fromEntries(
            Object.entries(spans)
              .filter(([, v]) => v >= 0.5)
              .sort((a, b) => b[1] - a[1]),
          ),
          pending: pending.length,
          needs_you_pending: pending.filter(
            (n) => n.recipient.kind === "needs_you",
          ).length,
        },
        null,
        1,
      )}\n`,
    );
    f.close();
  },
);
