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
    const port = {
      create: (ref: string, sha: string) =>
        git(["update-ref", ref, sha, "0".repeat(sha.length)]),
      read: async (ref: string) =>
        (await git(["for-each-ref", "--format=%(objectname)", ref])).trim() ||
        undefined,
      tree: async (sha: string) =>
        (await git(["rev-parse", "--verify", `${sha}^{tree}`])).trim(),
    };
    const sha = (await git(["rev-parse", "HEAD"])).trim();
    const original = await pinStallBackup(port, "A-1", id, sha);
    expect(await pinStallBackup(port, "A-1", id, sha)).toEqual(original);
    await git(["commit", "--allow-empty", "-qm", "second"]);
    const next = (await git(["rev-parse", "HEAD"])).trim();
    await expect(pinStallBackup(port, "A-1", id, next)).rejects.toThrow();
    expect((await git(["rev-parse", original.ref])).trim()).toBe(original.sha);
    writeFileSync(join(dir, "untracked"), "fixture");
    expect((await git(["rev-parse", "HEAD"])).trim()).toBe(next);
    expect(await git(["status", "--porcelain"])).toBe("?? untracked\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
