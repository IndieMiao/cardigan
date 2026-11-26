import type { Delivery, Event, Run } from "../entities.js";
import { appendEvents, eventsOfType } from "../event-index.js";
import type { AttachmentId } from "../ids.js";
import type { CommandDraft } from "./core.js";

/**
 * C-769: evidence for a delivery that reached the card after the reviewer's
 * Run started, i.e. possibly after the reviewer read the card. Counted are
 * files bound to the delivery and files its author uploaded to the card;
 * the reviewer's own uploads never count. `before` limits the window to
 * uploads recorded before that event (the review's own submission).
 */
export function lateEvidence(
  d: CommandDraft,
  run: Run,
  delivery: Delivery,
  before?: Event,
): AttachmentId[] {
  const events = appendEvents(d.state.events, d.events);
  const started = eventsOfType(events, "run_started").find(
    (e) => (e.payload as { run_id?: unknown } | null)?.run_id === run.id,
  );
  if (!started && !run.started_at) return [];
  const author = d.list("runs").find((r) => r.id === delivery.run_id);
  const reviewer = `assignment:${run.assignment_id}`;
  const cardId = d.work(delivery.work_item_id).card_id;
  const files = new Map(
    d
      .list("attachments")
      .filter(
        (a) =>
          a.card_id === cardId &&
          a.uploaded_by !== reviewer &&
          ((a.attach_to.kind === "delivery" &&
            a.attach_to.id === delivery.id) ||
            (author !== undefined &&
              a.uploaded_by === `assignment:${author.assignment_id}`)),
      )
      .map((a) => [a.id as string, a.id]),
  );
  const after = (e: Event) =>
    started ? e.seq > started.seq : e.created_at > (run.started_at as string);
  const late: AttachmentId[] = [];
  for (const e of eventsOfType(events, "attachment_uploaded")) {
    const id = (e.payload as { attachment_id?: unknown } | null)?.attachment_id;
    const file = typeof id === "string" ? files.get(id) : undefined;
    if (!file || !after(e) || (before && e.seq >= before.seq)) continue;
    files.delete(id as string);
    late.push(file);
  }
  return late;
}
