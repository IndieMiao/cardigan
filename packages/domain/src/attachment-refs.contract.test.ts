import { expect, test } from "vitest";
import {
  attachmentReferenceIds,
  attachmentReferenceIdsIn,
  attachmentRefMatches,
  markdownLiteralRanges,
  replaceAttachmentRefs,
  resolvePendingAttachmentRefs,
} from "./attachment-refs.js";
import type { Attachment, TimelineEntry } from "./entities.js";

const tokens = (text: string) => attachmentRefMatches(text).map((m) => m.token);

test("C-615 a number touching CJK text is a reference; one touching ASCII word characters is not", () => {
  expect(
    attachmentReferenceIds(
      "见attachment-12的，attachment-3 和 attachment-12；attachment-new-1 xattachment-4 attachment-5x attachment-0 a-attachment-6 attachment-7_ attachment-8.pdf",
    ),
  ).toEqual(["attachment-12", "attachment-3", "attachment-8"]);
  expect(attachmentRefMatches("见attachment-new-2 后")).toEqual([
    {
      start: 1,
      end: 17,
      token: "attachment-new-2",
      pending: true,
      number: 2,
    },
  ]);
});

test("C-615 code, autolinks and link destinations stay literal", () => {
  const body = [
    "正文 attachment-1，代码 `attachment-2` 与 ``a ` attachment-3``",
    "转义 \\`attachment-4\\`",
    "[见 attachment-5](https://x.test/attachment-6) <https://x.test/attachment-7>",
    "",
    "```",
    "attachment-8",
    "```",
    "",
    "    attachment-9",
    "",
    "- 列表",
    "",
    "    attachment-10",
    "~~~~",
    "attachment-11",
  ].join("\n");
  expect(tokens(body)).toEqual([
    "attachment-1",
    "attachment-4",
    "attachment-5",
    "attachment-10",
  ]);
  // An unclosed code span is literal backticks, not code.
  expect(tokens("`attachment-12")).toEqual(["attachment-12"]);
  expect(markdownLiteralRanges("无代码")).toEqual([]);
  // A paragraph continuation line indented by four spaces is still prose.
  expect(tokens("段落\n    attachment-13")).toEqual(["attachment-13"]);
});

test("C-615 replacing references leaves literal text alone", () => {
  expect(
    replaceAttachmentRefs("attachment-new-1 `attachment-new-1`", (m) =>
      m.pending ? "attachment-99" : undefined,
    ),
  ).toBe("attachment-99 `attachment-new-1`");
});

test("C-615 attachment-new-N is the author's N-th upload to that entry, by number", () => {
  const entry = {
    id: "C-1#2",
    author: "human",
    card_id: "C-1",
  } as unknown as Pick<TimelineEntry, "id" | "author" | "card_id">;
  const on = (id: string, uploaded_by = "human", target = "C-1#2") =>
    ({
      id,
      uploaded_by,
      card_id: "C-1",
      attach_to: { kind: "timeline_entry", id: target },
    }) as unknown as Pick<
      Attachment,
      "id" | "attach_to" | "uploaded_by" | "card_id"
    >;
  const attachments = [
    on("attachment-10"),
    on("attachment-9"),
    // Someone else's file on the same comment and another comment's file never count.
    on("attachment-8", "assignment:A-1"),
    on("attachment-7", "human", "C-1#3"),
  ];
  expect(
    resolvePendingAttachmentRefs(
      "attachment-new-1、attachment-new-2、attachment-new-3、xattachment-new-1、`attachment-new-2`",
      entry,
      attachments,
    ),
  ).toBe(
    "attachment-9、attachment-10、attachment-new-3、xattachment-new-1、`attachment-new-2`",
  );
  expect(resolvePendingAttachmentRefs("attachment-new-1", entry, [])).toBe(
    "attachment-new-1",
  );
});

test("C-615 separate bodies are parsed apart: one body's open fence does not hide another's numbers", () => {
  const bodies = ["构建日志：\n```text\nBuild attachment-1", "见 attachment-2"];
  expect(attachmentReferenceIds(bodies.join("\n"))).toEqual([]);
  expect(attachmentReferenceIdsIn(bodies)).toEqual(["attachment-2"]);
  expect(
    attachmentReferenceIdsIn(["attachment-3", "再看 attachment-3"]),
  ).toEqual(["attachment-3"]);
});
