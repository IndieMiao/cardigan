import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  autoRiskPaths,
  highRiskProducts,
  prepareDelivery,
  submitDelivery,
} from "@cardigan/domain";
import { unwrap } from "@cardigan/mcp-server";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ServerGit } from "./git.js";
import { m4Fixture, m4Scenario } from "./m4-fixtures.js";

/**
 * C-654: the server measures the author's own changes against the card's
 * baseline branch, not the project baseline, so a card baseline merged into
 * the author's branch (even one that later moved on) is not author risk.
 */
const farm = "integration/farm";
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();
function write(root: string, path: string, text: string) {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
  git(root, "add", path);
  git(root, "commit", "-qm", path);
  return git(root, "rev-parse", "HEAD");
}
let f: ReturnType<typeof m4Fixture>;
beforeEach(() => {
  f = m4Fixture();
});
afterEach(() => f.close());

async function deliver(authorHighRisk: boolean) {
  const source = join(f.dataDir, "source");
  git(f.dataDir, "init", "-q", "-b", "main", source);
  write(source, ".github/ci.yml", "fixture\n");
  git(source, "switch", "-qc", farm);
  const farmBase = write(source, "farm.txt", "farm\n");
  git(source, "switch", "-q", "main");
  write(source, "main-only.txt", "main\n");
  f.store.setProjectRepo({
    project_id: f.project_id,
    repo_path: source,
    base_branch: "main",
  });
  const scenario = m4Scenario(f, "confirm", farm);
  const repository = join(f.dataDir, "agent", "repos", f.project_id);
  mkdirSync(join(repository, ".."), { recursive: true });
  git(f.dataDir, "clone", "-q", source, repository);
  const worktree = join(f.dataDir, "worktrees", scenario.coder.id);
  const branch = "agent/test/card-baseline";
  git(repository, "worktree", "add", "-q", "-b", branch, worktree, farmBase);
  write(worktree, "app.ts", "export const answer = 42;\n");
  if (authorHighRisk) write(worktree, ".github/author.yml", "author\n");
  // Another card's high-risk change lands on the card baseline; the author
  // merges it, then the baseline moves on once more.
  git(source, "switch", "-q", farm);
  write(source, ".github/ci.yml", "merged by another card\n");
  git(source, "switch", "-q", "main");
  git(worktree, "fetch", "-q", "origin", farm);
  git(worktree, "merge", "-q", "--no-edit", "FETCH_HEAD");
  const sha = git(worktree, "rev-parse", "HEAD");
  git(source, "switch", "-q", farm);
  const later = write(source, "later.txt", "later\n");
  git(source, "switch", "-q", "main");

  const serverGit = new ServerGit({ store: f.store, dataDir: f.dataDir });
  const project = serverGit.projectOf(f.project_id);
  if (!project) throw new Error("missing project");
  await serverGit.sync(project);
  await serverGit.sync({ ...project, base_branch: farm });
  f.startRun(scenario.coder, { path: worktree, branch });
  f.store.uow.run((tx) => {
    const a = tx.assignments.get(f.project_id, scenario.coder.id);
    if (!a) throw new Error("missing fixture assignment");
    tx.assignments.put(f.project_id, { ...a, base_sha: farmBase });
  });
  const params = {
    work_item_id: scenario.development.id,
    kind: "code" as const,
    summary: "Fixture delivery",
    subject: { kind: "git_head" as const, value: sha },
    requested_verifiers: [scenario.codeReview.id],
  };
  const actor = f.actorFor(scenario.coder);
  const receipt = unwrap(
    await prepareDelivery(
      f.state(),
      actor,
      params,
      serverGit.verifierFor(f.project_id),
    ),
  );
  const delivery = f.apply(
    (s, a, p) => submitDelivery(s, a, params, receipt, p),
    actor,
  );
  return { delivery, scenario, farmBase, later };
}

test("C-654: a merged card baseline is not counted as the author's high-risk change", async () => {
  const { delivery, scenario, farmBase, later } = await deliver(false);
  expect(autoRiskPaths(delivery)).toEqual(["app.ts"]);
  const own = delivery.evidence.find((e) => e.details.own_path_inventory)
    ?.details.own_path_inventory;
  expect(own).toMatchObject({
    baseline_sha: later,
    assignment_base_sha: farmBase,
  });
  expect(
    highRiskProducts(f.state(), f.card(scenario.card.id)).map((d) => d.id),
  ).toEqual([]);
  expect(f.card(scenario.card.id).risk_tags ?? []).toEqual([]);
});

test("C-654: the author's own high-risk change still requires independent review", async () => {
  const { delivery, scenario } = await deliver(true);
  expect(autoRiskPaths(delivery)).toEqual([".github/author.yml", "app.ts"]);
  expect(
    highRiskProducts(f.state(), f.card(scenario.card.id)).map((d) => d.id),
  ).toEqual([scenario.development.id]);
  expect(f.card(scenario.card.id).risk_tags).toEqual(["security"]);
});
