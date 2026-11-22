import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { pinStallBackup } from "./stall-backup.js";

test("a recovery ref pins the exact branch without moving it, and replays never overwrite the saved tip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stall-backup-"));
  const git = async (args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-C",
        dir,
        ...args,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  const branch = "agent/C-1/W-1";
  const id = "0".repeat(26);
  try {
    await git(["init", "-q", "-b", branch]);
    await git(["commit", "--allow-empty", "-qm", "first"]);
    const original = await pinStallBackup(git, "A-1", id, branch);
    expect(await pinStallBackup(git, "A-1", id, branch)).toEqual(original);
    await git(["commit", "--allow-empty", "-qm", "second"]);
    await expect(pinStallBackup(git, "A-1", id, branch)).rejects.toThrow();
    expect((await git(["rev-parse", original.ref])).trim()).toBe(original.sha);
    writeFileSync(join(dir, "untracked"), "fixture");
    await expect(
      pinStallBackup(git, "A-1", id, "agent/C-1/W-2"),
    ).rejects.toThrow();
    expect(await git(["status", "--porcelain"])).toBe("?? untracked\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
