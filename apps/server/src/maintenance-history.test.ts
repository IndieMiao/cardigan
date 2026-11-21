import type { Decision } from "@cardigan/domain";
import { expect, test } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { MergeShadowObserver } from "./merge-shadow.js";
import { escalatePmMergeStalls } from "./pm-merge-stall-attention.js";
import { escalateReviewLimitWaits } from "./review-limit-attention.js";

const candidates = 128;
const kinds = {
  review: "review_limit_not_resumed",
  stall: "pm_merge_confirmation_stalled",
  shadow: "system_merge_shadow_recorded",
} as const;

test.each(["review", "stall", "shadow"] as const)(
  "C-553: %s cold and replay maintenance ticks on 150k events",
  async (kind) => {
    const f = dispatchFixture();
    try {
      const { store, project, clock } = f;
      const base = f.create();
      const verifier = f.state().work_items.find((w) => w.kind === "verify");
      if (!verifier) throw new Error("Missing fixture verifier");
      store.uow.run((tx) => {
        // Put the large unrelated history first in the project's event collection.
        store.database
          .prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<150000)
      INSERT INTO events(project_id,id,card_id,stream,seq,type,doc)
      SELECT ?, 'history-'||i, NULL,'',1000+i,'tick', json_object('id','history-'||i,'seq',1000+i,'type','tick','payload',json('{}'),'actor',json_object('kind','system','project_id',?),'created_at',?) FROM n`)
          .run(project, project, clock.now());
        tx.project_preferences.put(project, {
          id: project,
          auto_merge_after_minutes: null,
          system_merge_shadow: true,
        });
        for (let i = 0; i < candidates; i++) {
          const card = tx.ids.next(project, "card"),
            work = tx.ids.next(project, "work_item"),
            decision = tx.ids.next(project, "decision");
          tx.cards.put(project, {
            ...base.card,
            id: card,
            flow_version: 1,
            status: kind === "review" ? "in_progress" : "awaiting_merge",
          });
          const common = {
            id: decision,
            key: decision,
            card_id: card,
            question: "Fixture",
            context: "",
            options: [],
            recommended: "",
            raised_by: "system",
            decider: "role:pm",
            blocking: true,
            affected_cards: [card],
            affected_work_items: [work],
            doc_refs: [],
          } as const;
          let q: Decision;
          if (kind === "review") {
            tx.work_items.put(project, {
              ...verifier,
              id: work,
              card_id: card,
              status: "waiting_decision",
            });
            q = {
              ...common,
              kind: "choose",
              trigger: "review_limit",
              status: "resolved",
              resolution: {
                option: "raise_limit",
                rationale: "Fixture",
                resolved_by: "human",
                via: "needs_you",
                via_chain: ["human"],
                at: clock.now(),
              },
            };
          } else {
            const completion = tx.ids.next(project, "delivery");
            tx.work_items.put(project, {
              ...base.item,
              id: work,
              card_id: card,
              status: "accepted",
            });
            tx.deliveries.put(project, {
              id: completion,
              work_item_id: work,
              run_id: tx.ids.next(project, "run"),
              kind: "card_completion",
              status: "accepted",
              summary: "Fixture",
              subject: { kind: "git_head", value: "a".repeat(40) },
              attachments: [],
              evidence: [],
              known_gaps: [],
              requested_verifiers: [],
            });
            tx.events.append(project, {
              id: tx.ids.nextEventId(),
              seq: tx.ids.nextEventSequence(project, card),
              card_id: card,
              actor: { kind: "system", project_id: project },
              type: "merge_check_finished",
              payload: { completion_id: completion, status: "passed" },
              created_at: clock.now(),
            });
            // The first observation also includes already-closed decisions without an audit.
            q = {
              ...common,
              kind: "approve",
              trigger: "merge_confirmation",
              target: { delivery_id: completion },
              status: kind === "shadow" && i % 2 === 0 ? "resolved" : "open",
            };
          }
          tx.decisions.put(project, q);
        }
      });
      f.advance(2 * 3600_000);
      for (const cold of [true, false]) {
        const locks: number[] = [];
        let compute = 0;
        store.observe({
          transaction(kind, ms) {
            if (kind === "run") locks.push(ms);
            else compute += ms;
          },
        });
        const start = performance.now();
        if (kind === "review")
          escalateReviewLimitWaits(store, project, clock.now());
        else if (kind === "stall")
          escalatePmMergeStalls(store, project, clock.now());
        else
          await new MergeShadowObserver(store, undefined, clock).tick(project);
        const tick = performance.now() - start,
          lock = Math.max(0, ...locks);
        store.observe(undefined);
        expect(
          store.database
            .prepare("SELECT COUNT(*) AS n FROM events WHERE type=?")
            .get(kinds[kind])?.n,
        ).toBe(candidates);
        console.info(
          `${kind} ${cold ? "cold" : "replay"}: compute ${compute.toFixed(1)}, tick ${tick.toFixed(1)}, max write ${lock.toFixed(1)} ms`,
        );
        expect(locks.length > 0).toBe(cold);
        expect(compute).toBeLessThan(cold ? 2000 : 500);
        expect(tick).toBeLessThan(cold ? 2500 : 600);
        expect(lock).toBeLessThan(75);
      }
    } finally {
      f.close();
    }
  },
  20000,
);
