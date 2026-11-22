import { join } from "node:path";
import type { MergePlan } from "@cardigan/domain";
import { centralBranch } from "@cardigan/git-service";
import { afterEach, beforeEach, expect, test } from "vitest";
import { centralFixture, commit, git } from "../test-support/git.js";

/**
 * C-589: one project, several baseline branches. Each card merges into its
 * own `base_branch` of the central repository; the other branch never moves.
 */
let f: Awaited<ReturnType<typeof centralFixture>>, repo: string, work: string;
const farm = "integration/farm";
beforeEach(async () => {
  f = await centralFixture();
  repo = await f.central.ensureCentral(f.project);
  work = join(f.root, "work");
  await git(f.root, "clone", "-q", f.source, work);
});
afterEach(() => f.close());

/** A delivery commit on top of `from`, fetched into the center and pinned. */
async function deliver(id: string, from: string, file: string) {
  await git(work, "fetch", "-q", "origin");
  await git(work, "switch", "-q", "--detach", from);
  const sha = await commit(work, `${id} ${file}`);
  await f.transport.fetchRefs(repo, work, [`+HEAD:refs/cardigan/test/${id}`]);
  await f.central.pinDelivery(f.project, id, sha);
  return sha;
}
function plan(
  card: string,
  completion: string,
  base_branch: string,
  delivery: string,
  sha: string,
): MergePlan {
  return {
    card_id: card as never,
    title: `${card} fixture`,
    base_branch,
    completion_id: completion as never,
    deliveries: [
      { delivery_id: delivery as never, work_item_id: "W-1" as never, sha },
    ],
  };
}

test("cards on main and on another branch merge into their own central branches", async () => {
  // The integration branch is created in the source after the central clone.
  await git(f.source, "switch", "-q", "-c", farm);
  const farmBase = await commit(f.source, "farm base");
  await git(f.source, "switch", "-q", "main");
  const view = centralBranch(f.project, farm);
  expect(view).toEqual({ ...f.project, base_branch: farm });
  expect(centralBranch(f.project, "main")).toBe(f.project);
  await expect(f.central.ensureCentral(view)).rejects.toThrow(/missing/u);
  expect(await f.central.syncFromSource(view)).toBe("fast_forwarded");
  expect(await git(repo, "rev-parse", `refs/heads/${farm}`)).toBe(farmBase);

  const onMain = await deliver("D-1", f.initial, "main-change.txt");
  const onFarm = await deliver("D-2", farmBase, "farm-change.txt");
  const mainPlan = plan("C-1", "D-10", "main", "D-1", onMain);
  const farmPlan = plan("C-2", "D-20", farm, "D-2", onFarm);
  // The registered view cannot merge another branch's plan, and vice versa.
  await expect(f.central.prepareMerge(f.project, farmPlan)).rejects.toThrow(
    /does not match/u,
  );
  await expect(f.central.prepareMerge(view, mainPlan)).rejects.toThrow(
    /does not match/u,
  );

  const farmCandidate = await f.central.prepareMerge(view, farmPlan);
  const mainCandidate = await f.central.prepareMerge(f.project, mainPlan);
  if (
    farmCandidate.status !== "candidate" ||
    mainCandidate.status !== "candidate"
  )
    throw new Error("Expected two candidates");
  expect(farmCandidate.previous_sha).toBe(farmBase);
  expect(mainCandidate.previous_sha).toBe(f.initial);
  expect(
    (
      await git(
        repo,
        "rev-list",
        "--parents",
        "-n",
        "1",
        farmCandidate.candidate_sha,
      )
    )
      .split(" ")
      .slice(1),
  ).toEqual([farmBase, onFarm]);

  expect(
    await f.central.publishMerge(
      view,
      "D-20",
      farmCandidate.candidate_sha,
      farmCandidate.previous_sha,
    ),
  ).toMatchObject({ status: "merged" });
  // Publishing one branch never moves the other.
  expect(await git(repo, "rev-parse", "main")).toBe(f.initial);
  expect(
    await f.central.publishMerge(
      f.project,
      "D-10",
      mainCandidate.candidate_sha,
      mainCandidate.previous_sha,
    ),
  ).toMatchObject({ status: "merged" });
  expect(await git(repo, "rev-parse", "main")).toBe(
    mainCandidate.candidate_sha,
  );
  expect(await git(repo, "rev-parse", `refs/heads/${farm}`)).toBe(
    farmCandidate.candidate_sha,
  );
  const contains = (rev: string, sha: string) =>
    git(repo, "merge-base", "--is-ancestor", sha, rev).then(
      () => true,
      () => false,
    );
  expect(await contains("main", onFarm)).toBe(false);
  expect(await contains(farm, onMain)).toBe(false);

  // A central-only merge leaves the source behind; sync never rewinds it.
  expect(await f.central.syncFromSource(view)).toBe("ahead");
  expect(await git(repo, "rev-parse", `refs/heads/${farm}`)).toBe(
    farmCandidate.candidate_sha,
  );
  // The source was never written.
  expect(await git(f.source, "rev-parse", farm)).toBe(farmBase);
});

