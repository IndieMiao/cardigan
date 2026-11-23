import { readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { centralFixture, commit, git } from "../test-support/git.js";

let f: Awaited<ReturnType<typeof centralFixture>>;
beforeEach(async () => {
  f = await centralFixture();
});
afterEach(async () => {
  await f.close();
});

/** One kept pack per fetch, like the central repository's daily traffic. */
async function fetchedPacks(repo: string, count: number) {
  const heads: string[] = [];
  for (let i = 0; i < count; i++) {
    const sha = await commit(
      f.source,
      `change ${heads.length} ${Math.random()}`,
    );
    await git(
      repo,
      "-c",
      "fetch.unpackLimit=1",
      "fetch",
      "--no-auto-maintenance",
      "--",
      f.source,
      `${sha}:refs/cardigan/candidates/A-1/${sha}`,
    );
    heads.push(sha);
  }
  return heads;
}
/** An object no ref reaches, as merge-tree output or a deleted ref leaves. */
async function looseObject(repo: string, text: string) {
  const path = join(f.root, "loose");
  await writeFile(path, text);
  return git(f.root, "--git-dir", repo, "hash-object", "-w", "--", path);
}

test("C-637: geometric repack rolls up fetched packs and loose objects without losing refs", async () => {
  const repo = await f.central.ensureCentral(f.project);
  const heads = await fetchedPacks(repo, 6);
  await git(repo, "update-ref", "refs/cardigan/prechecks/P-1", heads[2] ?? "");
  const unreachable = await looseObject(repo, "merge-tree leftover");
  const before = await f.transport.objectStats(repo);
  expect(before.packs).toBeGreaterThanOrEqual(6);
  expect(before.loose).toBeGreaterThanOrEqual(1);
  const result = await f.transport.repack(repo, "geometric");
  expect(result).toMatchObject({ mode: "geometric", before });
  expect(result.after.packs).toBeLessThan(before.packs);
  expect(result.after.loose).toBe(0);
  expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  await git(repo, "fsck", "--connectivity-only", "--no-dangling");
  for (const sha of heads)
    expect(await git(repo, "cat-file", "-t", sha)).toBe("commit");
  expect(await git(repo, "cat-file", "-t", unreachable)).toBe("blob");
  const repack = f.calls.find((c) => c.args.includes("repack"));
  expect(repack?.args.slice(repack.args.indexOf("repack"))).toEqual([
    "repack",
    "--geometric=2",
    "-d",
    "-q",
  ]);
});

test("C-637: cruft repack keeps unreachable objects, records its time and survives geometric runs", async () => {
  const repo = await f.central.ensureCentral(f.project);
  expect(await f.transport.lastCruftPack(repo)).toBeUndefined();
  await fetchedPacks(repo, 3);
  const unreachable = await looseObject(repo, "unreferenced");
  const result = await f.transport.repack(repo, "cruft");
  expect(result.mode).toBe("cruft");
  expect(result.after.loose).toBe(0);
  // No --cruft-expiration: nothing is deleted, the object only moves.
  expect(
    f.calls.some((c) => c.args.some((a) => a.includes("expiration"))),
  ).toBe(false);
  expect(await git(repo, "cat-file", "-t", unreachable)).toBe("blob");
  expect(await f.transport.lastCruftPack(repo)).toBeGreaterThan(0);
  const old = new Date(Date.UTC(2026, 0, 1));
  const packs = join(repo, "objects", "pack");
  for (const name of await readdir(packs))
    if (name.endsWith(".mtimes")) await utimes(join(packs, name), old, old);
  expect(await f.transport.lastCruftPack(repo)).toBe(old.getTime());
  await fetchedPacks(repo, 3);
  await f.transport.repack(repo, "geometric");
  // Geometric repacks leave the cruft pack alone.
  expect(await f.transport.lastCruftPack(repo)).toBe(old.getTime());
  expect(await git(repo, "cat-file", "-t", unreachable)).toBe("blob");
  await git(repo, "fsck", "--connectivity-only", "--no-dangling");
});

test("C-637: maintenance never leaves the central root", async () => {
  await expect(f.transport.repack(f.source, "geometric")).rejects.toThrow(
    /Unexpected central repository path/,
  );
  await expect(f.transport.lastCruftPack(f.source)).rejects.toThrow(
    /Unexpected central repository path/,
  );
});

test("C-637 / Q-1233: retained refs are compare-and-deleted per chunk, only in their namespaces", async () => {
  const repo = await f.central.ensureCentral(f.project);
  const [a, b, c] = await fetchedPacks(repo, 3);
  const sha = (x: string | undefined) => x ?? "";
  await git(
    repo,
    "update-ref",
    `refs/cardigan/prechecks/A-1/${sha(a)}`,
    sha(a),
  );
  await git(repo, "update-ref", "refs/cardigan/candidates/D-9", sha(b));
  await git(repo, "update-ref", "refs/cardigan/deliveries/D-9", sha(b));
  await expect(
    f.transport.deleteRetainedRefs(repo, [
      { ref: "refs/cardigan/deliveries/D-9", sha: sha(b) },
    ]),
  ).rejects.toThrow(/Invalid retained ref deletion/);
  await expect(f.transport.deleteRetainedRefs(f.source, [])).rejects.toThrow(
    /Unexpected central repository path/,
  );
  const result = await f.transport.deleteRetainedRefs(
    repo,
    [
      { ref: `refs/cardigan/prechecks/A-1/${sha(a)}`, sha: sha(a) },
      { ref: `refs/cardigan/candidates/A-1/${sha(a)}`, sha: sha(a) },
      // Moved since it was listed: its chunk is kept for the next run.
      { ref: "refs/cardigan/candidates/D-9", sha: sha(c) },
      { ref: `refs/cardigan/candidates/A-1/${sha(b)}`, sha: sha(b) },
    ],
    2,
  );
  expect(result).toEqual({ deleted: 2, failed: 2 });
  const left = (await f.transport.listRefs(repo, "refs/cardigan/")).map(
    (r) => r.ref,
  );
  expect(left).not.toContain(`refs/cardigan/prechecks/A-1/${sha(a)}`);
  expect(left).not.toContain(`refs/cardigan/candidates/A-1/${sha(a)}`);
  expect(left).toContain("refs/cardigan/candidates/D-9");
  expect(left).toContain(`refs/cardigan/candidates/A-1/${sha(b)}`);
  expect(left).toContain("refs/cardigan/deliveries/D-9");
  // The commits stay in the object store; a cruft pass keeps them too.
  await f.transport.repack(repo, "cruft");
  expect(await git(repo, "cat-file", "-t", sha(a))).toBe("commit");
});
