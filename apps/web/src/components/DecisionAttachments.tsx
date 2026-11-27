import type { ReactNode } from "react";
import type { AttachmentView } from "../api.js";
import { AttachmentList } from "./AttachmentGrid.js";

/**
 * §6/§9 C-95: card attachments a decision references, as the shared
 * attachment tiles (C-820): bitmaps open the lightbox, other files download.
 * Both use the authenticated attachment route. C-810: `more` (“还有 N 个”)
 * follows the last one. `flow` adds space around the grid; a layout that
 * spaces its own parts (DecisionBrief) turns it off.
 */
export function DecisionAttachments({
  attachments,
  more,
  flow = true,
}: {
  attachments: readonly AttachmentView[] | undefined;
  more?: ReactNode;
  flow?: boolean;
}) {
  if (!attachments?.length && !more) return null;
  return (
    <AttachmentList
      attachments={attachments ?? []}
      label="拍板附件"
      flow={flow}
      more={more || undefined}
    />
  );
}
