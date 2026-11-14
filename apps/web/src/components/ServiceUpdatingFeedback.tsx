import { useSyncExternalStore } from "react";
import {
  SERVICE_UPDATING_MESSAGE,
  type ServiceUpdatingNotice,
  serviceUpdatingNotice,
} from "../service-retry.js";
import { RequestFeedback } from "./RequestFeedback.js";

/**
 * C-250: while any request is waiting out a server restart, say so instead of
 * leaving a silent spinner; the notice disappears once every retry settles.
 */
export function ServiceUpdatingFeedback({
  notice = serviceUpdatingNotice,
}: {
  readonly notice?: ServiceUpdatingNotice;
}) {
  const active = useSyncExternalStore(
    notice.subscribe,
    notice.active,
    notice.active,
  );
  if (!active) return null;
  return (
    <RequestFeedback
      pending
      interactive
      pendingMessage={SERVICE_UPDATING_MESSAGE}
    />
  );
}
