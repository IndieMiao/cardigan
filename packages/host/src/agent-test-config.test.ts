import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loadAgentTestWorkers } from "./agent-test-config.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cg-agent-tests-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const write = (text: string) =>
  writeFile(join(dir, "agent-tests.yaml"), text, { mode: 0o600 });

test("missing host policy defaults to two; an explicit policy overrides it", async () => {
  expect(await loadAgentTestWorkers(dir)).toBe(2);
  await write("{}\n");
  expect(await loadAgentTestWorkers(dir)).toBe(2);
  await write("max_workers: 1\n");
  expect(await loadAgentTestWorkers(dir)).toBe(1);
});

test.each([
  "max_workers: 0",
  "max_workers: -1",
  "max_workers: 1.5",
  "max_workers: null",
  "max_workers: '2'",
  "[]",
  "secret: private-config-value",
  "max_workers: 2\nmax_workers: 9",
  "max_workers: &a [*a]",
])(
  "invalid policy refuses launch without quoting its contents: %s",
  async (source) => {
    await write(source);
    await expect(loadAgentTestWorkers(dir)).rejects.toThrow("配置无效");
    await expect(loadAgentTestWorkers(dir)).rejects.not.toThrow(source);
  },
);

test.each(["file", "parent", "symlink"])(
  "unsafe %s refuses launch",
  async (kind) => {
    if (kind === "symlink") {
      await writeFile(join(dir, "source"), "max_workers: 9\n");
      await symlink(join(dir, "source"), join(dir, "agent-tests.yaml"));
    } else {
      await write("max_workers: 9\n");
      await chmod(kind === "file" ? join(dir, "agent-tests.yaml") : dir, 0o777);
    }
    await expect(loadAgentTestWorkers(dir)).rejects.toThrow("无法安全读取");
  },
);
