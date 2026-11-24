import {
  ATTACHMENT_ID_PATTERN,
  attachmentReferenceIdsIn,
  MAX_ATTACHMENT_REF_READ,
} from "@cardigan/domain";
import { useEffect, useMemo, useState } from "react";
import type { CardiganClient, ReferencedAttachment } from "./api.js";

const NONE: readonly ReferencedAttachment[] = [];

/**
 * C-615: the other cards' attachments that `texts` name and `known` does not
 * cover, read from the server with the card's permissions (a draft's preview,
 * timeline pages loaded later or kept across a refresh). Unreadable or
 * missing numbers come back absent and stay text.
 *
 * `version` is the page data the answer belongs to. A new one asks again and,
 * until that answer arrives, shows the numbers as text (V-3070): a permission
 * withdrawn since then must not keep showing the old name and link.
 *
 * Numbers no attachment can have are not asked for, and the rest go in
 * batches of at most `MAX_ATTACHMENT_REF_READ`, each on its own: one bad
 * number or a failed batch never hides the readable ones of another batch.
 */
export function useAttachmentRefs(
  client: Pick<CardiganClient, "attachmentRefs">,
  projectId: string,
  cardId: string,
  texts: readonly string[],
  known: ReadonlySet<string>,
  version: unknown,
): readonly ReferencedAttachment[] {
  return useAttachmentRefsState(
    client,
    projectId,
    cardId,
    texts,
    known,
    version,
  ).attachments;
}

/** What `useAttachmentRefs` shows, and whether it answers the current input. */
export interface AttachmentRefsState {
  readonly attachments: readonly ReferencedAttachment[];
  /**
   * False while a read for the current numbers and `version` is outstanding:
   * `attachments` is then empty for now, not the answer (V-3096).
   */
  readonly settled: boolean;
}

/** `useAttachmentRefs` that also says whether its answer is still coming. */
export function useAttachmentRefsState(
  client: Pick<CardiganClient, "attachmentRefs">,
  projectId: string,
  cardId: string,
  texts: readonly string[],
  known: ReadonlySet<string>,
  version: unknown,
): AttachmentRefsState {
  // Each body on its own (V-3068): an open code block in one comment must
  // not hide the numbers of the next. Callers memoise `texts`.
  const missing = useMemo(
    () =>
      attachmentReferenceIdsIn(texts).filter(
        (id) => !known.has(id) && ATTACHMENT_ID_PATTERN.test(id),
      ),
    [texts, known],
  );
  const key = `${projectId}\n${cardId}\n${missing.join(",")}`;
  const [answer, setAnswer] = useState<{
    readonly key: string;
    readonly version: unknown;
    readonly attachments: readonly ReferencedAttachment[];
  }>();
  const current = answer?.key === key && answer.version === version;
  useEffect(() => {
    if (current || !missing.length || !client.attachmentRefs) return;
    const read = client.attachmentRefs.bind(client);
    let live = true;
    const batches: string[][] = [];
    for (let i = 0; i < missing.length; i += MAX_ATTACHMENT_REF_READ)
      batches.push(missing.slice(i, i + MAX_ATTACHMENT_REF_READ));
    void Promise.all(
      batches.map((batch) =>
        read(projectId, cardId, batch).then(
          (response) => response.attachments,
          // A failed batch leaves its numbers as text; the next change asks again.
          () => NONE,
        ),
      ),
    ).then((results) => {
      if (live) setAnswer({ key, version, attachments: results.flat() });
    });
    return () => {
      live = false;
    };
  }, [current, missing, client, projectId, cardId, key, version]);
  const waiting = !current && missing.length > 0 && !!client.attachmentRefs;
  const attachments = current && answer ? answer.attachments : NONE;
  return useMemo(
    () => ({ attachments, settled: !waiting }),
    [attachments, waiting],
  );
}
