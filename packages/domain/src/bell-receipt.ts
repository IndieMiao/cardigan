import type { Run } from "./entities.js";

/** A business start (even one caused by a rejected tool) is not an inbox receipt. */
export function matchesBellReceipt(
  run: Run,
  tool: string,
  args: Record<string, unknown>,
) {
  const bell = run.bell_delivery;
  if (
    !bell?.runtime_ref ||
    bell.run_id !== run.id ||
    bell.received_at ||
    run.status !== "running"
  )
    return false;
  return tool === "heartbeat"
    ? args.run_id === run.id
    : (tool === "get_updates" || tool === "ack_events") &&
        args.card_id === bell.card_id;
}

/** Only an open receipt window owns dispatch. A late receipt can still be recorded. */
export function unreceivedBell(run: Run) {
  const bell = run.bell_delivery;
  return bell?.run_id === run.id &&
    bell.sent_at &&
    !bell.received_at &&
    !bell.escalated_at &&
    (run.status === "running" || run.status === "dispatched")
    ? bell
    : undefined;
}
