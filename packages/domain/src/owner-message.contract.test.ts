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

test("release-note fields are plain text; only HTTP(S) links are allowed", () => {
  const notes = [
    "Version:0.4.3",
    "Download",
    "File: app-release.apk",
    "Data:\t18 MB",
    "Size:18MB",
    `SHA-256:${"3f2a9c0d".repeat(8)}`,
    "iPhone:暂不支持",
    "app:download",
    "Hotel:none",
    "About:this build",
    "Market:Google Play",
    "Download:https://example.invalid/app-release.apk",
    "HTTPS://example.invalid:8443/releases/file:app.apk?next=tel:+1",
  ].join("\n");
  expect(ownerTextError(notes)).toBeUndefined();
  for (const link of [
    "tel:+15550100000",
    "1tel:+15550100000",
    "sms:+15550100000",
    "MAILTO:owner%40example.invalid",
    "FTP://example.invalid/a",
    "1https://example.invalid/a",
    "lark://open",
    "data:text/plain,hello",
    "javascript:(0)",
    "_javascript:alert(1)",
    "https://example.invalid/(javascript:alert(1))",
  ]) {
    expect(ownerTextError(`${notes}\n备用：${link}`)).toBe(
      "正文链接仅支持 http 或 https",
    );
  }
});
