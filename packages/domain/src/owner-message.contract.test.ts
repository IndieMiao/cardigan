import { expect, test } from "vitest";
import {
  actor,
  fixture,
  human,
  ports,
  value,
} from "./commands/test-fixtures.js";
import {
  ownerTextError,
  setProjectPreferences,
  standingTools,
} from "./index.js";

test("only the human may opt the project into PM private messages; the change is audited", () => {
  const s = fixture(),
    input = { pm_owner_messages: true };
  expect(setProjectPreferences(s, actor(1, "pm"), input, ports()).ok).toBe(
    false,
  );
  const effect = value(setProjectPreferences(s, human, input, ports()));
  expect(effect.data.pm_owner_messages).toBe(true);
  expect(effect.events).toContainEqual(
    expect.objectContaining({
      actor: human,
      type: "project_preferences_updated",
      payload: {
        preference: "pm_owner_messages",
        old_value: null,
        new_value: true,
      },
    }),
  );
  expect(standingTools(["send_owner_message"], "ops")).toEqual([]);
});
test("counts Unicode code points and accepts multiline HTTP links but not mentions or non-text", () => {
  expect(ownerTextError("🎈".repeat(4000))).toBeUndefined();
  expect(ownerTextError("🎈".repeat(4001))).toBeDefined();
  expect(
    ownerTextError("更新\nhttps://example.invalid/a\nhttp://example.invalid/b"),
  ).toBeUndefined();
  for (const text of [
    " ",
    "@所有人",
    "<at user_id=all>All</at>",
    "abc\u0000",
    "file:///release",
  ])
    expect(ownerTextError(text)).toBeDefined();
});
