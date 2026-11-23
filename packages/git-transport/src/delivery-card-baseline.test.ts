import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Assignment, DeliveryEvidence } from "@cardigan/domain";
import {
  type CentralRepositoryService,
  centralBranch,
  GitDeliveryVerifier,
} from "@cardigan/git-service";
import { afterEach, beforeEach, expect, test } from "vitest";
import { centralFixture, git } from "../test-support/git.js";
import { LocalGitTransport } from "./index.js";

/**
 * C-654: the author's own change inventory is measured against the card's
 * baseline branch (C-589), from the newest baseline commit the delivery
 * contains, so baseline changes merged into the branch are not author risk.
 */
const farm = "integration/farm";
let f: Awaited<ReturnType<typeof centralFixture>>,
  central: CentralRepositoryService,
  repo: string,
  work: string,
  farmBase: string,
  assignment: Assignment;

async function sourceCommit(branch: string, path: string, text: string) {
  await git(f.source, "switch", "-q", branch);
  await mkdir(dirname(join(f.source, path)), { recursive: true });
  await writeFile(join(f.source, path), text);
  await git(f.source, "add", path);
  await git(f.source, "commit", "-q", "-m", `${branch}: ${path}`);
  const sha = await git(f.source, "rev-parse", "HEAD");
  await git(f.source, "switch", "-q", "main");
  await central.syncFromSource(centralBranch(f.project, branch));
  return sha;
}
async function authorCommit(path: string, text: string) {
  await mkdir(dirname(join(work, path)), { recursive: true });
  await writeFile(join(work, path), text);
  await git(work, "add", path);
  await git(work, "commit", "-q", "-m", `author: ${path}`);
  return git(work, "rev-parse", "HEAD");
}
async function mergeFarm() {
  await git(work, "fetch", "-q", repo, farm);
  await git(work, "merge", "-q", "--no-edit", "FETCH_HEAD");
  return git(work, "rev-parse", "HEAD");
}
async function verify(sha: string, baselineBranch?: string) {
  const result = await new GitDeliveryVerifier(
    central,
    f.project,
    baselineBranch,
  ).verify({ kind: "git_head", value: sha }, assignment);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
const detail = (evidence: readonly DeliveryEvidence[], key: string) =>
  evidence.find((e) => e.details[key] !== undefined)?.details[key] as
    | Record<string, unknown>
    | undefined;

beforeEach(async () => {
  f = await centralFixture();
  central = f.central;
  repo = await central.ensureCentral(f.project);
  await git(f.source, "branch", farm);
  farmBase = await sourceCommit(farm, "farm.txt", "farm base\n");
  // The project baseline moves independently and is never an ancestor.
  await sourceCommit("main", "main-only.txt", "main\n");
  const base = join(f.dataDir, "agent", "repos", f.project.project_id);
  work = join(f.dataDir, "agent", "worktrees", f.project.project_id, "A-1");
  const local = new LocalGitTransport();
  await local.ensureClone(repo, base);
  await local.addWorktree(base, work, farmBase, "agent/C-1/W-1");
  assignment = {
    id: "A-1" as never,
    scope: "work_item",
    work_item_id: "W-1" as never,
    role_id: "coder",
    role_version: 1,
    status: "active",
    runtime_state: "not_provisioned",
    machine_id: "local",
    runtime_ref: null,
    mcp_token_id: "reserved",
    created_at: "2030-01-01T00:00:00.000Z",
    branch: "agent/C-1/W-1",
    worktree_path: work,
    base_sha: farmBase,
  };
});
afterEach(async () => f.close());

test("C-654: own changes are measured against the card baseline after merging it, not the project baseline", async () => {
  await authorCommit("app.ts", "export const answer = 42;\n");
  const merged = await sourceCommit(farm, "tools/android/build.gradle", "x\n");
  const sha = await mergeFarm();

  const evidence = await verify(sha, farm);
  expect(detail(evidence, "own_path_inventory")).toEqual({
    version: 1,
    sha,
    tree_sha: await git(work, "rev-parse", `${sha}^{tree}`),
    base_sha: merged,
    baseline_sha: merged,
    assignment_base_sha: farmBase,
    complete: true,
    paths: ["app.ts"],
  });
  // Audit: the full inventory and commit evidence keep the Assignment baseline.
  expect(evidence.find((e) => e.kind === "commit")?.details).toMatchObject({
    base_sha: farmBase,
  });
  expect(detail(evidence, "role_rule_inventory")).toMatchObject({
    base_sha: farmBase,
  });
  const full = detail(evidence, "role_rule_inventory")?.changes as {
    path: string;
  }[];
  expect(full.map((c) => c.path).sort()).toEqual([
    "app.ts",
    "tools/android/build.gradle",
  ]);

  // Measured against the project baseline (main shares only history older
  // than the Assignment baseline) nothing is excluded: the card-baseline
  // change still counts as the author's, as it did before C-654.
  const fromMain = detail(await verify(sha), "own_path_inventory");
  expect(fromMain?.base_sha).toBe(f.initial);
  expect(fromMain?.paths).toContain("tools/android/build.gradle");
});

test("C-654: a card baseline that moved on after the author merged it starts from the merge base", async () => {
  await authorCommit("app.ts", "export const answer = 42;\n");
  const merged = await sourceCommit(farm, "tools/android/build.gradle", "x\n");
  const sha = await mergeFarm();
  const later = await sourceCommit(farm, "tools/android/later.gradle", "y\n");
  expect(await git(repo, "rev-parse", `refs/heads/${farm}`)).toBe(later);

  expect(detail(await verify(sha, farm), "own_path_inventory")).toMatchObject({
    base_sha: merged,
    baseline_sha: later,
    assignment_base_sha: farmBase,
    complete: true,
    paths: ["app.ts"],
  });
});

test("C-654: high-risk paths the author changed stay in the own inventory", async () => {
  await authorCommit("tools/android/signing.gradle", "author\n");
  await sourceCommit(farm, "tools/android/build.gradle", "x\n");
  const sha = await mergeFarm();
  await sourceCommit(farm, "later.txt", "y\n");
  const own = detail(await verify(sha, farm), "own_path_inventory");
  expect(own).toMatchObject({ assignment_base_sha: farmBase, complete: true });
  expect(own?.paths).toEqual(["tools/android/signing.gradle"]);
});

test("C-654: a branch that never merged the moved card baseline keeps only the full Assignment inventory", async () => {
  const sha = await authorCommit("app.ts", "export const answer = 42;\n");
  await sourceCommit(farm, "tools/android/build.gradle", "x\n");
  const evidence = await verify(sha, farm);
  // The merge base is the Assignment baseline: nothing to exclude.
  expect(detail(evidence, "own_path_inventory")).toBeUndefined();
  expect(detail(evidence, "role_rule_inventory")).toMatchObject({
    base_sha: farmBase,
    complete: true,
  });
});

test("C-654: an invalid card baseline branch name is rejected", () => {
  expect(() => new GitDeliveryVerifier(central, f.project, "../main")).toThrow(
    /Invalid card baseline/u,
  );
});
