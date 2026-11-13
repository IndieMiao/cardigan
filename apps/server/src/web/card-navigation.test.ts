import { createCard, postComment, requestDecision } from "@cardigan/domain";
import { expect, test } from "vitest";
import type { CardDetail } from "../../../web/src/api.js";
import { m5Cross, TEST_PASSWORD } from "../../test-support/m5-cross.js";

test("U5b source cards and related titles resolve inside the project snapshot", async () => {
  const f = await m5Cross();
  try {
    await f.password(TEST_PASSWORD);
    await f.login();
    const decision = f.command((s, a, p) =>
      requestDecision(
        s,
        a,
        {
          card_id: f.card.id,
          category: "general",
          kind: "choose",
          question: "Follow up?",
          context: "Scope",
          options: [{ key: "yes", description: "Proceed", impact: "New card" }],
          recommended: "yes",
          affected_cards: [],
          affected_work_items: [],
          blocking: false,
          decider: "human",
        },
        p,
      ),
    );
    const card = f.command((s, a, p) =>
      createCard(
        s,
        a,
        {
          title: "Follow-up card",
          repo: f.card.repo,
          base_branch: f.card.base_branch,
          goal: "Build next",
          acceptance_criteria: ["Verified"],
          source: { kind: "decision", decision_id: decision.id },
          related_cards: [f.card.id],
        },
        p,
      ),
    );
    const detail = (await f.call(f.projectPath(`/cards/${card.id}`)))
      .json as CardDetail;
    expect(detail.relations.source_card).toEqual({
      id: f.card.id,
      title: f.card.title,
      decision_id: decision.id,
    });
    expect(detail.relations.cards).toContainEqual(
      expect.objectContaining({ id: f.card.id, title: f.card.title }),
    );
    const origin = (await f.call(f.projectPath(`/cards/${f.card.id}`)))
      .json as CardDetail;
    expect(origin.card.source).toEqual(f.card.source);
    expect(origin.relations.source_card).toBeNull();
  } finally {
    await f.close();
  }
}, 30_000);

test("U5b attachment times are upload facts and uploaders retain their role; reads never advance cursors", async () => {
  const f = await m5Cross();
  try {
    await f.password(TEST_PASSWORD);
    await f.login();
    const agentFile = await f.attachment("image/png", "fixture image bytes");
    const comment = await f.agentComment("Earlier than the human upload");
    f.advance(86400000);
    const uploaded = await f.call(
      f.projectPath(`/cards/${f.card.id}/attachments`),
      {
        method: "POST",
        body: {
          file: Buffer.from("human evidence").toString("base64"),
          mime: "text/plain",
          kind: "evidence",
          attach_to: { kind: "timeline_entry", id: comment.id },
        },
      },
    );
    expect(uploaded.status).toBe(200);
    const before = f.state();
    const detail = (await f.call(f.projectPath(`/cards/${f.card.id}`)))
      .json as CardDetail;
    for (const attachment of detail.attachments) {
      const event = before.events.find(
        (e) =>
          e.type === "attachment_uploaded" &&
          (e.payload as { attachment_id?: string }).attachment_id ===
            attachment.id,
      );
      expect(attachment.uploaded_at).toBe(event?.created_at);
      // U6b thumbnails bind to the upload event, not to the comment receiving the file.
      const upload = detail.timeline.find(
        (entry) => entry.event_seq === event?.seq,
      );
      expect(upload).toMatchObject({
        attachment_id: attachment.id,
        event_type: "attachment_uploaded",
        author: attachment.uploaded_by,
      });
      expect(
        detail.timeline.find((entry) => entry.id === comment.id)?.attachment_id,
      ).toBeUndefined();
    }
    expect(detail.attachments.find((a) => a.id === agentFile.id)).toMatchObject(
      {
        uploaded_by: `assignment:${f.primary.owner.id}`,
        uploader_role: "coder",
        inline: true,
      },
    );
    const human = detail.attachments.find((a) => a.uploaded_by === "human");
    expect(human).toMatchObject({
      uploader_role: null,
      inline: false,
      uploaded_at: new Date(f.now()).toISOString(),
    });
    expect(human?.uploaded_at).not.toBe(comment.created_at);
    expect(f.state().cursors).toEqual(before.cursors);
    expect(f.state().events).toEqual(before.events);
  } finally {
    await f.close();
  }
}, 30_000);

test("U5b latest conclusions use full history even when outside the loaded timeline window", async () => {
  const f = await m5Cross();
  try {
    await f.password(TEST_PASSWORD);
    await f.login();
    const delivery = await f.deliver(
      f.primary,
      await f.change(f.primary.owner, "navigation.txt", "ready"),
    );
    await f.review(f.primary.verifier, delivery);
    await f.complete(delivery);
    const decision = f
      .state()
      .decisions.find((d) => d.trigger === "merge_confirmation");
    if (!decision) throw new Error("Missing merge decision");
    expect(
      (
        await f.call(
          f.projectPath(
            `/decisions/${encodeURIComponent(decision.id)}/resolve`,
          ),
          { method: "POST", body: { option: "merge", raw_quote: "确认合并" } },
        )
      ).status,
    ).toBe(200);
    for (let i = 0; i < 25; i++)
      f.command((s, a, p) =>
        postComment(
          s,
          a,
          { card_id: f.card.id, body: `Later comment ${i}` },
          p,
        ),
      );
    const detail = (await f.call(f.projectPath(`/cards/${f.card.id}?limit=20`)))
      .json as CardDetail;
    expect(detail.timeline.every((e) => e.type === "comment")).toBe(true);
    expect(detail.recent_conclusions).toHaveLength(3);
    expect(detail.recent_conclusions?.map((e) => e.type)).toEqual([
      "decision_resolved",
      "review",
      "review",
    ]);
    expect(detail.recent_conclusions?.[0]).toMatchObject({
      decision_id: decision.id,
      decision_option: "merge",
      body: "确认合并",
    });
    const first = detail.recent_conclusions?.[0];
    const linked = (
      await f.call(
        f.projectPath(
          `/cards/${f.card.id}?limit=20&at=${encodeURIComponent(`entry-${first?.id}`)}`,
        ),
      )
    ).json as CardDetail;
    expect(linked.timeline.some((e) => e.id === first?.id)).toBe(true);
  } finally {
    await f.close();
  }
}, 30_000);