test("author precheck and batches use the card's branch", async () => {
  await git(f.source, "switch", "-q", "-c", farm);
  const farmBase = await commit(f.source, "farm base");
  await git(f.source, "switch", "-q", "main");
  const view = centralBranch(f.project, farm);
  await f.central.syncFromSource(view);
  const head = await deliver("D-3", farmBase, "precheck.txt");
  await f.central.createRef(repo, `refs/cardigan/prechecks/A-7/${head}`, head);
  const prepared = await f.central.preparePrecheck(view, "A-7", head, "pre-1");
  expect(prepared.base_sha).toBe(farmBase);
  const registered = await f.central.preparePrecheck(
    f.project,
    "A-7",
    head,
    "pre-2",
  );
  expect(registered.base_sha).toBe(f.initial);

  const other = await deliver("D-4", f.initial, "main-only.txt");
  await expect(
    f.central.prepareBatch(view, [
      plan("C-3", "D-30", farm, "D-3", head),
      plan("C-4", "D-40", "main", "D-4", other),
    ]),
  ).rejects.toThrow(/one baseline branch/u);
  const batch = await f.central.prepareBatch(view, [
    plan("C-3", "D-30", farm, "D-3", head),
  ]);
  expect(batch.base_sha).toBe(farmBase);
  expect(batch.members).toHaveLength(1);
  // Nothing was published by preparation.
  expect(await git(repo, "rev-parse", `refs/heads/${farm}`)).toBe(farmBase);
  expect(await git(repo, "rev-parse", "main")).toBe(f.initial);
});

test("unusable branch names and branches missing from the source fail explicitly", async () => {
  for (const name of [
    "../escape",
    "refs/heads/main",
    "-x",
    "a..b",
    "x.lock",
    "",
  ])
    expect(() => centralBranch(f.project, name)).toThrow(/Invalid/u);
  await expect(
    f.central.syncFromSource(centralBranch(f.project, "nowhere")),
  ).rejects.toThrow();
  expect(await git(repo, "show-ref", "--heads")).not.toContain("nowhere");
});

test("a central-only branch merges without a source branch; missing on both sides fails", async () => {
  await git(f.source, "switch", "-q", "-c", farm);
  const farmBase = await commit(f.source, "farm base");
  await git(f.source, "switch", "-q", "main");
  const view = centralBranch(f.project, farm);
  expect(await f.central.ensureBranch(view)).toBe(repo);
  expect(await git(repo, "rev-parse", `refs/heads/${farm}`)).toBe(farmBase);
  const onFarm = await deliver("D-5", farmBase, "central-only.txt");
  // The source drops the branch; the central branch carries on alone.
  await git(f.source, "branch", "-q", "-D", farm);
  expect(await f.central.syncFromSource(view)).toBe("ahead");
  const prepared = await f.central.prepareMerge(
    view,
    plan("C-5", "D-50", farm, "D-5", onFarm),
  );
  expect(prepared).toMatchObject({
    status: "candidate",
    previous_sha: farmBase,
  });
  await expect(
    f.central.syncFromSource(centralBranch(f.project, "nowhere")),
  ).rejects.toThrow(/missing in both/u);
  await expect(
    f.central.ensureBranch(centralBranch(f.project, "nowhere")),
  ).rejects.toThrow(/missing in both/u);
});
