import { expect, test } from "vitest";
import { projectPreferences, setProjectPreferences } from "../index.js";
import { actor, apply, fixture, human, ports, value } from "./test-fixtures.js";

test("board lane folding is a per-lane patch that keeps other preferences and emits no event", () => {
  const io = ports();
  let state = fixture();
  const set = (lanes: Record<string, boolean | null>) => {
    const effect = value(
      setProjectPreferences(state, human, { board_collapsed_lanes: lanes }, io),
    );
    expect(effect.events).toEqual([]);
    state = apply(state, effect);
    return projectPreferences(state);
  };
  state = apply(
    state,
    value(
      setProjectPreferences(state, human, { auto_merge_after_minutes: 5 }, io),
    ),
  );
  expect(set({ backlog: false, in_progress: true })).toMatchObject({
    auto_merge_after_minutes: 5,
    board_collapsed_lanes: { backlog: false, in_progress: true },
  });
  // A second device folding another lane keeps the first device's lanes.
  expect(set({ done: true }).board_collapsed_lanes).toEqual({
    backlog: false,
    in_progress: true,
    done: true,
  });
  // null forgets the human setting so the empty-lane default applies again.
  expect(set({ backlog: null }).board_collapsed_lanes).toEqual({
    in_progress: true,
    done: true,
  });
  // Repeating the same setting is a no-op without changes.
  const repeat = value(
    setProjectPreferences(
      state,
      human,
      { board_collapsed_lanes: { done: true } },
      io,
    ),
  );
  expect(repeat.changes).toEqual([]);
});

test("board lane folding rejects unknown lanes, non-boolean values and agents", () => {
  const io = ports();
  const state = fixture();
  for (const lanes of [{ archived: true }, { done: "yes" }, { done: 1 }])
    expect(
      setProjectPreferences(
        state,
        human,
        {
          board_collapsed_lanes: lanes as unknown as Record<string, boolean>,
        },
        io,
      ).ok,
    ).toBe(false);
  expect(
    setProjectPreferences(
      state,
      actor(),
      { board_collapsed_lanes: { done: true } },
      io,
    ).ok,
  ).toBe(false);
});
