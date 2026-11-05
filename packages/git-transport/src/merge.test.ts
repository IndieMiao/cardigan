import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitCentralPort, MergePlan } from "@cardigan/domain";
import { CentralRepositoryService } from "@cardigan/git-service";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { centralFixture, commit, git } from "../test-support/git.js";

/**
 * M4.3 §3.5: the merge happens inside the central bare repository
 * (`merge-tree --write-tree` + `commit-tree`) and only a comparison-and-swap
 * `update-ref` moves the baseline. No checkout, so no worktree filter runs.
 */
let f: Awaited<ReturnType<typeof centralFixture>>,
  repo: string,
  work: string,
  deliveries: Map<string, string>;
beforeEach(async () => {
  f = await centralFixture();
  repo = await f.central.ensureCentral(f.project);
  work = join(f.root, "work");
  await git(f.root, "clone", f.source, work);
  deliveries = new Map();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await f.close();
});

/** A delivery commit on its own branch, fetched into the center and pinned. */
async function deliver(
  delivery_id: string,
  write: (worktree: string) => Promise<void>,
) {
  const branch = `agent/C-1/${delivery_id}`;
  await git(work, "switch", "-q", "--detach", f.initial);
  await git(work, "switch", "-q", "-c", branch);
  await write(work);
  await git(work, "add", "-A");
  await git(work, "commit", "-q", "-m", delivery_id);
  const sha = await git(work, "rev-parse", "HEAD");
  await f.transport.fetchRefs(repo, work, [
    `+refs/heads/${branch}:refs/cardigan/candidates/A-1/${sha}`,
  ]);
  await f.central.pinDelivery(f.project, delivery_id, sha);
  deliveries.set(delivery_id, sha);
  return sha;
}
const writeFileTo = (name: string, body: string) => async (worktree: string) =>
  writeFile(join(worktree, name), body);
function plan(...ids: string[]): MergePlan {
  return {
    card_id: "C-1" as never,
    title: "Fixture card",
    base_branch: "main",
    completion_id: "D-99" as never,
    deliveries: ids.map((id, index) => ({
      delivery_id: id as never,
      work_item_id: `W-${index + 1}` as never,
      sha: deliveries.get(id) as string,
    })),
  };
}
const authors = (rev: string) =>
  git(repo, "show", "-s", "--format=%an|%ae|%cn|%ce", rev);
const parents = (rev: string) =>
  git(repo, "rev-list", "--parents", "-n", "1", rev);

test("merges planned deliveries onto the baseline, each with two parents", async () => {
  const first = await deliver("D-1", writeFileTo("first.txt", "first"));
  const second = await deliver("D-2", writeFileTo("second.txt", "second"));
  const sourceRefs = await git(f.source, "show-ref");

  const outcome = await f.central.mergeIntoBase(f.project, plan("D-1", "D-2"));

  expect(outcome).toMatchObject({
    status: "merged",
    previous_sha: f.initial,
  });
  if (outcome.status !== "merged") throw new Error("not merged");
  const baseline = await git(repo, "rev-parse", "refs/heads/main");
  expect(baseline).toBe(outcome.merge_sha);
  // The first merge parents the old baseline and D-1; the second the first merge and D-2.
  const firstMerge = await git(repo, "rev-parse", `${outcome.merge_sha}~1`);
  expect((await parents(outcome.merge_sha)).split(" ")).toEqual([
    outcome.merge_sha,
    firstMerge,
    second,
  ]);
  expect((await parents(firstMerge)).split(" ")).toEqual([
    firstMerge,
    f.initial,
    first,
  ]);
  expect(await git(repo, "show", "main:first.txt")).toBe("first");
  expect(await git(repo, "show", "main:second.txt")).toBe("second");
  // Explicit author and committer, never the host's Git identity.
  expect(await authors(outcome.merge_sha)).toBe(
    "Cardigan|cardigan@localhost|Cardigan|cardigan@localhost",
  );
  expect(await git(repo, "rev-parse", "--is-bare-repository")).toBe("true");
  await expect(git(repo, "rev-parse", "--show-toplevel")).rejects.toThrow();
  expect(await git(f.source, "show-ref")).toBe(sourceRefs);
  // Every command ran in the central repository, with the hardening arguments.
  expect(
    f.calls.every(
      (call) =>
        call.cwd.startsWith(join(f.dataDir, "central")) &&
        call.args.includes("transfer.fsckObjects=true") &&
        call.args.includes("core.hooksPath=/dev/null"),
    ),
  ).toBe(true);
});

