import type { Event, Precheck, PrecheckView } from "./entities.js";
import type { CardId } from "./ids.js";

export type { Precheck, PrecheckView } from "./entities.js";

export function prechecks(events: readonly Event[], card?: CardId): Precheck[] {
  const latest = new Map<string, Precheck>();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (
      e.actor.kind !== "system" ||
      (card && e.card_id !== card) ||
      !["precheck_queued", "precheck_started", "precheck_finished"].includes(
        e.type,
      )
    )
      continue;
    const p = e.payload as unknown as Precheck;
    if (p?.attempt_id && p.card_id === e.card_id) latest.set(p.attempt_id, p);
  }
  return [...latest.values()];
}
export function precheckView({
  branch: _branch,
  machine_id: _machine,
  ...view
}: Precheck): PrecheckView {
  return view;
}
