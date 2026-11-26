import type { Decision, Timestamp } from "./entities.js";

/** C-753: how far back project_snapshot reports owner-required declarations. */
export const OWNER_REQUIRED_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * C-753: PM declarations that only the owner may decide, within the last
 * seven days before `now`, newest first, with who declared and on what basis.
 * Without `now` the window ends at the newest declaration.
 */
export function ownerRequiredDeclarations(
  decisions: readonly Decision[],
  now?: Timestamp,
) {
  const declared = decisions.flatMap((q) =>
    q.owner_required
      ? [
          {
            q,
            o: q.owner_required,
            at: Date.parse(q.owner_required.declared_at),
          },
        ]
      : [],
  );
  const end = now
    ? Date.parse(now)
    : Math.max(Number.NEGATIVE_INFINITY, ...declared.map((x) => x.at));
  const items = declared
    .filter(
      ({ at }) => at <= end && at > end - OWNER_REQUIRED_WINDOW_DAYS * DAY_MS,
    )
    .sort((a, b) => b.at - a.at || a.q.id.localeCompare(b.q.id))
    .map(({ q, o }) => ({
      decision_id: q.id,
      ...(q.card_id ? { card_id: q.card_id } : {}),
      category: q.category ?? null,
      status: q.status,
      declared_by: o.declared_by,
      declared_at: o.declared_at,
      reason: o.reason,
      basis: o.basis,
    }));
  return {
    window_days: OWNER_REQUIRED_WINDOW_DAYS,
    count: items.length,
    items,
  };
}
