import { type Result, validationFailed } from "./errors.js";

declare const idBrand: unique symbol;
export type Id<Kind extends string> = string & { readonly [idBrand]: Kind };
const formats = {
  employee: ["E-", ""],
  member: ["M-", ""],
  card: ["C-", ""],
  work_item: ["W-", ""],
  assignment: ["A-", ""],
  run: ["R-", ""],
  delivery: ["D-", ""],
  review: ["V-", ""],
  decision: ["Q-", ""],
  human_action: ["H-", ""],
} as const;
/**
 * C-132: decisions and human actions were `q(n)` / `h(n)` before. The legacy
 * spelling still parses, and always normalizes to the current `Q-n` / `H-n`.
 */
const legacyFormats: Partial<
  Record<FormattedIdKind, readonly [string, string]>
> = {
  decision: ["q(", ")"],
  human_action: ["h(", ")"],
};
export type FormattedIdKind = keyof typeof formats;
// Project-local allocation deliberately excludes global identity IDs.
export type ReadableIdKind = Exclude<FormattedIdKind, "employee" | "member">;
export type MemberId = Id<"member">;
export type EmployeeId = Id<"employee">;
export type CardId = Id<"card">;
export type WorkItemId = Id<"work_item">;
export type AssignmentId = Id<"assignment">;
export type RunId = Id<"run">;
export type DeliveryId = Id<"delivery">;
export type ReviewId = Id<"review">;
export type DecisionId = Id<"decision">;
export type HumanActionId = Id<"human_action">;
export type TimelineEntryId = Id<"timeline_entry">;
export type EventId = Id<"event">;
// These identifiers have no textual format specified in M1.1.
export type ProjectId = string;
export type RoleId = string;
export type AttachmentId = string;
export type MachineId = string;

const positiveInteger = (value: number) =>
  Number.isSafeInteger(value) && value > 0;
const decimal = (value: string) =>
  /^[1-9][0-9]*$/u.test(value) &&
  positiveInteger(Number(value)) &&
  String(Number(value)) === value;

export function formatId<K extends FormattedIdKind>(
  kind: K,
  sequence: number,
): Result<Id<K>> {
  if (!Object.hasOwn(formats, kind)) return validationFailed("Unknown ID kind");
  if (!positiveInteger(sequence))
    return validationFailed("ID sequence must be a positive safe integer");
  const [prefix, suffix] = formats[kind];
  return { ok: true, value: `${prefix}${sequence}${suffix}` as Id<K> };
}

export function parseId<K extends FormattedIdKind>(
  kind: K,
  input: unknown,
): Result<{ id: Id<K>; sequence: number }> {
  if (!Object.hasOwn(formats, kind)) return validationFailed("Unknown ID kind");
  if (typeof input !== "string") return validationFailed("ID must be a string");
  const legacy = legacyFormats[kind];
  for (const [prefix, suffix] of legacy
    ? [formats[kind], legacy]
    : [formats[kind]]) {
    const digits = input.slice(
      prefix.length,
      suffix ? -suffix.length : undefined,
    );
    if (
      input.startsWith(prefix) &&
      input.endsWith(suffix) &&
      input.length > prefix.length + suffix.length &&
      decimal(digits)
    ) {
      const sequence = Number(digits);
      const [current, tail] = formats[kind];
      return {
        ok: true,
        value: { id: `${current}${sequence}${tail}` as Id<K>, sequence },
      };
    }
  }
  return validationFailed(`Invalid ${kind} ID`);
}

/** C-132: the current spelling of a legacy `q(n)` / `h(n)` string, else `undefined`. */
export function normalizeLegacyId(input: string): string | undefined {
  const match = /^([qh])\(([1-9][0-9]*)\)$/u.exec(input);
  if (!match) return undefined;
  const parsed = parseId(match[1] === "q" ? "decision" : "human_action", input);
  return parsed.ok ? parsed.value.id : undefined;
}

export function formatTimelineEntryId(
  card_id: CardId,
  sequence: number,
): Result<TimelineEntryId> {
  if (!parseId("card", card_id).ok || !positiveInteger(sequence))
    return validationFailed("Invalid timeline entry ID components");
  return { ok: true, value: `${card_id}#${sequence}` as TimelineEntryId };
}

export function parseTimelineEntryId(
  input: unknown,
): Result<{ id: TimelineEntryId; card_id: CardId; sequence: number }> {
  if (typeof input !== "string")
    return validationFailed("Timeline entry ID must be a string");
  const parts = input.split("#");
  const card = parseId("card", parts[0]);
  const sequence = parts[1];
  if (
    parts.length !== 2 ||
    !card.ok ||
    sequence === undefined ||
    !decimal(sequence)
  ) {
    return validationFailed("Invalid timeline entry ID");
  }
  return {
    ok: true,
    value: {
      id: input as TimelineEntryId,
      card_id: card.value.id,
      sequence: Number(sequence),
    },
  };
}

// Canonical uppercase Crockford Base32; the first digit prevents 128-bit overflow.
// Generation (time/randomness) belongs to the allocator adapter, never this package.
export function parseEventId(input: unknown): Result<EventId> {
  return typeof input === "string" &&
    input.length === 26 &&
    /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(input)
    ? { ok: true, value: input as EventId }
    : validationFailed("Event ID must be a canonical ULID");
}
