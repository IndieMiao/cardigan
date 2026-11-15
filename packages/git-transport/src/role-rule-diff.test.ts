import { chmod, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { centralFixture, git } from "../test-support/git.js";

test("trusted raw diff covers additions, deletions, moves, modes and literal unusual paths", async () => {
  const f = await centralFixture();
  try {
    await mkdir(join(f.source, "roles"));
    await writeFile(join(f.source, "roles/old.md"), "old\n");
    await writeFile(join(f.source, "mode"), "mode\n");
    await writeFile(join(f.source, "remove"), "remove\n");
    await git(f.source, "add", ".");
    await git(f.source, "commit", "-m", "base");
    const base = await git(f.source, "rev-parse", "HEAD");
    await rename(
      join(f.source, "roles/old.md"),
      join(f.source, "roles/moved.md"),
    );
    await git(f.source, "rm", "remove");
    await chmod(join(f.source, "mode"), 0o755);
    await writeFile(join(f.source, ":(glob)*\nname"), "literal\n");
    await symlink("mode", join(f.source, "link"));
    await git(f.source, "add", ".");
    await git(f.source, "commit", "-m", "changes");
    const sha = await git(f.source, "rev-parse", "HEAD");
    const repo = await f.central.ensureCentral(f.project);
    const diff = await f.transport.fileDiffs(repo, base, sha);
    expect(diff.map((d) => [d.path, d.status])).toEqual(
      expect.arrayContaining([
        ["roles/old.md", "D"],
        ["roles/moved.md", "A"],
        ["remove", "D"],
        ["mode", "M"],
        [":(glob)*\nname", "A"],
        ["link", "A"],
      ]),
    );
    expect(diff).toHaveLength(6);
    expect(diff.find((d) => d.path === "mode")).toMatchObject({
      old_mode: "100644",
      new_mode: "100755",
    });
    expect(diff.find((d) => d.path === ":(glob)*\nname")).toMatchObject({
      after: "literal\n",
    });
    expect(diff.find((d) => d.path === "link")).toMatchObject({
      new_mode: "120000",
    });
    expect(await f.transport.fileDiffs(repo, sha, sha)).toEqual([]);
    await expect(f.transport.fileDiffs(repo, "HEAD", sha)).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test("the real immutable Git objects assemble a bound body inventory including all hunks", async () => {
  const { collectRoleRuleInventory } = await import("@cardigan/git-service");
  const f = await centralFixture();
  try {
    await writeFile(
      join(f.source, "AGENTS.md"),
      "日志使用中文。\n中间行一\n中间行二\n说明使用中文。\n",
    );
    await git(f.source, "add", ".");
    await git(f.source, "commit", "-m", "body baseline");
    const base = await git(f.source, "rev-parse", "HEAD");
    await writeFile(
      join(f.source, "AGENTS.md"),
      "日志和注释使用中文。\n中间行一\n中间行二\n说明和报告使用中文。\n",
    );
    await git(f.source, "add", ".");
    await git(f.source, "commit", "-m", "human wording");
    const sha = await git(f.source, "rev-parse", "HEAD");
    const repo = await f.central.ensureCentral(f.project);
    const inventory = await collectRoleRuleInventory(
      f.transport,
      repo,
      base,
      sha,
    );
    expect(inventory).toMatchObject({
      complete: true,
      base_sha: base,
      sha,
      tree_sha: await f.transport.treeOfCommit(repo, sha),
    });
    expect(inventory.changes).toHaveLength(1);
    expect(inventory.changes[0]?.category).toBe("body");
    expect(inventory.changes[0]?.edits).toHaveLength(2);
    expect(inventory.changes[0]?.edits[1]?.after).toBe(
      "说明和报告使用中文。\n",
    );
  } finally {
    await f.close();
  }
});