test("a merge commit ignores ambient Git identity and takes the configured one", async () => {
  await deliver("D-1", writeFileTo("first.txt", "first"));
  await deliver("D-2", writeFileTo("second.txt", "second"));
  vi.stubEnv("GIT_AUTHOR_NAME", "Host User");
  vi.stubEnv("GIT_COMMITTER_NAME", "Host User");
  vi.stubEnv("GIT_COMMITTER_EMAIL", "host@example.invalid");
  const outcome = await f.central.mergeIntoBase(f.project, plan("D-1"));
  if (outcome.status !== "merged") throw new Error("not merged");
  expect(await authors(outcome.merge_sha)).toBe(
    "Cardigan|cardigan@localhost|Cardigan|cardigan@localhost",
  );
  const custom = new CentralRepositoryService(f.transport, {
    dataDir: f.dataDir,
    identity: { name: "Merge Bot", email: "merge@example.invalid" },
  });
  // D-1 is already an ancestor of the baseline, so only D-2 is merged.
  const second = await custom.mergeIntoBase(f.project, plan("D-1", "D-2"));
  if (second.status !== "merged") throw new Error("not merged");
  expect(await authors(second.merge_sha)).toBe(
    "Merge Bot|merge@example.invalid|Merge Bot|merge@example.invalid",
  );
});

test("a conflict reports the files and moves no ref", async () => {
  await deliver("D-1", writeFileTo("file", "one"));
  await deliver("D-2", writeFileTo("file", "two"));
  const refsBefore = await git(repo, "for-each-ref");

  const outcome = await f.central.mergeIntoBase(f.project, plan("D-1", "D-2"));

  expect(outcome).toEqual({
    status: "conflicted",
    delivery_id: "D-2",
    files: ["file"],
  });
  expect(await git(repo, "for-each-ref")).toBe(refsBefore);
  expect(await git(repo, "rev-parse", "refs/heads/main")).toBe(f.initial);
  expect(await git(repo, "rev-parse", "refs/cardigan/deliveries/D-1")).toBe(
    deliveries.get("D-1"),
  );
});

test("an advanced baseline returns stale instead of overwriting it", async () => {
  await deliver("D-1", writeFileTo("first.txt", "first"));
  const advanced = await commit(f.source, "someone else merged");
  await f.transport.fetchRefs(repo, f.source, [
    "+refs/heads/main:refs/cardigan/incoming/other",
  ]);
  // Move the baseline after the service read it but before the comparison-and-swap.
  const racing: GitCentralPort = new Proxy(f.transport as GitCentralPort, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property !== "mergeTree") return value.bind(target);
      return async (...args: unknown[]) => {
        const merged = await (
          value as (...a: unknown[]) => Promise<unknown>
        ).apply(target, args);
        await git(repo, "update-ref", "refs/heads/main", advanced);
        return merged;
      };
    },
  });
  const racingService = new CentralRepositoryService(racing, {
    dataDir: f.dataDir,
  });

  expect(await racingService.mergeIntoBase(f.project, plan("D-1"))).toEqual({
    status: "stale",
  });
  expect(await git(repo, "rev-parse", "refs/heads/main")).toBe(advanced);
});

test("re-running a completed merge is a no-op and creates no second merge commit", async () => {
  await deliver("D-1", writeFileTo("first.txt", "first"));
  const merged = await f.central.mergeIntoBase(f.project, plan("D-1"));
  if (merged.status !== "merged") throw new Error("not merged");
  const count = await git(repo, "rev-list", "--count", "--merges", "main");

  expect(await f.central.mergeIntoBase(f.project, plan("D-1"))).toEqual({
    status: "noop",
    branch_sha: merged.merge_sha,
  });
  expect(await git(repo, "rev-parse", "refs/heads/main")).toBe(
    merged.merge_sha,
  );
  expect(await git(repo, "rev-list", "--count", "--merges", "main")).toBe(
    count,
  );
});

test("an unpinned, unknown or foreign-branch delivery is refused before any merge", async () => {
  const sha = await deliver("D-1", writeFileTo("first.txt", "first"));
  const refsBefore = await git(repo, "for-each-ref");
  const mismatched = plan("D-1");
  const planned = mismatched.deliveries[0];
  if (planned === undefined) throw new Error("missing planned delivery");
  const cases: MergePlan[] = [
    { ...mismatched, deliveries: [{ ...planned, sha: f.initial }] },
    {
      ...mismatched,
      deliveries: [
        { delivery_id: "D-2" as never, work_item_id: "W-1" as never, sha },
      ],
    },
    { ...mismatched, base_branch: "release" },
    {
      ...mismatched,
      deliveries: [
        { delivery_id: "X-1" as never, work_item_id: "W-1" as never, sha },
      ],
    },
  ];
  for (const candidate of cases)
    await expect(
      f.central.mergeIntoBase(f.project, candidate),
    ).rejects.toThrow();
  expect(await git(repo, "for-each-ref")).toBe(refsBefore);
  expect(await git(repo, "rev-parse", "refs/heads/main")).toBe(f.initial);
});

test("an empty plan is a no-op and reports the current baseline", async () => {
  expect(
    await f.central.mergeIntoBase(f.project, {
      ...plan(),
      deliveries: [],
    }),
  ).toEqual({ status: "noop", branch_sha: f.initial });
});
