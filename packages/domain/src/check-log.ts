import type { Event } from "./entities.js";
import type { CardId } from "./ids.js";

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
  return [...attempts.values()];
}
