/**
 * M4.4 reconciliation and backup loops (plan §3.6, §3.7; §12.6).
 *
 * Real Git in temporary repositories: findings come from comparing the base
 * clone, the worktree directory and the database, a Git delivery without its
 * fixed ref is repaired from the candidate ref, and the backup fetch moves
 * `agent/*` into the central repository without touching business state.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CentralProject,
  CentralRepositoryService,
} from "@cardigan/git-service";
import { CentralGitTransport } from "@cardigan/git-transport";
import { PROJECT_EVENT_STREAM } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ServerGit } from "./git.js";
import {
  acceptThroughMergeGate,
  type M4Fixture,
  type M4Scenario,
  m4Fixture,
  m4Scenario,
} from "./m4-fixtures.js";
import { BackupExecutor, ReconcileExecutor } from "./reconcile-loop.js";

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

let f: M4Fixture;
let scenario: M4Scenario;
let root: string;
let source: string;
let base: string;
let project: CentralProject;
let central: CentralRepositoryService;
let errors: string[];

const commitOn = (cwd: string, name: string, text: string) => {
  writeFileSync(join(cwd, name), text);
  git(cwd, "add", name);
  git(cwd, "commit", "-m", text);
  return git(cwd, "rev-parse", "HEAD");
};

beforeEach(() => {
  f = m4Fixture();
  root = mkdtempSync(join(tmpdir(), "cardigan-reconcile-"));
  source = join(root, "source");
  git(root, "init", "-q", "-b", "main", source);
  commitOn(source, "README.md", "fixture\n");
  f.store.setProjectRepo({
    project_id: f.project_id,
    repo_path: source,
    base_branch: "main",
  });
  project = {
    project_id: f.project_id,
    source_repo: source,
    base_branch: "main",
  };
  central = new CentralRepositoryService(
    new CentralGitTransport({ dataDir: f.dataDir }),
    { dataDir: f.dataDir },
  );
  base = join(f.dataDir, "agent", "repos", f.project_id);
  errors = [];
});
afterEach(() => {
  f.close();
  rmSync(root, { recursive: true, force: true });
});

const reconcile = () =>
  new ReconcileExecutor({
    store: f.store,
    git: new ServerGit({ store: f.store, dataDir: f.dataDir }),
    clock: f.clock,
    report: (message) => errors.push(message),
    onError: (error) => errors.push(String(error)),
  });

async function centralWithBaseClone() {
  scenario = m4Scenario(f, "auto");
  const repository = await central.ensureCentral(project);
  mkdirSync(join(f.dataDir, "agent", "repos"), { recursive: true });
  git(root, "clone", "-q", "--no-local", repository, base);
  return repository;
}

test("an orphan directory and a manual project directory are reported", async () => {
  await centralWithBaseClone();
  // A directory nobody owns, plus one left behind in the clone root.
  const orphan = join(f.dataDir, "agent", "worktrees", f.project_id, "A-9");
  mkdirSync(orphan, { recursive: true });
  mkdirSync(join(f.dataDir, "agent", "repos", ".clone-abc"), {
    recursive: true,
  });

  await reconcile().tick(f.project_id);
  const findings = f.store.listReconcileFindings(f.project_id, {
    openOnly: true,
  });
  expect(findings.map((finding) => finding.kind).sort()).toEqual([
    "failed_clone",
    "orphan_worktree",
  ]);
  expect(findings.find((entry) => entry.kind === "orphan_worktree")?.path).toBe(
    orphan,
  );
  // A new finding becomes one project-level event for PM Ops.
  const events = f.store.uow.read((tx) =>
    tx.events
      .listAfter(f.project_id, undefined, 0)
      .filter((event) => event.type === "reconcile_finding"),
  );
  expect(events).toHaveLength(2);
  expect(events.every((event) => event.card_id === undefined)).toBe(true);
  expect(f.store.routerCursor(f.project_id, PROJECT_EVENT_STREAM)).toBe(0);

  // The next pass does not announce the same findings again.
  await reconcile().tick(f.project_id);
  expect(
    f.store.uow.read((tx) =>
      tx.events
        .listAfter(f.project_id, undefined, 0)
        .filter((event) => event.type === "reconcile_finding"),
    ),
  ).toHaveLength(2);
  // Removing one resolves that finding instead of forgetting it.
  rmSync(orphan, { recursive: true, force: true });
  await reconcile().tick(f.project_id);
  const open = f.store.listReconcileFindings(f.project_id, { openOnly: true });
  expect(open.map((entry) => entry.kind)).toEqual(["failed_clone"]);
});

test("a Git delivery without a fixed ref is repaired from its candidate", async () => {
  const repository = await centralWithBaseClone();
  const agent = join(root, "agent-clone");
  git(root, "clone", "-q", source, agent);
  git(agent, "checkout", "-q", "-b", "agent/C-1/W-1");
  const sha = commitOn(agent, "feature.txt", "feature\n");
  const { product } = await acceptThroughMergeGate(f, scenario, sha);
  // Publish the object and the candidate ref, but deliberately not the delivery.
  await central.git.fetchRefs(repository, agent, [`+${sha}:${sha}`]);
  await central.createRef(
    repository,
    `refs/cardigan/candidates/${scenario.coder.id}/${sha}`,
    sha,
  );

  await reconcile().tick(f.project_id);
  const pinned = await central.pinnedDeliveries(project);
  expect(pinned.get(product.id)).toBe(sha);
  expect(
    f.store
      .listReconcileFindings(f.project_id, { openOnly: true })
      .some((finding) => finding.kind === "missing_delivery_ref"),
  ).toBe(false);
});

test("a diverged registered source is reported and moves no ref", async () => {
  const repository = await centralWithBaseClone();
  commitOn(source, "source.txt", "source side\n");
  // Move the central baseline the other way: a direct write, as a merge would.
  writeFileSync(join(base, "central.txt"), "central side\n");
  git(base, "add", "central.txt");
  git(base, "commit", "-m", "central side");
  const centralTip = git(base, "rev-parse", "HEAD");
  await central.git.fetchRefs(repository, base, [
    `+${centralTip}:refs/heads/main`,
  ]);
  await reconcile().tick(f.project_id);
  expect(
    f.store
      .listReconcileFindings(f.project_id, { openOnly: true })
      .map((finding) => finding.kind),
  ).toContain("source_diverged");
});

test("a missing active worktree is reported", async () => {
  await centralWithBaseClone();
  f.startRun(scenario.coder, {
    path: join(
      f.dataDir,
      "agent",
      "worktrees",
      f.project_id,
      scenario.coder.id,
    ),
    branch: "agent/C-1/W-1",
  });
  await reconcile().tick(f.project_id);
  expect(
    f.store
      .listReconcileFindings(f.project_id, { openOnly: true })
      .map((finding) => finding.kind),
  ).toContain("missing_worktree");
});

test("backup moves agent branches into the central repository", async () => {
  const repository = await centralWithBaseClone();
  git(base, "checkout", "-q", "-b", "agent/C-1/W-1");
  const sha = commitOn(base, "work.txt", "in progress\n");
  git(base, "checkout", "-q", "main");

  await new BackupExecutor({
    store: f.store,
    git: new ServerGit({ store: f.store, dataDir: f.dataDir }),
    report: (message) => errors.push(message),
  }).tick(f.project_id);

  expect(
    await central.git.readRef(
      repository,
      "refs/cardigan/backups/local/agent/C-1/W-1",
    ),
  ).toBe(sha);
  expect(errors).toEqual([]);
});

test("a failed backup is reported and leaves the previous one alone", async () => {
  const repository = await centralWithBaseClone();
  git(base, "checkout", "-q", "-b", "agent/C-1/W-1");
  const sha = commitOn(base, "work.txt", "in progress\n");
  git(base, "checkout", "-q", "main");
  const backup = new BackupExecutor({
    store: f.store,
    git: new ServerGit({ store: f.store, dataDir: f.dataDir }),
    report: (message) => errors.push(message),
  });
  await backup.tick(f.project_id);
  rmSync(base, { recursive: true, force: true });
  await backup.tick(f.project_id);
  expect(errors.length).toBeGreaterThan(0);
  expect(
    await central.git.readRef(
      repository,
      "refs/cardigan/backups/local/agent/C-1/W-1",
    ),
  ).toBe(sha);
});
