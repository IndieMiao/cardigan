import { expect, test } from "vitest";
import { agent, assignment, card, event, human, snapshot } from "./fixtures.js";
import { summarizeNotifications } from "./merge.js";
import { routeEvent } from "./route.js";

test.each([human(), agent("A-office"), agent("A-coder")])(
  "new cards reach Ops regardless of their creator ($kind)",
  (actor) => {
    const result = routeEvent({
      event: event("card_created", {}, { actor }),
      snapshot: snapshot({ cards: [card({ status: "todo" })] }),
    });
    expect(result.notifications).toMatchObject([
      {
        recipient: { kind: "pm_ops" },
        kind: "card",
        card_id: "C-1",
        seq: 1,
        rule: "6.4/card needs planning",
      },
    ]);
    expect(summarizeNotifications(result.notifications)).toBe("1 card");
  },
);

test.each(["todo", "backlog"])(
  "planning cards in %s remain visible to Ops",
  (status) => {
    expect(
      routeEvent({
        event: event("card_created"),
        snapshot: snapshot({ cards: [card({ status })], assignments: [] }),
      }).notifications,
    ).toHaveLength(1);
  },
);

test.each(["done", "cancelled"])(
  "closed cards (%s) do not create stale planning bells",
  (status) => {
    expect(
      routeEvent({
        event: event("card_created"),
        snapshot: snapshot({ cards: [card({ status })] }),
      }).notifications,
    ).toEqual([]);
  },
);

test.each(["active", "released"])(
  "only the active Ops creator suppresses its own bell (%s)",
  (status) => {
    const result = routeEvent({
      event: event("card_created", {}, { actor: agent("A-ops") }),
      snapshot: snapshot({
        assignments: [
          assignment("A-ops", {
            scope: "standing",
            role_id: "pm",
            standing_mode: "ops",
            status,
          }),
        ],
      }),
    });
    expect(result.notifications).toHaveLength(status === "active" ? 0 : 1);
  },
);

test("promoting an existing card to todo wakes Ops; editing its title does not", () => {
  for (const status of ["backlog", "todo"]) {
    const result = routeEvent({
      event: event("card_updated", { status: "todo" }, { seq: 3 }),
      snapshot: snapshot({
        events: [
          event("card_updated", { status }, { seq: 2 }),
          event("card_created"),
        ],
      }),
    });
    expect(result.notifications).toHaveLength(status === "backlog" ? 1 : 0);
  }
});
