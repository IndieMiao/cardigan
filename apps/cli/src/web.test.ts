/**
 * `cardigan web set-password` (M5 plan §0, §4 M5.1).
 *
 * The command reads the password twice through a non-echoing prompt, never from
 * argv, and stores only the scrypt hash. Changing it revokes every session.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

let dataDir: string;
let output: string[];
let errors: string[];
let answers: string[];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-cli-web-"));
  output = [];
  errors = [];
  answers = [];
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const io = (): CliIo => ({
  env: {},
  cwd: dataDir,
  platform: "linux",
  stdout: (line) => output.push(line),
  stderr: (line) => errors.push(line),
  signals: { on: () => undefined, off: () => undefined },
  spawnInherit: () => {
    throw new Error("cardigan web must not spawn");
  },
  captureCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
  promptSecret: async () => {
    const next = answers.shift();
    if (next === undefined) throw new Error("no answer queued");
    return next;
  },
});

async function cardigan(...argv: string[]) {
  output = [];
  errors = [];
  const code = await main([...argv, "--data-dir", dataDir], io());
  return { code, out: output.join("\n"), err: errors.join("\n") };
}

test("the password is typed twice and only its hash is stored", async () => {
  answers = ["correct horse battery", "correct horse battery"];
  const result = await cardigan("web", "set-password");
  expect(result.code).toBe(0);
  expect(result.out).toContain("已设置 Workbench 密码");
  expect(result.out).not.toContain("correct horse battery");
  expect(result.err).not.toContain("correct horse battery");

  const store = Store.open({ dataDir });
  try {
    expect(store.webPasswordConfigured()).toBe(true);
    expect(store.verifyWebLogin("correct horse battery")).toBe(true);
    expect(store.verifyWebLogin("something else entirely")).toBe(false);
    const row = store.database
      .prepare("SELECT password_hash FROM web_credential")
      .get() as { password_hash: string };
    expect(row.password_hash.startsWith("scrypt$")).toBe(true);
    expect(row.password_hash).not.toContain("correct horse battery");
  } finally {
    store.close();
  }
});

test("a mismatched confirmation changes nothing", async () => {
  answers = ["correct horse battery", "correct horse batterY"];
  const result = await cardigan("web", "set-password");
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("两次输入不一致");

  const store = Store.open({ dataDir });
  try {
    expect(store.webPasswordConfigured()).toBe(false);
  } finally {
    store.close();
  }
});

test("a password shorter than 12 characters is refused", async () => {
  answers = ["elevenchars", "elevenchars"];
  const result = await cardigan("web", "set-password");
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("至少 12 位");
});

test("the password cannot be passed as an argument", async () => {
  const result = await cardigan("web", "set-password", "--password", "secret");
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("不认识的参数");
  expect(answers).toEqual([]);
});
