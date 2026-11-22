import { expect, test } from "vitest";
import type { CardDetail, CardPage } from "../../../web/src/api.js";
import { m5Cross, TEST_PASSWORD } from "../../test-support/m5-cross.js";

test("cleared deadlines are absent from refreshed board and detail reads", async () => {
  const { updateCard } = await import("@cardigan/domain");
  const f = await m5Cross();
  try {
    await f.password(TEST_PASSWORD);
    await f.login();
    const card_id = f.card.id;
    const write = (deadline: string | null) =>
      f.command((s, a, p) => updateCard(s, a, { card_id, deadline }, p));
    const detail = async () =>
      ((await f.call(f.projectPath(`/cards/${card_id}`))).json as CardDetail)
        .card;
    const board = async () =>
      (
        (await f.call(f.projectPath("/cards?mode=board&view=summary")))
          .json as CardPage
      ).cards.find((c) => c.id === card_id);
    write("2026-11-28");
    expect(await detail()).toHaveProperty("deadline", "2026-11-28");
    expect(await board()).toBeDefined();
    write(null);
    expect(await detail()).not.toHaveProperty("deadline");
    const refreshed = await board();
    expect(refreshed).toBeDefined();
    expect(refreshed).not.toHaveProperty("deadline");
  } finally {
    await f.close();
  }
}, 30_000);

test("U3 detail binds authors and reviews to their own events and reports the last card update", async () => {
  const f = await m5Cross();
  try {
    await f.password(TEST_PASSWORD);
    await f.login();
    const read = async () =>
      (await f.call(f.projectPath(`/cards/${f.card.id}`))).json as CardDetail;
    const delivery = await f.deliver(
      f.primary,
      await f.change(f.primary.owner, "criteria.txt", "v1"),
    );
    await f.review(f.primary.verifier, delivery);
    const after = await read();
    const review = f.state().reviews.find((r) => r.delivery_id === delivery.id);
    if (!review) throw new Error("Expected a submitted review");
    expect(after.timeline.find((e) => e.review_id === review.id)).toMatchObject(
      {
        type: "review",
        event_type: "review_submitted",
        author_role: "reviewer",
        delivery_id: delivery.id,
      },
    );
    expect(after.updated_at).toBe(
      f
        .state()
        .events.filter((e) => e.card_id === f.card.id)
        .map((e) => e.created_at)
        .sort()
        .at(-1),
    );
    await f.deliver(
      f.primary,
      await f.change(f.primary.owner, "criteria.txt", "v2"),
    );
    // An old row keeps its own review ID; it must never show a newer version's verdict.
    expect(
      (await read()).timeline.find((e) => e.review_id === review.id)
        ?.delivery_id,
    ).toBe(delivery.id);
  } finally {
    await f.close();
  }
}, 30_000);

test("U3 detail identifies PM and decision event choices without advancing Agent cursors", async () => {
  const f = await m5Cross();
  try {
    await f.password(TEST_PASSWORD);
    await f.login();
    const delivery = await f.deliver(
      f.primary,
      await f.change(f.primary.owner, "complete.txt", "ready"),
    );
    await f.review(f.primary.verifier, delivery);
    const completion = await f.complete(delivery);
    const decision = f
      .state()
      .decisions.find((d) => d.trigger === "merge_confirmation");
    if (!decision) throw new Error("Expected merge confirmation");
    const resolved = await f.call(
      f.projectPath(`/decisions/${encodeURIComponent(decision.id)}/resolve`),
      {
        method: "POST",
        body: { option: "merge", raw_quote: "确认合并此版本" },
      },
    );
    expect(resolved.status).toBe(200);
    const before = f.state().cursors;
    const response = await f.call(f.projectPath(`/cards/${f.card.id}`));
    expect(response.status).toBe(200);
    const detail = response.json as CardDetail;
    expect(
      detail.timeline.find(
        (e) => e.type === "review" && e.delivery_id === completion.id,
      ),
    ).toMatchObject({
      author_role: "pm",
      event_type: "review_submitted",
      review_id: expect.any(String),
    });
    expect(
      detail.timeline.find(
        (e) => e.type === "decision_resolved" && e.decision_id === decision.id,
      ),
    ).toMatchObject({ decision_option: "merge", body: "确认合并此版本" });
    expect(f.state().cursors).toEqual(before);
  } finally {
    await f.close();
  }
}, 30_000);

test("U3 recent windows load older records and resolve an anchor beyond the former 200-entry limit", async () => {
  const { postComment } = await import("@cardigan/domain");
  const f = await m5Cross();
  try {
    await f.password(TEST_PASSWORD);
    await f.login();
    const first = f.command((s, a, p) =>
      postComment(
        s,
        a,
        { card_id: f.card.id, body: "Oldest linked comment" },
        p,
      ),
    );
    for (let n = 0; n < 205; n++)
      f.command((s, a, p) =>
        postComment(s, a, { card_id: f.card.id, body: `Comment ${n}` }, p),
      );
    const read = async (query: string) =>
      (await f.call(f.projectPath(`/cards/${f.card.id}?${query}`)))
        .json as CardDetail;
    const before = f.state().cursors;
    expect((await read("limit=20")).timeline).toHaveLength(20);
    expect((await read("limit=40")).timeline).toHaveLength(40);
    const anchored = await read(
      `limit=20&at=${encodeURIComponent(`entry-${first.id}`)}`,
    );
    expect(anchored.timeline.length).toBeLessThanOrEqual(20);
    expect(anchored.timeline[0]?.id).toBe(first.id);
    expect((await read("limit=20&at=entry-C-999%231")).timeline).toHaveLength(
      20,
    );
    expect(f.state().cursors).toEqual(before);
  } finally {
    await f.close();
  }
}, 30_000);
