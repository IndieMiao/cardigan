import { expect, test } from "vitest";
import {
  type Actor,
  type CommandState,
  setMergeSolo,
  setMergeWindow,
} from "../index.js";
import { actor, apply, fixture, human, ports, value } from "./test-fixtures.js";

function state() {
  const s = fixture();
  return {
    ...s,
    assignments: s.assignments.map((a) =>
      a.scope === "standing" ? { ...a, standing_mode: "ops" as const } : a,
    ),
  };
}
const ops = actor(4, "pm");
const commands = [
  {
    name: "solo",
    call: (s: CommandState, a: Actor, reason = "ordering") =>
      setMergeSolo(
        s,
        a,
        { card_id: s.cards[0]!.id, solo: true, reason },
        ports(),
      ),
  },
  {
    name: "window",
    call: (s: CommandState, a: Actor, reason = "ordering") =>
      setMergeWindow(
        s,
        a,
        { card_id: s.cards[0]!.id, open: true, reason },
        ports(),
      ),
  },
];
test.each(commands)(
  "$name only accepts human or active standing PM Ops with a reason",
  ({ call }) => {
    const s = state();
    for (const a of [human, ops]) expect(call(s, a).ok).toBe(true);
    for (const a of [
      actor(),
      actor(2, "reviewer"),
      actor(3, "pm"),
      { kind: "system" as const, project_id: s.project_id },
      { ...ops, project_id: "other" },
    ])
      expect(call(s, a).ok).toBe(false);
    for (const standing_mode of ["office", undefined] as const)
      expect(
        call(
          {
            ...s,
            assignments: s.assignments.map((a) =>
              a.scope === "standing"
                ? (({ standing_mode: _mode, ...rest }) => ({
                    ...rest,
                    ...(standing_mode ? { standing_mode } : {}),
                  }))(a)
                : a,
            ),
          },
          ops,
        ).ok,
      ).toBe(false);
    for (const status of ["suspended", "released"] as const)
      expect(
        call(
          {
            ...s,
            assignments: s.assignments.map((a) =>
              a.scope === "standing" ? { ...a, status } : a,
            ),
          },
          ops,
        ).ok,
      ).toBe(false);
    for (const reason of ["", "   "])
      for (const a of [human, ops]) expect(call(s, a, reason).ok).toBe(false);
    for (const status of ["done", "cancelled"] as const)
      for (const a of [human, ops])
        expect(
          call({ ...s, cards: s.cards.map((c) => ({ ...c, status })) }, a).ok,
        ).toBe(false);
  },
);

test("PM Ops cannot close a sensitive window; human can, with atomic effects", () => {
  const initial = state();
  const s = {
    ...initial,
    cards: initial.cards.map((c) => ({ ...c, sensitive: true })),
  };
  const p = {
    card_id: s.cards[0]!.id,
    open: true,
    reason: "sensitive ordering",
  };
  const opened = apply(s, value(setMergeWindow(s, ops, p, ports())));
  expect(
    setMergeWindow(opened, ops, { ...p, open: false }, ports()),
  ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  const closed = value(
    setMergeWindow(opened, human, { ...p, open: false }, ports()),
  );
  expect(closed.events).toHaveLength(1);
  expect(closed.events[0]?.payload).toMatchObject({ open: false });
  expect(opened.events.at(-1)?.payload).toMatchObject({ open: true });
});
