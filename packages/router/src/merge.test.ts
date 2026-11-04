import { expect, test } from "vitest";
import { mergeNotifications, summarizeNotifications } from "./merge.js";

const card = "C-123" as never;
const assignment = "A-17" as never;

test("§6.7 one Assignment's pending notifications merge into one bell with a seq range", () => {
  const bell = mergeNotifications({
    card_id: card,
    assignment_id: assignment,
    // Deliberately out of order: the bell carries the min and max seq.
    notifications: [
      { seq: 25, kind: "comment", summary: "comment" },
      { seq: 18, kind: "review", summary: "V-1 rejected" },
      { seq: 17, kind: "delivery", summary: "D-1 submitted" },
      { seq: 19, kind: "review", summary: "V-2 passed" },
    ],
  });
  expect(bell).toBeDefined();
  expect(bell?.from_seq).toBe(17);
  expect(bell?.to_seq).toBe(25);
  expect(bell?.summary).toBe("1 delivery, 2 reviews, 1 comment");
  expect(bell?.text).toBe(
    [
      '[bell] card=C-123 asg=A-17 seq=17..25 summary="1 delivery, 2 reviews, 1 comment"',
      "→ 请调用 card.get_updates 读取详情",
    ].join("\n"),
  );
});

test("§6.7 a single notification still carries its own seq range", () => {
  const bell = mergeNotifications({
    card_id: card,
    assignment_id: assignment,
    notifications: [{ seq: 31, kind: "review", summary: "V-1 rejected" }],
  });
  expect(bell?.text.split("\n")[0]).toBe(
    '[bell] card=C-123 asg=A-17 seq=31..31 summary="1 review"',
  );
});

test("§6.7 nothing pending means no bell", () => {
  expect(
    mergeNotifications({
      card_id: card,
      assignment_id: assignment,
      notifications: [],
    }),
  ).toBeUndefined();
});

test("§6.7 the summary counts plural forms and keeps a fixed order", () => {
  expect(
    summarizeNotifications([
      { kind: "comment" },
      { kind: "comment" },
      { kind: "comment" },
      { kind: "comment" },
      { kind: "comment" },
      { kind: "delivery" },
      { kind: "review" },
      { kind: "review" },
    ]),
  ).toBe("1 delivery, 2 reviews, 5 comments");
  expect(summarizeNotifications([{ kind: "escalation" }])).toBe("1 escalation");
  // A kind with the same singular and plural reads correctly.
  expect(
    summarizeNotifications([
      { kind: "run_attention" },
      { kind: "run_attention" },
    ]),
  ).toBe("2 run attention");
});
