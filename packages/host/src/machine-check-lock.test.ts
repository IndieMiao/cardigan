import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { withMachineCheck } from "./machine-check-lock.js";

test("a machine check holds its slot through IO; unrelated machines proceed and a failed probe releases the slot", async () => {
  const root = await mkdtemp(join(tmpdir(), "machine-lock-test-"));
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const follower = vi.fn(async () => true);
  const first = withMachineCheck(root, "same", async () => {
    entered.resolve();
    await finish.promise;
    throw new Error("failed");
  });
  try {
    await entered.promise;
    const next = withMachineCheck(root, "same", follower);
    await withMachineCheck(root, "other", async () => true);
    expect(follower).not.toHaveBeenCalled();
    finish.resolve();
    await expect(first).rejects.toThrow("failed");
    await expect(next).resolves.toBe(true);
    expect(follower).toHaveBeenCalledTimes(1);
  } finally {
    finish.resolve();
    await first.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
