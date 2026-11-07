import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrRuntime } from "@cardigan/runtime-herdr";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type CliIo, main, resolveDataDir } from "./index.js";

let root: string, io: CliIo, out: string[], err: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cg-data-default-"));
  mkdirSync(join(root, "repo"));
  out = [];
  err = [];
  io = {
    env: { HOME: join(root, "home") },
    cwd: join(root, "repo"),
    platform: "linux",
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    signals: { on() {}, off() {} },
    spawnInherit() {
      throw new Error("No process expected");
    },
    captureCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    promptSecret: async () => "fixture password long enough",
  };
  vi.spyOn(HerdrRuntime, "create").mockResolvedValue({
    ok: false,
    error: { code: "runtime_unavailable", message: "fixture unavailable" },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
test("S10 default data lives in the user's home, independent of the working directory", async () => {
  const expected = join(root, "home", ".local", "share", "cardigan");
  // Fail before any IO on the old default; never create a real workspace .data.
  expect(resolveDataDir(io)).toBe(expected);
  expect(resolveDataDir({ ...io, cwd: root })).toBe(expected);
  expect(await main(["init"], io)).toBe(0);
  expect(await main(["web", "set-password"], io)).toBe(0);
  expect(existsSync(join(expected, "cardigan.db"))).toBe(true);
  expect(existsSync(join(io.cwd, ".data"))).toBe(false);
  const store = Store.open({ dataDir: expected });
  try {
    expect(store.verifyWebLogin("fixture password long enough")).toBe(true);
  } finally {
    store.close();
  }
  expect(err).toContain(`数据目录：${expected}`);
});
test("S10 explicit flags beat environment paths and relative paths resolve against CLI cwd", () => {
  const configured = {
    ...io,
    env: { ...io.env, CARDIGAN_DATA_DIR: "env-data" },
  };
  expect(resolveDataDir(configured)).toBe(join(io.cwd, "env-data"));
  expect(resolveDataDir(configured, "flag-data")).toBe(
    join(io.cwd, "flag-data"),
  );
});
test.each([
  ["init"],
  ["project", "create", "p-new"],
  ["role", "add", "p", "coder"],
  ["needs-you"],
  ["inbox"],
  ["attention"],
  ["merge", "status"],
  ["worktree", "keep", "A-999"],
  ["assignment", "attach", "A-999"],
  ["web", "set-password"],
])(
  "S10 %j reports the absolute data directory before data access",
  async (...args) => {
    const dataDir = join(root, "data"),
      store = Store.open({ dataDir });
    store.createProject({ id: "p", name: "Fixture" });
    store.close();
    const code = await main([...args, "--data-dir", dataDir], io);
    expect(err[0]).toBe(`数据目录：${dataDir}`);
    if (!["worktree", "assignment"].includes(args[0] ?? ""))
      expect(code).toBe(0);
  },
);
