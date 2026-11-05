/**
 * M5.3 reference links (plan §3.4).
 *
 * The frontend turns the identifiers the server listed into links and nothing
 * else: an unknown id, or an id listed as text in a different form, stays text.
 */
import { expect, test } from "vitest";
import { linkifyReferences, referenceHref } from "./refs.js";

test("each reference kind has a destination", () => {
  expect(referenceHref({ kind: "card", id: "C-2" }, "p-1")).toBe(
    "#/p/p-1/cards/C-2",
  );
  expect(referenceHref({ kind: "decision", id: "D-3" }, "p-1")).toBe(
    "#decision-D-3",
  );
  expect(referenceHref({ kind: "delivery", id: "V-4" }, "p-1")).toBe(
    "#delivery-V-4",
  );
  expect(referenceHref({ kind: "human_action", id: "H-5" }, "p-1")).toBe(
    "#human-action-H-5",
  );
  expect(referenceHref({ kind: "timeline_entry", id: "C-1#7" }, "p-1")).toBe(
    "#entry-C-1#7",
  );
  expect(
    referenceHref({ kind: "pr", url: "https://example.com/pr/1" }, "p-1"),
  ).toBe("https://example.com/pr/1");
  expect(referenceHref({ kind: "pr", url: "javascript:alert(1)" }, "p-1")).toBe(
    undefined,
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
  );
  expect(linked).toContain("[C-1](#/p/p-1/cards/C-1)");
  expect(linked).toContain("[D-3](#decision-D-3)");
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
