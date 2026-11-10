import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { loadMergeGateConfig } from "@cardigan/host";
import { resolveDataDirectory } from "@cardigan/runtime-herdr";
import { afterEach, expect, test, vi } from "vitest";
import { resolveLaunchPaths } from "../../cli/src/paths.js";
import { configDir, loadLaunchFiles } from "./host.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("default gate and launch readers ignore HOME configuration and use the private worker directory", async () => {
  const home = mkdtempSync(join(tmpdir(), "sentinel-home-"));
  roots.push(home);
  for (const directory of [
    join(home, ".config"),
    join(home, ".config/cardigan"),
  ])
    mkdirSync(directory, { mode: 0o700 });
  const sentinelDir = join(home, ".config/cardigan"),
    file = join(sentinelDir, "merge-gate.yaml");
  const contents = JSON.stringify({
    projects: { cardigan: { checks: [{ name: "x", run: "true" }] } },
  });
  writeFileSync(file, contents, { mode: 0o600 });
  writeFileSync(
    join(sentinelDir, "launch.yaml"),
    "must not read this sentinel",
    { mode: 0o600 },
  );
  vi.stubEnv("HOME", home);

  const expected = join(tmpdir(), "config/cardigan");
  expect(configDir(process.env)).toBe(expected);
  expect(resolveLaunchPaths(process.env).configDir).toBe(expected);
  expect(relative(homedir(), expected).startsWith("..")).toBe(true);
  const gate = await loadMergeGateConfig({ projectIds: [] });
  expect(gate.errors).toEqual([]);
  expect(gate.forProject("cardigan")).toEqual({ status: "disabled" });
  await expect(loadLaunchFiles(expected)).rejects.toThrow(
    `找不到启动配置：${join(expected, "launch.yaml")}`,
  );
  // Positive control: the sentinel is valid and is observable only by explicit override.
  expect(
    (await loadMergeGateConfig({ projectIds: [], configDir: sentinelDir }))
      .errors,
  ).toEqual(["项目 cardigan 的合并闸门无效：项目未登记"]);
  expect(readFileSync(file, "utf8")).toBe(contents);
});

test("default config and data roots are empty, private and separate from user paths", () => {
  const xdg = join(tmpdir(), "config"),
    config = join(xdg, "cardigan"),
    data = join(tmpdir(), "data");
  expect(process.env.XDG_CONFIG_HOME).toBe(xdg);
  expect(process.env.CARDIGAN_CONFIG_DIR).toBe(config);
  expect(process.env.CARDIGAN_DATA_DIR).toBe(data);
  expect(resolveDataDirectory()).toBe(data);
  for (const path of [xdg, config, data]) {
    expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(path.startsWith(`${homedir()}/`)).toBe(false);
  }
  expect(readdirSync(config)).toEqual([]);
  expect(readdirSync(data)).toEqual([]);
  expect(
    resolveDataDirectory({ CARDIGAN_DATA_DIR: join(data, "explicit") }),
  ).toBe(join(data, "explicit"));
});
