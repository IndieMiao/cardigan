import { matchesBellReceipt } from "@cardigan/domain";
import type { ToolContext } from "../tools/types.js";

/** Bind before the handler can yield; a late response cannot ACK a successor Run. */
export function captureBellReceipt(
  { store, identity }: ToolContext,
  tool: string,
  args: Record<string, unknown>,
) {
  if (tool !== "get_updates" && tool !== "ack_events" && tool !== "heartbeat")
    return;
  const { project_id: project, assignment_id: owner } = identity.actor;
  const run = store.uow.read((tx) =>
    tx.runs
      .list(project)
      .find(
        (r) => r.assignment_id === owner && matchesBellReceipt(r, tool, args),
      ),
  );
  if (!run) return;
  return () =>
    store.uow.run((tx) => {
      const current = tx.runs.get(project, run.id);
      if (current?.bell_delivery && matchesBellReceipt(current, tool, args)) {
        tx.runs.put(project, {
          ...current,
          bell_delivery: {
            ...current.bell_delivery,
            received_at: new Date().toISOString(),
          },
        });
      }
    });
}
