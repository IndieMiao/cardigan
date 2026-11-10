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
