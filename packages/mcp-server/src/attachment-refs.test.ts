import { expect, test } from "vitest";
import {
  attachmentReferenceIds,
  resolvePendingAttachmentRefs,
} from "./attachment-refs.js";

test("attachment numbers are read as whole words, once each", () => {
  expect(
    attachmentReferenceIds(
      "见 attachment-12，attachment-3 和 attachment-12；attachment-new-1 xattachment-4 attachment-5x attachment-0",
    ),
  ).toEqual(["attachment-12", "attachment-3"]);
});

test("C-615 attachment-new-N is the author's N-th upload to that entry, by number", () => {
  const entry = { id: "C-1#2", author: "human", card_id: "C-1" } as const;
  const on = (
    id: string,
    uploaded_by = "human",
    target = "C-1#2",
    card_id = "C-1",
  ) =>
    ({
      id,
      uploaded_by,
      card_id,
      attach_to: { kind: "timeline_entry", id: target },
    }) as const;
  const attachments = [
    on("attachment-10"),
    on("attachment-9"),
    // Someone else's file on the same comment, another comment's file and a
    // delivery file never count.
    on("attachment-8", "assignment:A-1"),
    on("attachment-7", "human", "C-1#3"),
    {
      id: "attachment-6",
      uploaded_by: "human",
      card_id: "C-1",
      attach_to: { kind: "delivery", id: "D-1" },
    } as const,
  ];
  expect(
    resolvePendingAttachmentRefs(
      "attachment-new-1、attachment-new-2、attachment-new-3、xattachment-new-1、`attachment-new-2`",
      entry,
      attachments as unknown as Parameters<
        typeof resolvePendingAttachmentRefs
      >[2],
    ),
  ).toBe(
    "attachment-9、attachment-10、attachment-new-3、xattachment-new-1、`attachment-10`",
  );
  expect(resolvePendingAttachmentRefs("attachment-new-1", entry, [])).toBe(
    "attachment-new-1",
  );
  expect(resolvePendingAttachmentRefs("无引用", entry, [])).toBe("无引用");
});
