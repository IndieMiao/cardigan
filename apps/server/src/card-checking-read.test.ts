import { createCard, type WorkItem } from "@cardigan/domain";
import { expect, test } from "vitest";
import { m3Fixture } from "../test-support/m3-acceptance.js";
import { readCardsPage } from "./web/cards-page.js";
import { readPagedCard } from "./web/timeline-state.js";

// C-567 review: a wait for another card's precheck resolves through the real
// board and detail reads, even when that card is not on the requested page.
test("board and detail mark a wait for an off-page card's precheck", () => {
  const f = m3Fixture();
  try {
    const other = f.apply((s, a, p) =>
      createCard(
        s,
        a,
        {
          title: "Other",
          goal: "Other",
          source: { kind: "quote", text: "Other" },
          template: "general",
        },
        p,
      ),
    ).data;
    const precheck = (status: "running" | "failed") =>
      f.store.uow.run((tx) =>
        tx.events.append(f.id, {
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(f.id, other.id),
          card_id: other.id,
          type: status === "running" ? "precheck_started" : "precheck_finished",
          actor: { kind: "system", project_id: f.id },
          created_at: f.clock.now(),
          payload: {
            attempt_id: "attempt-other",
            assignment_id: f.coder.id,
            work_item_id: f.produce.id,
            card_id: other.id,
            head_sha: "a".repeat(40),
            branch: "feature",
            machine_id: "local",
            status,
          },
        }),
      );
    const block = (auto_resume_disabled?: boolean) =>
      f.store.uow.run((tx) => {
        const item = tx.work_items.get(f.id, f.produce.id) as WorkItem;
        tx.work_items.put(f.id, {
          ...item,
          status: "blocked",
          reported_blocker: {
            reason: "等预检",
            needs: "role",
            reported_by: `assignment:${f.coder.id}`,
            reported_at: f.clock.now(),
            resume_when: {
              kind: "precheck_finished",
              target_id: "attempt-other",
            },
            ...(auto_resume_disabled ? { auto_resume_disabled } : {}),
          },
        } as WorkItem);
      });
    const board = () =>
      readCardsPage(
        f.store,
        f.id,
        new URL(`http://fixture/cards?mode=board&limit=5&q=${f.card.id}`),
      ).cards.find((c) => c.id === f.card.id);
    const detail = () =>
      readPagedCard(
        f.store,
        f.id,
        f.card.id,
        new URL("http://fixture/card?limit=1"),
        {},
      )?.card;
    precheck("running");
    block();
    const marked = {
      precheck: {
        attempt_ids: ["attempt-other"],
        waiting_items: [f.produce.id],
        cards: [other.id],
      },
    };
    expect(board()?.checking).toStrictEqual(marked);
    expect(detail()?.checking).toStrictEqual(marked);
    expect(board()?.waiting_on).toContainEqual(
      expect.objectContaining({ kind: "blocked", ref: f.produce.id }),
    );
    // Handed to PM: the blocker stays red, nothing else marks this card.
    block(true);
    expect(board()?.checking).toBeUndefined();
    expect(detail()?.checking).toBeUndefined();
    // Settled: back to the ordinary blocker.
    block();
    precheck("failed");
    expect(board()?.checking).toBeUndefined();
    expect(detail()?.checking).toBeUndefined();
  } finally {
    f.close();
  }
});
