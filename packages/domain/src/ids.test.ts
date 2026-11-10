import { describe, expect, test } from "vitest";
import {
  type CardId,
  type FormattedIdKind,
  formatId,
  formatTimelineEntryId,
  parseEventId,
  parseId,
  parseTimelineEntryId,
  type Result,
} from "./index.js";

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function invalid(result: Result<unknown>) {
  expect(result).toEqual({
    ok: false,
    error: { code: "validation_failed", message: expect.any(String) },
  });
}
const examples = [
  ["employee", "E-1"],
  ["card", "C-1"],
  ["work_item", "W-1"],
  ["assignment", "A-1"],
  ["run", "R-1"],
  ["delivery", "D-1"],
  ["review", "V-1"],
  ["decision", "q(1)"],
  ["human_action", "h(1)"],
] as const satisfies readonly (readonly [FormattedIdKind, string])[];

test("unknown and inherited ID kinds return validation errors", () => {
  for (const kind of ["unknown", "toString", "__proto__"]) {
    invalid(formatId(kind as FormattedIdKind, 1));
    invalid(parseId(kind as FormattedIdKind, "C-1"));
  }
});

describe.each(examples)("%s IDs", (kind, example) => {
  test.each([1, 42, Number.MAX_SAFE_INTEGER])(
    "round-trips canonical sequence %s",
    (sequence) => {
      const id = example.replace("1", String(sequence));
      expect(value(formatId(kind, sequence))).toBe(id);
      expect(value(parseId(kind, id))).toEqual({ id, sequence });
    },
  );
  test.each([
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid sequence %s", (sequence) => {
    invalid(formatId(kind, sequence));
    invalid(parseId(kind, example.replace("1", String(sequence))));
  });
  test("rejects malformed, noncanonical and non-string inputs", () => {
    for (const input of [
      null,
      undefined,
      1,
      {},
      [],
      "",
      ` ${example}`,
      `${example} `,
      `${example}\n`,
      example.replace("1", "01"),
      example.replace("1", "+1"),
      example.replace("1", "1e2"),
      example.replace("1", "1.0"),
      example.replace("1", "١"),
      example.replace("1", ""),
      kind === "card" ? "W-1" : "C-1",
    ])
      invalid(parseId(kind, input));
  });
});

test("timeline IDs retain card and independent entry counters", () => {
  const card = value(formatId("card", 12));
  expect(value(formatTimelineEntryId(card, 7))).toBe("C-12#7");
  expect(value(parseTimelineEntryId("C-12#7"))).toEqual({
    id: "C-12#7",
    card_id: card,
    sequence: 7,
  });
  const maximum = value(formatId("card", Number.MAX_SAFE_INTEGER));
  const id = value(formatTimelineEntryId(maximum, Number.MAX_SAFE_INTEGER));
  expect(value(parseTimelineEntryId(id)).sequence).toBe(
    Number.MAX_SAFE_INTEGER,
  );
});

test("timeline IDs reject malformed components, overflow and trailing text", () => {
  for (const input of [
    null,
    1,
    "C-0#1",
    "C-01#1",
    "C-1#0",
    "C-1#01",
    "C-1#-1",
    "C-1#1.5",
    "C-1#1#2",
    "W-1#1",
    "C-1#",
    "C-1#1\n",
    "C-1#9007199254740992",
    "C-1#1e2",
  ])
    invalid(parseTimelineEntryId(input));
  invalid(formatTimelineEntryId("W-1" as CardId, 1));
  for (const sequence of [
    0,
    -1,
    1.5,
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    invalid(formatTimelineEntryId(value(formatId("card", 1)), sequence));
  }
});

test("event IDs accept canonical ULIDs including the 128-bit boundaries", () => {
  for (const id of [
    "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "0".repeat(26),
    `7${"Z".repeat(25)}`,
  ]) {
    expect(value(parseEventId(id))).toBe(id);
  }
});

test("event IDs reject overflow, ambiguous alphabet, lowercase and wrong lengths", () => {
  for (const input of [
    null,
    1,
    "",
    "0".repeat(25),
    "0".repeat(27),
    `8${"0".repeat(25)}`,
    "01arz3ndektsv4rrffq69g5fav",
    "01ARZ3NDEKTSV4RRFFQ69G5FAV\n",
    ...["I", "L", "O", "U"].map((letter) => "0".repeat(25) + letter),
  ])
    invalid(parseEventId(input));
});
