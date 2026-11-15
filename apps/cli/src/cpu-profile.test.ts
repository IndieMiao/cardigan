import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CpuProfileController } from "@cardigan/host";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CLI_TOOLS } from "./command-access.js";
import { runCpuProfileCommand } from "./cpu-profile.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

let root: string;
let io: CliIo;
let output: string[];
const controllers: CpuProfileController[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cpu-cli-"));
  output = [];
  io = {
    cwd: root,
    platform: "linux",
    env: { CARDIGAN_DATA_DIR: root },
    stdout: (s) => output.push(s),
    stderr: (s) => output.push(s),
    signals: { on() {}, off() {} },
    spawnInherit: () => {
      throw new Error("unexpected");
    },
    captureCommand: async () => {
      throw new Error("unexpected");
    },
  };
});
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((c) => c.close()));
  rmSync(root, { recursive: true, force: true });
});
test.each(["status", "start", "stop"] as const)(
  "%s denies Token identities before touching files",
  async (action) => {
    expect(CLI_TOOLS[`cpu-profile ${action}`]).toBeNull();
    const tokenIo = {
      ...io,
      env: { ...io.env, CARDIGAN_TOKEN: "SYNTHETIC_PRIVATE" },
    };
    expect(
      await main(["cpu-profile", action, "--target", "both"], tokenIo),
    ).not.toBe(0);
    expect(() =>
      runCpuProfileCommand([action, "--target", "both"], tokenIo),
    ).toThrow("仅限人类");
    expect(() =>
      runCpuProfileCommand([action, "--target", "both"], {
        ...io,
        tokenFile: "/missing",
      }),
    ).toThrow("仅限人类");
    expect(output.join()).not.toContain("SYNTHETIC_PRIVATE");
  },
);
test("the human CLI writes only a bounded request using registered process identities", async () => {
  controllers.push(
    new CpuProfileController({
      dataDir: root,
      role: "web",
      sha: "b".repeat(40),
    }),
  );
  controllers.push(
    new CpuProfileController({
      dataDir: root,
      role: "background",
      sha: "b".repeat(40),
    }),
  );
  expect(await main(["cpu-profile", "start", "--target", "both"], io)).toBe(0);
  const request = JSON.parse(
    readFileSync(join(root, "cpu-profiles", "request.json"), "utf8"),
  );
  expect(request).toMatchObject({
    seconds: 60,
    interval_us: 1000,
    targets: [
      { role: "web", pid: process.pid },
      { role: "background", pid: process.pid },
    ],
  });
  expect(await main(["cpu-profile", "status", "--target", "both"], io)).toBe(0);
  expect(JSON.parse(output.at(-1) as string).pending).toEqual([
    "web",
    "background",
  ]);
  expect(await main(["cpu-profile", "stop", "--target", "both"], io)).toBe(0);
});
test.each([
  ["start"],
  ["start", "--target", "all"],
  ["start", "--target", "web", "--pid", "1"],
  ["start", "--target", "web", "--seconds", "121"],
  ["start", "--target", "web", "--interval-us", "999"],
  ["stop", "--target", "web", "--seconds", "1"],
  ["status", "--target", "web", "--target", "both"],
])("rejects invalid CLI arguments %j", async (args) => {
  expect(await main(["cpu-profile", ...args], io)).not.toBe(0);
});
