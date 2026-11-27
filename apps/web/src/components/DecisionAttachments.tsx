import type { AttachmentView } from "../api.js";
import { AttachmentList } from "./AttachmentGrid.js";

/**
 * §6/§9 C-95: card attachments a decision references, as the shared
 * attachment tiles (C-820): bitmaps open the lightbox, other files download.
 * Both use the authenticated attachment route.
 */
export function DecisionAttachments({
  attachments,
}: {
  attachments: readonly AttachmentView[] | undefined;
}) {
  if (!attachments?.length) return null;
  return <AttachmentList attachments={attachments} label="拍板附件" flow />;
}
