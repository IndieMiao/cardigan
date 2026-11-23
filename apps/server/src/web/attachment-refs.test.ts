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
    // A number the page did not receive yet (a draft, an older page) resolves
    // on its own with the same rules.
    const refs = async (ids: string) =>
      (
        await f.call(
          f.projectPath(`/cards/${other.id}/attachment-refs?ids=${ids}`),
        )
      ).json as { attachments: { id: string; card_id: string }[] };
    const detail = await read();
    expect(detail.referenced_attachments).toEqual([
      expect.objectContaining({
        id: file.id,
        card_id: f.card.id,
        mime: "application/pdf",
        // V-3070: the chip's file goes through the referencing card.
        download_path: `/api/projects/${encodeURIComponent(f.card.project_id)}/cards/${other.id}/attachment-refs/${file.id}`,
      }),
    ]);
    const viaRef = f.projectPath(
      `/cards/${other.id}/attachment-refs/${file.id}`,
    );
    const direct = f.projectPath(`/attachments/${file.id}`);
    expect((await f.call(viaRef)).status).toBe(200);
    // V-3068: a later comment ending inside an unclosed code block does not
    // turn the earlier comment's number into code: bodies are parsed apart.
    const fence = await f.call(f.projectPath(`/cards/${other.id}/comments`), {
      method: "POST",
      body: { body: "构建日志：\n```text\nBuild succeeded" },
    });
    expect(fence.status).toBe(200);
    expect((await read()).referenced_attachments?.map((a) => a.id)).toEqual([
      file.id,
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
    expect((await refs(file.id)).attachments).toEqual([]);
    // A link kept on an open page stops working; the owning card's own route
    // keeps its existing rule for the human.
    expect((await f.call(viaRef)).status).toBe(404);
    expect((await f.call(`${viaRef}/thumbnail`)).status).toBe(404);
    expect((await f.call(direct)).status).toBe(200);
    await f.call(f.projectPath(`/cards/${f.card.id}/sensitive`), {
      method: "POST",
      body: { sensitive: false },
    });
    expect((await read()).referenced_attachments).toHaveLength(1);
    expect(
      (await refs(`${file.id},attachment-999`)).attachments.map((a) => [
        a.id,
        a.card_id,
      ]),
    ).toEqual([[file.id, f.card.id]]);
    // The card's own attachment is already on its page.
    expect(
      (
        await f.call(
          f.projectPath(`/cards/${f.card.id}/attachment-refs?ids=${file.id}`),
        )
      ).json,
    ).toEqual({ attachments: [] });
    expect(
      (
        await f.call(
          f.projectPath(`/cards/${other.id}/attachment-refs?ids=C-1`),
        )
      ).status,
    ).toBe(400);

    f.store().uow.run((tx) =>
      tx.project_preferences.put(f.card.project_id, {
        id: f.card.project_id,
        auto_merge_after_minutes: null,
        cross_card_read: false,
      }),
    );
    expect((await read()).referenced_attachments).toEqual([]);
    expect((await refs(file.id)).attachments).toEqual([]);
    expect((await f.call(viaRef)).status).toBe(404);
  } finally {
    await f.close();
  }
}, 30_000);

test("C-615 a comment's attachment-new-N reads as the file uploaded for slot N in the Workbench, get_card and get_updates", async () => {
  const f = await m5Cross();
  try {
    await f.password(TEST_PASSWORD);
    await f.login();
    const posted = await f.call(f.projectPath(`/cards/${f.card.id}/comments`), {
      method: "POST",
      body: {
        body: "评审 attachment-new-1，日志attachment-new-2，没有 attachment-new-3，示例 `attachment-new-1`",
      },
    });
    expect(posted.status).toBe(200);
    const comment = posted.json as { id: string };
    let key = 0;
    const upload = async (mime: string, body: string, ref_slot?: number) => {
      const response = await f.call(
        f.projectPath(`/cards/${f.card.id}/attachments`),
        {
          method: "POST",
          headers: { "Idempotency-Key": `c615-upload-${++key}` },
          body: {
            file: Buffer.from(body).toString("base64"),
            mime,
            kind: "evidence",
            attach_to: { kind: "timeline_entry", id: comment.id },
            ...(ref_slot === undefined ? {} : { ref_slot }),
          },
        },
      );
      return response;
    };
    const pdf = (await upload("application/pdf", "%PDF-1.4", 1)).json as {
      id: string;
    };
    // V-3070: another upload to the same comment before slot 2 is filled
    // (a failed file being retried) takes no slot.
    const extra = await upload("text/plain", "unrelated");
    expect(extra.status).toBe(200);
    const log = (await upload("text/plain", "log line", 2)).json as {
      id: string;
    };
    // A slot is filled once.
    expect((await upload("text/plain", "again", 2)).status).toBe(400);
    const expected = `评审 ${pdf.id}，日志${log.id}，没有 attachment-new-3，示例 \`attachment-new-1\``;

    const detail = (await f.call(f.projectPath(`/cards/${f.card.id}`)))
      .json as CardDetail;
    expect(detail.timeline.find((e) => e.id === comment.id)?.body).toBe(
      expected,
    );
    await f.start(f.primary.owner);
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
