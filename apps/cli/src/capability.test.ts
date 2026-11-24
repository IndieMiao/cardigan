import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USAGE_NOTE_MAX_LENGTH } from "@cardigan/domain";
import { listCapabilityGuides, Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runCapabilityCommand } from "./capability.js";
import { CLI_TOOLS } from "./command-access.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

let dataDir: string, io: CliIo, output: string[], errors: string[];
beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-capability-cli-"));
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
  output = [];
  errors = [];
  expect(await main(["project", "create", "guides", "--code", "GDE"], io)).toBe(
    0,
  );
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));
const run = (args: string[], input = io) => {
  output = [];
  errors = [];
  return main(args, input);
};
const last = () => JSON.parse(output.at(-1) ?? "null");
const stored = () => {
  const store = Store.open({ dataDir });
  try {
    return listCapabilityGuides(store, "guides");
  } finally {
    store.close();
  }
};

test("human sets, merges, lists and deletes all three kinds of entry", async () => {
  writeFileSync(
    join(dataDir, "accounts.md"),
    "测试账号：受管文件 `/srv/sensen/journey-test-accounts.yaml`\n",
  );
  expect(
    await run([
      "capability",
      "guide",
      "set",
      "android.emulator",
      "--note",
      "用 `emulator -list-avds` 查看",
    ]),
  ).toBe(0);
  expect(last()).toMatchObject({
    scope: "capability",
    key: "android.emulator",
    machine_id: null,
    updated_by: "human",
  });
  expect(
    await run([
      "capability",
      "guide",
      "set",
      "android.emulator",
      "--machine",
      "mac-mini",
      "--note=ANDROID_AVD_HOME=~/.android/avd",
    ]),
  ).toBe(0);
  expect(
    await run([
      "capability",
      "guide",
      "set",
      "--topic",
      "test-accounts",
      "--note-file",
      "accounts.md",
    ]),
  ).toBe(0);
  expect(
    await run([
      "capability",
      "guide",
      "get",
      "android.emulator",
      "godot",
      "--machine",
      "mac-mini",
    ]),
  ).toBe(0);
  expect(last()).toEqual({
    machine_id: "mac-mini",
    capabilities: [
      {
        key: "android.emulator",
        usage_note: "用 `emulator -list-avds` 查看",
        machine_note: "ANDROID_AVD_HOME=~/.android/avd",
      },
      { key: "godot", usage_note: null, machine_note: null },
    ],
    project_notes: [
      {
        key: "test-accounts",
        usage_note:
          "测试账号：受管文件 `/srv/sensen/journey-test-accounts.yaml`",
      },
    ],
  });
  expect(await run(["capability", "guide", "list"])).toBe(0);
  expect(last()).toHaveLength(3);
  expect(
    await run([
      "capability",
      "guide",
      "delete",
      "android.emulator",
      "--machine",
      "mac-mini",
    ]),
  ).toBe(0);
  expect(
    await run([
      "capability",
      "guide",
      "delete",
      "android.emulator",
      "--machine",
      "mac-mini",
    ]),
  ).toBe(1);
  expect(stored().map((e) => [e.scope, e.key])).toEqual([
    ["capability", "android.emulator"],
    ["project", "test-accounts"],
  ]);
});

test("credential-like notes, oversized notes and malformed targets are refused", async () => {
  for (const args of [
    [
      "set",
      "godot",
      "--note",
      "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    ],
    ["set", "godot", "--note", "x".repeat(USAGE_NOTE_MAX_LENGTH + 1)],
    ["set", "Godot", "--note", "ok"],
    ["set", "godot"],
    ["set", "godot", "--note", "a", "--note-file", "b"],
    ["set", "--topic", "t", "godot", "--note", "a"],
    ["set", "--topic", "t", "--machine", "m", "--note", "a"],
    ["set", "godot", "--role", "coder", "--note", "a"],
    ["remove", "godot"],
  ]) {
    expect(await run(["capability", "guide", ...args])).toBe(2);
  }
  expect(
    await run([
      "capability",
      "guide",
      "set",
      "godot",
      "--note",
      "password: hunter22",
    ]),
  ).toBe(2);
  expect(errors.join("\n")).toContain("看起来包含凭据");
  expect(errors.join("\n")).not.toContain("hunter22");
  expect(stored()).toEqual([]);
});

test("Token identities are refused before any store access", async () => {
  expect(CLI_TOOLS["capability guide"]).toBeNull();
  for (const env of [
    { CARDIGAN_TOKEN: "SYNTHETIC_PRIVATE" },
    { MCP_TOKEN: "SYNTHETIC_PRIVATE" },
  ]) {
    const tokenIo = { ...io, env: { ...io.env, ...env } };
    for (const action of [
      ["set", "godot", "--note", "ok"],
      ["get"],
      ["list"],
      ["delete", "godot"],
    ]) {
      await expect(
        runCapabilityCommand(["guide", ...action], tokenIo),
      ).rejects.toThrow("仅限人类");
    }
  }
  expect(
    await run(["capability", "guide", "set", "godot", "--note", "ok"], {
      ...io,
      env: { ...io.env, CARDIGAN_TOKEN: "SYNTHETIC_PRIVATE" },
    }),
  ).toBe(2);
  expect(errors.join("\n")).toContain("仅限人类");
  expect(stored()).toEqual([]);
});
