import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

let dataDir: string,
  io: CliIo,
  output: string[],
  errors: string[],
  store: Store;
beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-preference-cli-"));
  output = [];
  errors = [];
  io = {
    env: { CARDIGAN_DATA_DIR: dataDir },
    cwd: dataDir,
    platform: "linux",
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    signals: { on: () => {}, off: () => {} },
    spawnInherit: () => {
      throw new Error("No Agent needed");
    },
    captureCommand: async () => {
      throw new Error("No Git needed");
    },
  };
  expect(await main(["project", "create", "preferences"], io)).toBe(0);
  store = Store.open({ dataDir });
});
afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});
const run = (args: string[]) => {
  output = [];
  errors = [];
  return main(args, io);
};

test("preference get/set persists minutes and off, with project isolation", async () => {
  expect(await run(["preference", "get", "auto-merge-after"])).toBe(0);
  expect(output).toContain("auto-merge-after: off");
  expect(await run(["preference", "set", "auto-merge-after", "10"])).toBe(0);
  expect(
    await run([
      "preference",
      "get",
      "auto-merge-after",
      "--project",
      "preferences",
    ]),
  ).toBe(0);
  expect(output).toContain("auto-merge-after: 10");
  expect(await run(["project", "create", "other"])).toBe(0);
  expect(
    await run(["preference", "get", "auto-merge-after", "--project", "other"]),
  ).toBe(0);
  expect(output).toContain("auto-merge-after: off");
  expect(
    await run([
      "preference",
      "set",
      "auto-merge-after",
      "off",
      "--project",
      "preferences",
    ]),
  ).toBe(0);
  expect(
    store.uow.read((tx) =>
      tx.project_preferences.get("preferences", "preferences"),
    )?.auto_merge_after_minutes,
  ).toBeNull();
  expect(
    store.uow
      .read((tx) => tx.events.listAfter("preferences", undefined, 0))
      .filter((e) => e.type === "project_preferences_updated"),
  ).toHaveLength(2);
});
test.each(["0", "1441", "1.5", "-10", "NaN", "1e2", "on"])(
  "rejects invalid minutes %s",
  async (minutes) => {
    expect(
      await run(["preference", "set", "auto-merge-after", minutes]),
    ).not.toBe(0);
    expect(
      store.uow.read((tx) => tx.project_preferences.list("preferences")),
    ).toEqual([]);
  },
);

test("merge-confirm-stall-after defaults to 60, persists minutes with an audit event and rejects off", async () => {
  expect(await run(["preference", "get", "merge-confirm-stall-after"])).toBe(0);
  expect(output).toContain("merge-confirm-stall-after: 60");
  expect(
    await run(["preference", "set", "merge-confirm-stall-after", "90"]),
  ).toBe(0);
  expect(output).toContain("merge-confirm-stall-after: 90");
  expect(
    store.uow.read((tx) =>
      tx.project_preferences.get("preferences", "preferences"),
    ),
  ).toMatchObject({
    merge_confirm_stall_after_minutes: 90,
    auto_merge_after_minutes: null,
  });
  expect(
    store.uow
      .read((tx) => tx.events.listAfter("preferences", undefined, 0))
      .filter((e) => e.type === "project_preferences_updated")
      .map((e) => e.payload),
  ).toEqual([
    {
      old_value: 60,
      new_value: 90,
      preference: "merge_confirm_stall_after_minutes",
    },
  ]);
  for (const bad of ["off", "0", "1441", "1.5"])
    expect(
      await run(["preference", "set", "merge-confirm-stall-after", bad]),
    ).not.toBe(0);
});

test("delegation preferences persist separately from merge settings and reject fixed-risk categories", async () => {
  expect(await run(["preference", "get", "decision-delegation"])).toBe(0);
  expect(output.join("\n")).toContain("general: on (PM 代拍)");
  expect(await run(["preference", "set", "auto-merge-after", "10"])).toBe(0);
  expect(
    await run(["preference", "set", "decision-delegation", "general", "off"]),
  ).toBe(0);
  expect(await run(["preference", "get", "decision-delegation"])).toBe(0);
  expect(output.join("\n")).toContain("general: off (由人确认)");
  expect(await run(["preference", "get", "auto-merge-after"])).toBe(0);
  expect(output).toContain("auto-merge-after: 10");
  for (const category of ["spending", "account", "permission", "data_deletion"])
    expect(
      await run(["preference", "set", "decision-delegation", category, "on"]),
    ).not.toBe(0);
  expect(
    await run(["preference", "set", "decision-delegation", "unknown", "on"]),
  ).not.toBe(0);
});

test("PM merge confirmation defaults on and the human can switch it from the CLI", async () => {
  expect(await run(["preference", "get", "pm-merge-confirmation"])).toBe(0);
  expect(output).toEqual(["pm-merge-confirmation: on (PM 代确认合并)"]);
  expect(await run(["preference", "set", "pm-merge-confirmation", "off"])).toBe(
    0,
  );
  expect(output).toContain("pm-merge-confirmation: off (由人确认)");
  expect(await run(["preference", "get", "pm-merge-confirmation"])).toBe(0);
  expect(output).toEqual(["pm-merge-confirmation: off (由人确认)"]);
  expect(
    await run(["preference", "set", "pm-merge-confirmation", "maybe"]),
  ).not.toBe(0);
});

test("merge-confirm-snooze-default defaults to 240, persists minutes with an audit event and rejects off", async () => {
  expect(await run(["preference", "get", "merge-confirm-snooze-default"])).toBe(
    0,
  );
  expect(output).toContain("merge-confirm-snooze-default: 240");
  expect(
    await run(["preference", "set", "merge-confirm-snooze-default", "90"]),
  ).toBe(0);
  expect(output).toContain("merge-confirm-snooze-default: 90");
  expect(
    store.uow.read((tx) =>
      tx.project_preferences.get("preferences", "preferences"),
    ),
  ).toMatchObject({
    merge_confirm_snooze_default_minutes: 90,
    auto_merge_after_minutes: null,
  });
  expect(
    store.uow
      .read((tx) => tx.events.listAfter("preferences", undefined, 0))
      .filter((e) => e.type === "project_preferences_updated")
      .map((e) => e.payload),
  ).toEqual([
    {
      old_value: 240,
      new_value: 90,
      preference: "merge_confirm_snooze_default_minutes",
    },
  ]);
  for (const bad of ["off", "0", "1441", "1.5"])
    expect(
      await run(["preference", "set", "merge-confirm-snooze-default", bad]),
    ).not.toBe(0);
});
