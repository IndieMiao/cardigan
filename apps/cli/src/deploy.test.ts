import { changeDeployment } from "@cardigan/host";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { runDeployCommand } from "./deploy.js";
import type { CliIo } from "./io.js";

vi.mock("@cardigan/host", async (original) => ({
  ...(await original<object>()),
  changeDeployment: vi.fn(),
}));
const io = (): CliIo => ({
  env: {},
  cwd: "/tmp",
  platform: "linux",
  stdout: vi.fn(),
  stderr: vi.fn(),
  signals: { on: vi.fn(), off: vi.fn() },
  spawnInherit: vi.fn(),
  captureCommand: vi.fn(),
});

test("deployment CLI refuses token and token-file modes before opening the store", async () => {
  const open = vi.spyOn(Store, "open");
  try {
    for (const command of ["adopt", "pin", "unpin"])
      for (const auth of [
        { env: { CARDIGAN_TOKEN: "" } },
        { tokenFile: "/nonexistent" },
      ])
        await expect(
          runDeployCommand([command], { ...io(), ...auth }),
        ).rejects.toThrow("Token");
    expect(open).not.toHaveBeenCalled();
  } finally {
    open.mockRestore();
  }
});

test("deployment CLI requires an explanation and passes exact versions to the human host service", async () => {
  const store = Store.open({ dataDir: "/tmp", dbPath: ":memory:" });
  store.createProject({ id: "cardigan" });
  const open = vi.spyOn(Store, "open").mockReturnValue(store);
  const close = vi.spyOn(store, "close").mockImplementation(() => {});
  const command = vi.mocked(changeDeployment);
  try {
    for (const args of [
      ["pin", "a".repeat(40)],
      ["unpin", "--reason", " "],
      ["adopt", "a", "b", "--reason", "x", "extra"],
    ])
      await expect(runDeployCommand(args, io())).rejects.toThrow("用法");
    expect(open).not.toHaveBeenCalled();
    const sha = "a".repeat(40),
      next = "b".repeat(40);
    for (const args of [["pin", sha], ["adopt", sha, next], ["unpin"]])
      expect(
        await runDeployCommand([...args, "--reason", "已核对"], io()),
      ).toBe(0);
    expect(command.mock.calls.map((c) => c[3])).toEqual([
      { action: "pin", sha, reason: "已核对" },
      { action: "adopt", from: sha, to: next, reason: "已核对" },
      { action: "unpin", reason: "已核对" },
    ]);
    expect(command.mock.calls.every((c) => c[2].kind === "human")).toBe(true);
    expect(close).toHaveBeenCalledTimes(3);
  } finally {
    open.mockRestore();
    close.mockRestore();
    store.close();
  }
});
