import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXT_MESSAGE_DEFAULTS, toolNames } from "@cardigan/domain";
import { ExtMessageSender } from "@cardigan/host";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CLI_TOOLS, requireCliTool } from "./command-access.js";
import { runExtMessageCommand } from "./ext-message.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

let dir: string;
let io: CliIo;
let lines: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ext-cli-"));
  lines = [];
  io = {
    cwd: dir,
    platform: "linux",
    env: { CARDIGAN_DATA_DIR: dir, CARDIGAN_CONFIG_DIR: dir },
    signals: { on() {}, off() {} },
    stdout: (t) => lines.push(t),
    stderr: (t) => lines.push(t),
    spawnInherit: () => {
      throw new Error("unexpected spawn");
    },
    captureCommand: async () => {
      throw new Error("unexpected capture");
    },
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
test.each(["status", "test"])(
  "%s rejects all Agent tools before opening config or database",
  async (command) => {
    expect(
      CLI_TOOLS[`ext-message ${command}` as "ext-message status"],
    ).toBeNull();
    expect(() =>
      requireCliTool(
        {
          kind: "assignment",
          project_id: "fictional",
          assignment_id: "A-1" as never,
          role_id: "pm",
          role_version: 1,
          allowed_tools: toolNames,
          capabilities: [],
        },
        `ext-message ${command}`,
      ),
    ).toThrow("仅限人类");
    const tokenIo = {
      ...io,
      env: { ...io.env, CARDIGAN_TOKEN: "SYNTHETIC_TOKEN" },
    };
    expect(await main(["ext-message", command], tokenIo)).not.toBe(0);
    await expect(runExtMessageCommand([command], tokenIo)).rejects.toThrow(
      "仅限人类",
    );
    await expect(
      runExtMessageCommand([command], {
        ...io,
        tokenFile: join(dir, "missing"),
      }),
    ).rejects.toThrow("仅限人类");
    expect(lines.join("\n")).not.toContain("SYNTHETIC_TOKEN");
  },
);
test("status reports startup metadata and never rereads credentials", async () => {
  const store = Store.open({ dataDir: dir });
  new ExtMessageSender({
    store,
    configuration: {
      status: "loaded",
      config: {
        enabled: false,
        workbench_url: "https://workbench.invalid",
        policy: EXT_MESSAGE_DEFAULTS,
        channels: { fake: { enabled: true, credential: "SYNTHETIC_SECRET" } },
      },
    },
  }).recordStatus();
  store.close();
  writeFileSync(join(dir, "ext-message.yaml"), "invalid configuration", {
    mode: 0o644,
  });
  expect(await main(["ext-message", "status"], io)).toBe(0);
  expect(lines.join("\n")).toContain('"status": "loaded"');
  expect(lines.join("\n")).not.toContain("SYNTHETIC_SECRET");
});
test("human test uses only an injected fake adapter, respects switches and hides errors", async () => {
  const path = join(dir, "ext-message.yaml");
  const text =
    "enabled: true\nworkbench_url: https://workbench.invalid\nchannels: { fake: { enabled: true, credential: SYNTHETIC_SECRET } }\n";
  writeFileSync(path, text, { mode: 0o600 });
  const send = vi.fn(async () => "sent" as const);
  expect(
    await runExtMessageCommand(["test", "--channel", "fake"], io, {
      fake: () => ({ send }),
    }),
  ).toBe(0);
  expect(send.mock.calls).toHaveLength(1);
  expect(send.mock.calls[0]?.[0]).toEqual({
    title: "Cardigan 外部通知测试",
    url: "https://workbench.invalid",
  });
  writeFileSync(path, text.replace("enabled: true", "enabled: false"));
  await expect(
    runExtMessageCommand(["test", "--channel", "fake"], io, {
      fake: () => ({ send }),
    }),
  ).rejects.toThrow("未启用");
  expect(send.mock.calls).toHaveLength(1);
  expect(lines.join("\n")).not.toContain("SYNTHETIC_SECRET");
});
