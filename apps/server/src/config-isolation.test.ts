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
import { Store } from "@cardigan/store";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { loadConfig, loadOptionalConfigSync } from "../../cli/src/config.js";
import { resolveLaunchPaths } from "../../cli/src/paths.js";
import { configDir, loadLaunchFiles } from "./host.js";

const roots: string[] = [];
// C-155: these cases check the isolation installed by test-support/setup.ts.
// Without it they would read the caller's real config paths; say so clearly.
beforeAll(() => {
  expect(
    process.env.CARDIGAN_CONFIG_DIR,
    "test-support/setup.ts was not loaded; run vitest with the repository or apps/server vitest.config.ts",
  ).toBeDefined();
});
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

test("server load keeps legacy Codex config compatible and emits fixed advisories", async () => {
  const root = mkdtempSync(join(tmpdir(), "launch-advisory-"));
  roots.push(root);
  writeFileSync(
    join(root, "launch.yaml"),
    JSON.stringify({
      profiles: {
        fixture: {
          harness: "codex",
          config: { approval_policy: "synthetic-secret" },
        },
      },
    }),
  );
  const warnings: string[] = [];
  const loaded = await loadLaunchFiles(root, (line) => warnings.push(line));
  expect(loaded.config.profiles.fixture?.config?.approval_policy).toBe(
    "synthetic-secret",
  );
  expect(warnings).toHaveLength(3);
  expect(warnings.join("\n")).not.toContain("synthetic-secret");
});

test("server and both CLI readers resolve the same YAML alias using only the host data cache", async () => {
  const root = mkdtempSync(join(tmpdir(), "launch-models-"));
  roots.push(root);
  const dataDir = join(root, "data");
  writeFileSync(
    join(root, "launch.yaml"),
    `providers:
  fixture: {harness: pi}
models:
  current: {id: fixture-v1, provider: fixture}
profiles:
  employee: {harness: pi, model: current}
`,
  );
  const fetch = vi.fn(async () =>
    Response.json({
      fixture: { models: { "fixture-v1": { limit: { context: 12000 } } } },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const store = Store.open({ dataDir });
  try {
    const server = await loadLaunchFiles(root, undefined, dataDir, store);
    expect(server.config.profiles.employee?.model).toBe("fixture-v1");
    const paths = resolveLaunchPaths({
      CARDIGAN_CONFIG_DIR: root,
      CARDIGAN_DATA_DIR: dataDir,
    });
    expect(await loadConfig(paths)).toEqual(server.config);
    expect(loadOptionalConfigSync(paths)).toEqual(server.config);
    expect(fetch).toHaveBeenCalledOnce();
    expect(readdirSync(dataDir)).toContain("models-dev.json");
  } finally {
    store.close();
    vi.unstubAllGlobals();
  }
});
