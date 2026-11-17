import type { Event } from "./entities.js";
import type { CardId } from "./ids.js";
import { mergeBatches } from "./merge-batch.js";

/** Only system-owned check events identify readable attempts, never log_ref. */
export function checkLogAttempts(events: readonly Event[], card: CardId) {
  const attempts = new Map<
    string,
    {
      attempt_id: string;
      kind: "merge" | "precheck";
      status: string;
    }
  >();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.card_id !== card || event.actor.kind !== "system") continue;
    const kind = /^merge_check_(queued|started|finished)$/u.test(event.type)
      ? "merge"
      : /^precheck_(queued|started|finished)$/u.test(event.type)
        ? "precheck"
        : undefined;
    const payload = event.payload;
    if (
      !kind ||
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    )
      continue;
    const p = payload as Record<string, unknown>;
    if (
      typeof p.attempt_id !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(p.attempt_id)
    )
      continue;
    attempts.set(p.attempt_id, {
      attempt_id: p.attempt_id,
      kind,
      status:
        typeof p.status === "string"
          ? p.status
          : event.type.endsWith("queued")
            ? "queued"
            : event.type.endsWith("started")
              ? "running"
              : "finished",
    });
  }
  const batches = new Set(
    mergeBatches(events)
      .filter((b) => b.members.some((m) => m.card_id === card))
      .map((b) => b.id),
  );
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (
      event.card_id ||
      event.actor.kind !== "system" ||
      !/^merge_batch_check_(queued|started|finished)$/u.test(event.type)
    )
      continue;
    const p = event.payload as unknown as {
      batch_id: import("./ids.js").MergeBatchId;
      check: { attempt_id: string; status: string };
    };
    if (
      batches.has(p.batch_id) &&
      /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(p.check?.attempt_id)
    )
      attempts.set(p.check.attempt_id, {
        attempt_id: p.check.attempt_id,
        kind: "merge",
        status: p.check.status,
      });
  }
  return [...attempts.values()];
}
