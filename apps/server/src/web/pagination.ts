import { HttpRejection } from "./http.js";

/** C-243 provisional defaults; final numeric rules require human confirmation. */
export const PAGE_LIMITS = {
  board: { default: 10, max: 50 },
  cards: { default: 10, max: 50 },
  activity: { default: 50, max: 200 },
  timeline: { default: 200, max: 200 },
  decisions: { default: 10, max: 100 },
  execution: { default: 50, max: 100 },
  runs: { default: 10, max: 10 },
} as const;

export function pageLimit(
  value: string | null,
  kind: keyof typeof PAGE_LIMITS,
): number {
  if (value === null || value === "") return PAGE_LIMITS[kind].default;
  const number = Number(value);
  if (
    !Number.isSafeInteger(number) ||
    number < 1 ||
    number > PAGE_LIMITS[kind].max
  )
    throw new HttpRejection(400, "validation_failed", "分页条数无效或超过上限");
  return number;
}

export function encodeCursor(
  scope: string,
  key: readonly (string | number)[],
): string {
  return Buffer.from(JSON.stringify([scope, key])).toString("base64url");
}

export function decodeCursor(
  value: string | null,
  scope: string,
): (string | number)[] | undefined {
  if (!value) return undefined;
  try {
    if (value.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(value))
      throw new Error();
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed[0] === scope &&
      Array.isArray(parsed[1]) &&
      parsed[1].every(
        (v: unknown) =>
          typeof v === "string" ||
          (typeof v === "number" && Number.isSafeInteger(v)),
      )
    )
      return parsed[1];
  } catch {
    /* Invalid cursors never fall back to an unbounded first page. */
  }
  throw new HttpRejection(
    400,
    "validation_failed",
    "分页游标无效，请重新加载当前页",
  );
}
