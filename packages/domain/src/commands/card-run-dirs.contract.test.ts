import { expect, test } from "vitest";
import { updateCard } from "./pm.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  now,
  ports,
  value,
} from "./test-fixtures.js";

const card_id = id("card", 1);

test("C-743: standing PM names a done card's run directories for keeping and releases it", () => {
  const io = ports();
  const base = fixture();
  const state = {
    ...base,
    cards: base.cards.map((c) =>
      c.id === card_id ? { ...c, status: "done" as const } : c,
    ),
  };
  const effect = value(
    updateCard(
      state,
      actor(4, "pm"),
      { card_id, keep_run_dirs: { reason: " 排查 C-9 用 " } },
      io,
    ),
  );
  const kept = apply(state, effect);
  const card = kept.cards.find((c) => c.id === card_id);
  expect(card?.keep_run_dirs).toEqual({
    reason: "排查 C-9 用",
    set_by: "assignment:A-4",
    set_at: now,
  });
  expect(card?.status).toBe("done");
  expect(effect.events.map((e) => e.type)).toEqual(["card_run_dirs_keep_set"]);
  for (const key of ["work_items", "runs", "assignments"] as const)
    expect(kept[key]).toEqual(state[key]);
  // Same reason again is a no-op.
  expect(
    value(
      updateCard(
        kept,
        human,
        { card_id, keep_run_dirs: { reason: "排查 C-9 用" } },
        io,
      ),
    ).events,
  ).toEqual([]);
  const released = value(
    updateCard(kept, human, { card_id, keep_run_dirs: null }, io),
  );
  expect(released.data.keep_run_dirs).toBeUndefined();
  expect(released.events[0]).toMatchObject({
    type: "card_run_dirs_keep_released",
    payload: {
      previous_keep_run_dirs: card?.keep_run_dirs,
      keep_run_dirs: null,
    },
  });
});

test("C-743: only a PM may keep run directories, alone and with a reason", () => {
  const io = ports();
  const state = fixture();
  const coder = updateCard(
    state,
    actor(1, "coder"),
    { card_id, keep_run_dirs: { reason: "x" } },
    io,
  );
  expect(coder.ok).toBe(false);
  const mixed = updateCard(
    state,
    human,
    { card_id, title: "t", keep_run_dirs: { reason: "x" } },
    io,
  );
  expect(!mixed.ok && mixed.error.code).toBe("validation_failed");
  const blank = updateCard(
    state,
    human,
    { card_id, keep_run_dirs: { reason: "  " } },
    io,
  );
  expect(blank.ok).toBe(false);
});
