import { createCard } from "@cardigan/domain";
import { expect, test } from "vitest";
import type { CardDetail } from "../../../web/src/api.js";
import { m5Cross, TEST_PASSWORD } from "../../test-support/m5-cross.js";

test("C-615 other cards' attachments a body mentions resolve unless sensitive or cross-card reading is off", async () => {
  const f = await m5Cross();
  try {
    await f.password(TEST_PASSWORD);
    await f.login();
    const file = await f.attachment("application/pdf", "%PDF-1.4");
    const other = f.command((s, a, p) =>
      createCard(
        s,
        a,
        {
          title: "Reader card",
          repo: f.card.repo,
          base_branch: f.card.base_branch,
          goal: "Quote the review",
          acceptance_criteria: ["Linked"],
          source: { kind: "quote", text: "Read another card" },
        },
        p,
      ),
    );
    const posted = await f.call(f.projectPath(`/cards/${other.id}/comments`), {
      method: "POST",
      body: { body: `见 ${file.id} 和 attachment-999` },
    });
    expect(posted.status).toBe(200);
    const read = async () =>
      (await f.call(f.projectPath(`/cards/${other.id}`))).json as CardDetail;
    const detail = await read();
    expect(detail.referenced_attachments).toEqual([
      expect.objectContaining({
        id: file.id,
        card_id: f.card.id,
        mime: "application/pdf",
        download_path: `/api/projects/${encodeURIComponent(f.card.project_id)}/attachments/${file.id}`,
      }),
    ]);
    // The card's own list is unchanged: the other card's file is not attached here.
    expect(detail.attachments.map((a) => a.id)).not.toContain(file.id);
    // The owning card lists its own attachment, not as a cross-card reference.
    const own = (await f.call(f.projectPath(`/cards/${f.card.id}`)))
      .json as CardDetail;
    expect(own.referenced_attachments).toEqual([]);

    const sensitive = await f.call(
      f.projectPath(`/cards/${f.card.id}/sensitive`),
      { method: "POST", body: { sensitive: true } },
    );
    expect(sensitive.status).toBe(200);
    expect((await read()).referenced_attachments).toEqual([]);
    await f.call(f.projectPath(`/cards/${f.card.id}/sensitive`), {
      method: "POST",
      body: { sensitive: false },
    });
    expect((await read()).referenced_attachments).toHaveLength(1);

    f.store().uow.run((tx) =>
      tx.project_preferences.put(f.card.project_id, {
        id: f.card.project_id,
        auto_merge_after_minutes: null,
        cross_card_read: false,
      }),
    );
    expect((await read()).referenced_attachments).toEqual([]);
  } finally {
    await f.close();
  }
}, 30_000);

test("C-615 a comment's attachment-new-N reads as the uploaded number in the Workbench, get_card and get_updates", async () => {
  const f = await m5Cross();
  try {
    await f.password(TEST_PASSWORD);
    await f.login();
    const comment = await f.agentComment(
      "评审 attachment-new-1，日志 attachment-new-2，没有 attachment-new-3",
    );
    const upload = (mime: string, body: string) =>
      f.mcp<{ id: string }>(f.primary.owner, "upload_attachment", {
        card_id: f.card.id,
        file: Buffer.from(body).toString("base64"),
        mime,
        kind: "evidence",
        attach_to: { kind: "timeline_entry", id: comment.id },
      });
    const pdf = await upload("application/pdf", "%PDF-1.4");
    const log = await upload("text/plain", "log line");
    const expected = `评审 ${pdf.id}，日志 ${log.id}，没有 attachment-new-3`;

    const detail = (await f.call(f.projectPath(`/cards/${f.card.id}`)))
      .json as CardDetail;
    expect(detail.timeline.find((e) => e.id === comment.id)?.body).toBe(
      expected,
    );
    const card = await f.mcp<{ timeline: { id: string; body: string }[] }>(
      f.primary.owner,
      "get_card",
      { card_id: f.card.id },
    );
    expect(card.timeline.find((e) => e.id === comment.id)?.body).toBe(expected);
    const updates = await f.mcp<{ timeline: { id: string; body: string }[] }>(
      f.primary.owner,
      "get_updates",
      { card_id: f.card.id, since_seq: 0 },
    );
    expect(updates.timeline.find((e) => e.id === comment.id)?.body).toBe(
      expected,
    );
    // The stored body is unchanged: only reads resolve the numbers.
    expect(
      f
        .store()
        .uow.read((tx) => tx.timeline.list(f.card.project_id))
        .find((e) => e.id === comment.id)?.body,
    ).toContain("attachment-new-1");
  } finally {
    await f.close();
  }
}, 30_000);
