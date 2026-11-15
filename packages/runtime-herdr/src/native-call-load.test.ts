import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { governHcClient } from "./call-queue.js";
import { workerPreflight } from "./index.js";

vi.mock("fs-ext", () => {
  throw new Error("synthetic private native loader diagnostic");
});

test.skipIf(process.platform !== "linux")(
  "package diagnostics load without the addon but governed IO fails closed",
  async () => {
    // Reaching this assertion proves the ordinary package entry was usable.
    expect(typeof workerPreflight).toBe("function");
    const dataDir = await mkdtemp(join(tmpdir(), "hc-native-unavailable-"));
    const raw = {
      available: async () => true,
      async *lines() {},
      exec: vi.fn(async () => "unsafe"),
    };
    try {
      const client = governHcClient(raw, {
        dataDir,
        socket: join(dataDir, "hc.sock"),
        session: "fixture",
        policy: { concurrency: 1, queueWaitMs: 1000 },
      });
      await expect(client.exec(["get", "t1"])).rejects.toMatchObject({
        code: "runtime_unavailable",
        message: "hc queue lock unavailable",
      });
      expect(raw.exec).not.toHaveBeenCalled();
      expect(client.queue.diagnostics()).toMatchObject({
        active: 0,
        queued: 0,
        completed: 1,
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
