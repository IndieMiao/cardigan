import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MaintenanceDriver,
  maintenanceActive,
  parseMaintenanceConfig,
} from "@cardigan/host";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { main } from "./index.js";
import type { CliIo } from "./io.js";
import { runHcCommand, runMaintenanceCommand } from "./maintenance.js";

const io = (env: Record<string, string> = {}): CliIo & { out: string[] } => {
  const out: string[] = [];
  return {
    out,
    env,
    cwd: "/tmp",
    platform: "linux",
    stdout: (line) => out.push(line),
    stderr: (line) => out.push(line),
    signals: { on: vi.fn(), off: vi.fn() },
    spawnInherit: vi.fn(),
    captureCommand: vi.fn(),
  };
};

const config = parseMaintenanceConfig({
  server: { stop: ["/fake/stop"], start: ["/fake/start"] },
});

function driver(): MaintenanceDriver {
  let up = true;
  return {
    now: () => new Date().toISOString(),
    sleep: async () => {},
    run: async (argv) => {
      if (argv[0] === "/fake/stop") up = false;
      if (argv[0] === "/fake/start") up = true;
      return { code: 0, stdout: "", stderr: "" };
    },
    activity: () => ({ busy: [], standing: [] }),
    software: async () => ({ sha: null, process: null, ready: up }),
    portOpen: async () => up,
    deployPin: () => null,
    audit: () => {},
    say: () => {},
  };
}

test("Token and token-file callers are refused before any store or service is touched", async () => {
  const open = vi.spyOn(Store, "open");
  try {
    for (const args of [
      ["maintenance", "begin", "--reason", "x"],
      ["maintenance", "status"],
      ["maintenance", "end"],
      ["hc", "upgrade", "--version", "0.1.21"],
    ]) {
      const tokenIo = io({ CARDIGAN_TOKEN: "agent-token" });
      expect(await main(args, tokenIo)).toBe(2);
      expect(tokenIo.out.join("\n")).toContain("仅限人类操作");
    }
    // The command modules refuse on their own as well.
    await expect(
      runMaintenanceCommand(["status"], { ...io(), tokenFile: "/x" }),
    ).rejects.toThrow("Token/Agent 不可调用");
    await expect(
      runHcCommand(
        ["upgrade", "--version", "0.1.21"],
        io({ CARDIGAN_TOKEN: "" }),
      ),
    ).rejects.toThrow("Token/Agent 不可调用");
    expect(open).not.toHaveBeenCalled();
  } finally {
    open.mockRestore();
  }
});

test("usage errors are rejected before a window opens", async () => {
  for (const args of [
    ["begin"],
    ["begin", "--reason", "x", "--wait"],
    ["run", "--reason", "x"],
    ["run", "--reason", "x", "--", "relative/cmd"],
    ["begin", "--reason", "x", "--timeout-minutes", "0"],
    ["end", "--proceed"],
    ["nope"],
  ])
    await expect(runMaintenanceCommand(args, io())).rejects.toThrow();
  await expect(runHcCommand(["upgrade"], io())).rejects.toThrow("用法");
  await expect(runHcCommand(["install"], io())).rejects.toThrow("用法");
});

test("a human opens, inspects and ends a manual window", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-maintenance-cli-"));
  Store.open({ dataDir }).close();
  const hooks = { config, driver: () => driver() };
  const human = io({ CARDIGAN_DATA_DIR: dataDir });
  expect(
    await runMaintenanceCommand(
      ["begin", "--reason", "迁移数据", "--timeout-minutes", "5"],
      human,
      hooks,
    ),
  ).toBe(0);
  expect(await runMaintenanceCommand(["status"], human, hooks)).toBe(0);
  expect(human.out.at(-1)).toContain("stopped");
  const store = Store.open({ dataDir, migrate: false });
  try {
    expect(maintenanceActive(store)).toBe(true);
  } finally {
    store.close();
  }
  expect(await runMaintenanceCommand(["end"], human, hooks)).toBe(0);
  const after = Store.open({ dataDir, migrate: false });
  try {
    expect(maintenanceActive(after)).toBe(false);
  } finally {
    after.close();
  }
  await runMaintenanceCommand(["status"], human, hooks);
  expect(human.out.at(-1)).toContain("completed");
});
