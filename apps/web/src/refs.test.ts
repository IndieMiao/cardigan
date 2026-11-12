/**
 * M5.3 reference links (plan §3.4).
 *
 * The frontend turns the identifiers the server listed into links and nothing
 * else: an unknown id, or an id listed as text in a different form, stays text.
 */
import { expect, test } from "vitest";
import { linkifyReferences, referenceHref } from "./refs.js";

test("each reference kind has a destination", () => {
  expect(referenceHref({ kind: "card", id: "C-2" }, "p-1", "C-1")).toBe(
    "#/p/p-1/cards/C-2",
  );
  expect(referenceHref({ kind: "decision", id: "Q-2" }, "p-1", "C-1")).toBe(
    "#/p/p-1/cards/C-1?at=decision-Q-2",
  );
  expect(referenceHref({ kind: "delivery", id: "V-4" }, "p-1", "C-1")).toBe(
    "#/p/p-1/cards/C-1?at=delivery-V-4",
  );
  expect(referenceHref({ kind: "human_action", id: "H-3" }, "p-1", "C-1")).toBe(
    "#/p/p-1/cards/C-1?at=human-action-H-3",
  );
  expect(
    referenceHref({ kind: "timeline_entry", id: "C-1#7" }, "p-1", "C-1"),
  ).toBe("#/p/p-1/cards/C-1?at=entry-C-1%237");
  // A server-resolved card target wins over the currently open card.
  expect(
    referenceHref(
      { kind: "decision", id: "Q-2", card_id: "C-9" },
      "p-1",
      "C-1",
    ),
  ).toBe("#/p/p-1/cards/C-9?at=decision-Q-2");
  expect(
    referenceHref(
      { kind: "pr", url: "https://example.com/pr/1" },
      "p-1",
      "C-1",
    ),
  ).toBe("https://example.com/pr/1");
  expect(
    referenceHref({ kind: "pr", url: "javascript:alert(1)" }, "p-1", "C-1"),
  ).toBe(undefined);
  // Without a card target, a non-card reference must not invent a fragment.
  expect(referenceHref({ kind: "decision", id: "Q-2" }, "p-1")).toBe(undefined);
});

test("C-132: legacy q(n) / h(n) text in old comments links to the Q-n / H-n record", () => {
  const body = "旧评论见 q(95)、h(16) 和 Q-95；q(9) 不在列表里。";
  expect(
    linkifyReferences(
      body,
      [
        { kind: "decision", id: "Q-95" },
        { kind: "human_action", id: "H-16" },
      ],
      "p-1",
      "C-1",
    ),
  ).toBe(
    "旧评论见 [q(95) 拍板](#/p/p-1/cards/C-1?at=decision-Q-95)、[h(16) 待你执行](#/p/p-1/cards/C-1?at=human-action-H-16) 和 [Q-95 拍板](#/p/p-1/cards/C-1?at=decision-Q-95)；q(9) 不在列表里。",
  );
});

test("only listed identifiers become links", () => {
  const body = "见 C-1 和 D-3；C-9 还没建。";
  const linked = linkifyReferences(
    body,
    [
      { kind: "card", id: "C-1" },
      { kind: "decision", id: "D-3" },
    ],
    "p-1",
    "C-1",
  );
  expect(linked).toContain("[C-1 卡片](#/p/p-1/cards/C-1)");
  expect(linked).toContain("[D-3 拍板](#/p/p-1/cards/C-1?at=decision-D-3)");
  expect(linked).toContain("C-9 还没建");
});

test("an id inside a word or an existing link is left alone", () => {
  expect(
    linkifyReferences("ABC-1 不是编号", [{ kind: "card", id: "C-1" }], "p-1"),
  ).toBe("ABC-1 不是编号");
  const already = linkifyReferences(
    "[C-1](#/p/p-1/cards/C-1)",
    [{ kind: "card", id: "C-1" }],
    "p-1",
  );
  expect(already).toBe("[C-1](#/p/p-1/cards/C-1)");
  expect(already.match(/\[C-1\]/gu)).toHaveLength(1);
});

test("an empty reference list changes nothing", () => {
  expect(linkifyReferences("见 C-1", [], "p-1")).toBe("见 C-1");
});

test.each([false, true])(
  "mixed references are scanned once, preserving addresses, longest IDs and existing Markdown (reverse=%s)",
  (reverse) => {
    const refs = [
      { kind: "delivery" as const, id: "D-5" },
      { kind: "card" as const, id: "C-1" },
      { kind: "timeline_entry" as const, id: "C-1#98" },
    ];
    const body =
      "见 D-5、C-1#98 和 C-1。已有 [C-1](#/p/p-m5s/cards/C-1?at=decision-q(4))，代码 `C-1 D-5`。\n```\nC-1#98 D-5\n```";
    const result = linkifyReferences(
      body,
      reverse ? refs.reverse() : refs,
      "p-m5s",
      "C-1",
    );
    expect(result).toBe(
      "见 [D-5 交付](#/p/p-m5s/cards/C-1?at=delivery-D-5)、[C-1#98 时间线条目](#/p/p-m5s/cards/C-1?at=entry-C-1%2398) 和 [C-1 卡片](#/p/p-m5s/cards/C-1)。已有 [C-1](#/p/p-m5s/cards/C-1?at=decision-q(4))，代码 `C-1 D-5`。\n```\nC-1#98 D-5\n```",
    );
    expect(linkifyReferences(result, refs, "p-m5s", "C-1")).toBe(result);
  },
);
