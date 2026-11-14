import { PAGE_LIMITS } from "./pagination.js";
/**
 * C-134: Decision history is read page by page, newest resolution first.
 * The cursor is the (resolution.at, id) key of the last row returned, so a
 * decision resolved while the user pages through never shifts or repeats rows.
 */
export const DECISION_HISTORY_DEFAULT_LIMIT = PAGE_LIMITS.decisions.default;
export const DECISION_HISTORY_MAX_LIMIT = PAGE_LIMITS.decisions.max;

interface HistoryRow {
  readonly id: string;
  readonly resolution: { readonly at: string };
}

export function encodeDecisionHistoryCursor(row: HistoryRow): string {
  return Buffer.from(
    JSON.stringify([row.resolution.at, row.id]),
    "utf8",
  ).toString("base64url");
}

/** Returns undefined for anything that is not a cursor this module issued. */
export function decodeDecisionHistoryCursor(
  cursor: string,
): { at: string; id: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string" &&
      parsed[1].length > 0
    )
      return { at: parsed[0], id: parsed[1] };
  } catch {
    // fall through
  }
  return undefined;
}

/** `rows` must already be filtered; the page order is re-derived here so it
 * matches the cursor comparison exactly (code-unit order, newest first). */
export function pageDecisionHistory<T extends HistoryRow>(
  rows: readonly T[],
  options: { limit: number; after?: { at: string; id: string } | undefined },
): { decisions: T[]; next_cursor: string | null } {
  const { after } = options;
  const sorted = [...rows].sort((a, b) =>
    compareKey(b.resolution.at, b.id, a.resolution.at, a.id),
  );
  const rest = after
    ? sorted.filter(
        (q) =>
          q.resolution.at < after.at ||
          (q.resolution.at === after.at && q.id < after.id),
      )
    : sorted;
  const page = rest.slice(0, options.limit);
  const last = page.at(-1);
  return {
    decisions: page,
    next_cursor:
      rest.length > page.length && last
        ? encodeDecisionHistoryCursor(last)
        : null,
  };
}

function compareKey(
  atA: string,
  idA: string,
  atB: string,
  idB: string,
): number {
  if (atA !== atB) return atA < atB ? -1 : 1;
  if (idA !== idB) return idA < idB ? -1 : 1;
  return 0;
}
