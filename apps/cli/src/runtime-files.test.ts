import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  newInstanceId,
  parseSettingsFileOwner,
  removeStaleSettingsFiles,
  scanSettingsFiles,
} from "./runtime-files.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cardigan-runtime-files-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const name = (pid: number, rand: string, profile = "claude-of"): string =>
  `cardigan-${pid}-${rand}.${profile}.claude-settings.json`;

describe("newInstanceId", () => {
  test("combines pid and random suffix", () => {
    expect(newInstanceId(4242, "deadbeef")).toBe("4242-deadbeef");
  });

  test("rejects a badly shaped random suffix", () => {
    expect(() => newInstanceId(1, "NOTHEX!!")).toThrow(/8 lowercase hex/);
  });

  test("two calls differ", () => {
    expect(newInstanceId(1)).not.toBe(newInstanceId(1));
  });
});

describe("parseSettingsFileOwner", () => {
  test("reads the pid and instance id", () => {
    expect(parseSettingsFileOwner(name(4242, "deadbeef"))).toEqual({
      pid: 4242,
      instanceId: "4242-deadbeef",
    });
  });

  test("accepts profile names with dots", () => {
    expect(parseSettingsFileOwner(name(7, "0badc0de", "claude.of.v2"))).toEqual(
      { pid: 7, instanceId: "7-0badc0de" },
    );
  });

  test("ignores unrelated files", () => {
    for (const entry of [
      "claude-of.claude-settings.json",
      "cardigan-4242-deadbeef.claude-of.settings.json",
      "notes.txt",
      "cardigan-0-deadbeef.claude-of.claude-settings.json",
    ]) {
      expect(parseSettingsFileOwner(entry)).toBeUndefined();
    }
  });
});

describe("scanSettingsFiles", () => {
  test("splits live and stale files by owner pid", async () => {
    await writeFile(join(dir, name(100, "aaaaaaaa")), "{}");
    await writeFile(join(dir, name(200, "bbbbbbbb")), "{}");
    await writeFile(join(dir, "unrelated.txt"), "keep me");

    const scan = await scanSettingsFiles(dir, (pid) => pid === 100);
    expect(scan.live).toEqual([join(dir, name(100, "aaaaaaaa"))]);
    expect(scan.stale).toEqual([join(dir, name(200, "bbbbbbbb"))]);
  });

  test("returns nothing for a missing directory", async () => {
    const scan = await scanSettingsFiles(join(dir, "nope"), () => false);
    expect(scan).toEqual({ stale: [], live: [] });
  });
});

describe("removeStaleSettingsFiles", () => {
  test("deletes stale files and keeps live ones", async () => {
    await writeFile(join(dir, name(100, "aaaaaaaa")), "{}");
    await writeFile(join(dir, name(200, "bbbbbbbb")), "{}");
    await writeFile(join(dir, "unrelated.txt"), "keep me");

    const removed = await removeStaleSettingsFiles(dir, (pid) => pid === 100);
    expect(removed).toEqual([join(dir, name(200, "bbbbbbbb"))]);
    expect((await readdir(dir)).sort()).toEqual(
      [name(100, "aaaaaaaa"), "unrelated.txt"].sort(),
    );
  });

  test("defaults to a real liveness probe and keeps our own file", async () => {
    await writeFile(join(dir, name(process.pid, "cccccccc")), "{}");
    const removed = await removeStaleSettingsFiles(dir);
    expect(removed).toEqual([]);
    expect(await readdir(dir)).toEqual([name(process.pid, "cccccccc")]);
  });
});
