import { expect, test } from "vitest";
import { createCard, updateCard } from "./commands/pm.js";
import { card, fixture, human, ports } from "./commands/test-fixtures.js";
import { parseCardPriority } from "./priority.js";

const names = [
  "none",
  "low",
  "medium",
  "high",
  "urgent",
  "无",
  "低",
  "中",
  "高",
  "紧急",
];
test.each(names)("fixed priority %s preserves card state and audit", (name) => {
  const state = fixture();
  const card = state.cards[0];
  if (!card) throw new Error("fixture");
  const result = updateCard(
    state,
    human,
    { card_id: card.id, priority: name },
    ports(),
  );
  expect(result).toMatchObject({
    ok: true,
    value: { data: { priority: names.indexOf(name) % 5, status: card.status } },
  });
  const created = createCard(
    state,
    human,
    {
      title: card.title,
      goal: card.goal,
      source: card.source,
      repo: "example/repo",
      base_branch: "main",
      acceptance_criteria: card.acceptance_criteria,
      priority: name,
    },
    ports(),
  );
  expect(created).toMatchObject({
    ok: true,
    value: { data: { priority: names.indexOf(name) % 5 } },
  });
  expect(state.cards[0]).toBe(card);
});
test.each([-1, 5, 0.5, NaN, Infinity, "5", "unknown"])(
  "rejects non-tier priority %s without effects",
  (priority) => {
    const state = fixture();
    expect(
      updateCard(state, human, { card_id: card().id, priority }, ports()),
    ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
    expect(
      createCard(
        state,
        human,
        {
          title: card().title,
          goal: card().goal,
          source: card().source,
          repo: "example/repo",
          base_branch: "main",
          acceptance_criteria: card().acceptance_criteria,
          priority,
        },
        ports(),
      ),
    ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  },
);
test("priority parsing accepts names without inventing numeric-string ranks", () => {
  expect(parseCardPriority(" HIGH ")).toBe(3);
  expect(parseCardPriority(0)).toBe(0);
  expect(parseCardPriority(null)).toBeUndefined();
});
