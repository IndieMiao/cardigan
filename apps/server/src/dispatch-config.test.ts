import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRunCapacityConfig } from "@cardigan/host";
import { afterEach, beforeEach, expect, test } from "vitest";

let configDir: string;
beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "run-capacity-"));
});
afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});
const write = (text: string) =>
  writeFile(join(configDir, "run-capacity.yaml"), text, { mode: 0o600 });

test("missing file/machine defaults to four; CARDIGAN_CONFIG_DIR is read once per load", async () => {
  expect((await loadRunCapacityConfig({ configDir })).forMachine("local")).toBe(
    4,
  );
  await write("machines:\n  local: 2\n  worker: 6\n");
  const config = await loadRunCapacityConfig({
    env: { CARDIGAN_CONFIG_DIR: configDir },
  });
  expect(config.errors).toEqual([]);
  expect(config.forMachine("local")).toBe(2);
  expect(config.forMachine("worker")).toBe(6);
  expect(config.forMachine("omitted")).toBe(4);
  await write("machines: { local: 5 }\n");
  expect(config.forMachine("local")).toBe(2);
  expect((await loadRunCapacityConfig({ configDir })).forMachine("local")).toBe(
    5,
  );
});

test.each([
  "machines: { local: 0 }",
  "machines: { local: -1 }",
  "machines: { local: 1.5 }",
  "machines: { local: '4' }",
  "machines: { local: 2, local: 3 }",
  "machines: []",
  "machines: &limits { local: 2 }\nextra: *limits",
  "machines: { local: 2 }\nsecret: private-value",
])(
  "invalid configuration fails closed without echoing input: %s",
  async (source) => {
    await write(source);
    const config = await loadRunCapacityConfig({ configDir });
    expect(config.forMachine("local")).toBe(0);
    expect(config.forMachine("omitted")).toBe(0);
    expect(config.errors).toHaveLength(1);
    expect(config.errors.join()).not.toContain("private-value");
  },
);

test.each(["writable", "symlink", "directory", "parent"])(
  "refuses unsafe %s configuration",
  async (kind) => {
    const file = join(configDir, "run-capacity.yaml");
    if (kind === "directory") await mkdir(file);
    else if (kind === "symlink") {
      await writeFile(join(configDir, "source"), "machines: {}\n");
      await symlink(join(configDir, "source"), file);
    } else {
      await write("machines: {}\n");
      await chmod(
        kind === "parent" ? configDir : file,
        kind === "parent" ? 0o770 : 0o666,
      );
    }
    expect((await loadRunCapacityConfig({ configDir })).errors).toHaveLength(1);
  },
);
