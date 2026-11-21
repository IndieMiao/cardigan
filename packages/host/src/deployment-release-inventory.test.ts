import { chmod, lstat, mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { ReleaseSurvey } from "./deployment-release-inventory.js";
import type { Item } from "./deployment-retention-io.js";

test("surveying a backlog never waits for the tree walk, isolates timeouts, and hands off against current refs", async () => {
  const root = await mkdtemp(join(tmpdir(), "cg-release-survey-"));
  const name = (i: number) =>
    `release-${"c".repeat(40)}-00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  try {
    for (let i = 0; i < 32; i++) {
      const p = join(root, name(i));
      await mkdir(p, { mode: 0o700 });
      await utimes(p, i, i);
    }
    await chmod(join(root, name(0)), 0o750);
    let release!: () => void;
    const delayed = new Promise<void>((r) => {
      release = r;
    });
    const observe = vi.fn(async (_: unknown, n: string): Promise<Item> => {
      await delayed;
      if (n === name(2)) throw new Error("timeout");
      const st = await lstat(join(root, n), { bigint: true });
      return {
        kind: "release",
        name: n,
        inode: String(st.ino),
        device: String(st.dev),
        size_bytes: 0,
        stamp: "aa",
      };
    });
    const survey = new ReleaseSurvey(observe);
    const input = { root, uid: process.getuid?.(), latest: 1, keep: [name(1)] };
    expect(await survey.poll("scope", input)).toBeUndefined();
    expect(await survey.poll("scope", input)).toBeUndefined();
    expect(observe).toHaveBeenCalledTimes(1);
    release();
    const later = { ...input, keep: [name(3)] };
    await vi.waitFor(async () => {
      const result = await survey.poll("scope", later);
      expect(result).toBeDefined();
      expect(result).toHaveLength(32);
      expect(
        result
          ?.filter((x) => x.reason === "unverified")
          .map((x) => x.name)
          .sort(),
      ).toEqual([name(0), name(2)]);
      expect(result).toContainEqual({
        name: name(3),
        reason: "state_reference",
        size_bytes: 0,
      });
      expect(result).toContainEqual({
        name: name(31),
        reason: "recent",
        size_bytes: 0,
      });
      expect(result).toContainEqual({
        name: name(1),
        reason: "inventory_only",
        size_bytes: 0,
      });
    });
    expect(observe).toHaveBeenCalledTimes(31);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
