import type { Attachment, TimelineEntry } from "@cardigan/domain";

/**
 * C-615: `attachment-123` written in a comment or other body, not part of a
 * longer word. Agents and people write the plain number; the Workbench shows
 * it as a chip when the reader may see that attachment.
 */
export const ATTACHMENT_REFERENCE =
  /(?<![\p{L}\p{N}_-])attachment-[1-9][0-9]*(?![\p{L}\p{N}_-])/gu;

/** The attachment numbers a text mentions, de-duplicated, in order. */
export function attachmentReferenceIds(text: string): string[] {
  return [...new Set(text.match(ATTACHMENT_REFERENCE) ?? [])];
}

/**
 * `attachment-new-N`: the N-th file the comment's author uploaded to that
 * comment. The Workbench comment box writes it for a file that has no number
 * yet, because the files are uploaded after the comment is accepted.
 */
const PENDING_REFERENCE =
  /(?<![\p{L}\p{N}_-])attachment-new-([1-9][0-9]*)(?![\p{L}\p{N}_-])/gu;

/** Whether a body may name a file uploaded with it. */
export function hasPendingAttachmentRefs(body: string): boolean {
  PENDING_REFERENCE.lastIndex = 0;
  return PENDING_REFERENCE.test(body);
}

/**
 * The body with every `attachment-new-N` replaced by the number its upload
 * got, so every reader sees the real number. Only the author's own uploads to
 * this entry count, in upload (number) order; an N not uploaded (yet) stays.
 */
export function resolvePendingAttachmentRefs(
  body: string,
  entry: Pick<TimelineEntry, "id" | "author" | "card_id">,
  attachments: readonly Pick<
    Attachment,
    "id" | "attach_to" | "uploaded_by" | "card_id"
  >[],
): string {
  if (!hasPendingAttachmentRefs(body)) return body;
  const own = attachments
    .filter(
      (a) =>
        a.attach_to.kind === "timeline_entry" &&
        a.attach_to.id === entry.id &&
        (a.card_id === undefined || a.card_id === entry.card_id) &&
        a.uploaded_by === entry.author,
    )
    .map((a) => ({ id: a.id, n: attachmentNumber(a.id) }))
    .filter((a) => Number.isSafeInteger(a.n))
    .sort((a, b) => a.n - b.n);
  if (!own.length) return body;
  return body.replace(
    PENDING_REFERENCE,
    (token, n: string) => own[Number(n) - 1]?.id ?? token,
  );
}

function attachmentNumber(id: string): number {
  return Number(/^attachment-([1-9][0-9]*)$/u.exec(id)?.[1] ?? Number.NaN);
}
