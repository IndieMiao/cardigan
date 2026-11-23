import { attachmentReferenceIdsIn } from "@cardigan/domain";
import { useEffect, useMemo, useState } from "react";
import type { CardiganClient, ReferencedAttachment } from "./api.js";

const NONE: readonly ReferencedAttachment[] = [];

/**
 * C-615: the other cards' attachments that `texts` name and `known` does not
 * cover, read from the server with the card's permissions (a draft's preview,
 * timeline pages loaded later or kept across a refresh). `version` is the
 * page data the answer belongs to: a new one asks again, so a permission
 * tightened since then no longer shows the old metadata once the answer
 * arrives. Unreadable or missing numbers come back absent and stay text.
 */
export function useAttachmentRefs(
  client: Pick<CardiganClient, "attachmentRefs">,
  projectId: string,
  cardId: string,
  texts: readonly string[],
  known: ReadonlySet<string>,
  version: unknown,
): readonly ReferencedAttachment[] {
  // Each body on its own (V-3068): an open code block in one comment must
  // not hide the numbers of the next. Callers memoise `texts`.
  const missing = useMemo(
    () => attachmentReferenceIdsIn(texts).filter((id) => !known.has(id)),
    [texts, known],
  );
  const key = `${projectId}\n${cardId}\n${missing.join(",")}`;
  const [answer, setAnswer] = useState<{
    readonly key: string;
    readonly version: unknown;
    readonly attachments: readonly ReferencedAttachment[];
  }>();
  const stale = answer?.key !== key || answer.version !== version;
  useEffect(() => {
    if (!stale || !missing.length || !client.attachmentRefs) return;
    let live = true;
    client.attachmentRefs(projectId, cardId, missing).then(
      (response) => {
        if (live)
          setAnswer({ key, version, attachments: response.attachments });
      },
      () => {
        // A failed read leaves the numbers as text; the next change asks again.
        if (live) setAnswer({ key, version, attachments: NONE });
      },
    );
    return () => {
      live = false;
    };
  }, [stale, missing, client, projectId, cardId, key, version]);
  if (!missing.length || !answer) return NONE;
  // Until a newer answer arrives, keep the previous one for the same numbers.
  return answer.key === key
    ? answer.attachments
    : answer.attachments.filter((a) => missing.includes(a.id));
}
