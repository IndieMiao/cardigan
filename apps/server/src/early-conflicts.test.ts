import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EARLY_MERGE_CONFLICT } from "@cardigan/domain";
import type {
  RepositoryLock,
  RepositoryLockSample,
} from "@cardigan/git-service";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { m3Fixture } from "../test-support/m3-acceptance.js";
import { routeProjectEvents } from "./dispatch-inbox.js";
import {
  EARLY_CONFLICT_RETRY_MS,
  EarlyConflictObserver,
  pathsOverlap,
} from "./early-conflicts.js";
import { ServerGit } from "./git.js";
import { m4Fixture } from "./m4-fixtures.js";

const baseline = "b".repeat(40);
let f: ReturnType<typeof m3Fixture>;
beforeEach(() => {
  f = m3Fixture();
});
afterEach(() => f.close());

function fakeGit(conflicts: readonly string[] = ["a.ts"]) {
  let base = baseline;
  return {
    move: (sha: string) => {
      base = sha;
    },
    projectOf: () => ({
      project_id: f.id,
      source_repo: "/fixture/source",
      base_branch: "main",
    }),
    baseline: vi.fn(async () => base),
    deliveryChangedPaths: vi.fn(async () => ["a.ts", "b.ts"]),
    trialMerge: vi.fn(async () => conflicts),
  };
}
const early = () =>
  f.state().events.filter((e) => e.type === EARLY_MERGE_CONFLICT);
async function delivered() {
  f.start(f.coder);
  const product = (await f.delivery()).data;
  f.finish(f.coder);
  return product;
}

test("C-782: a moved baseline tells the idle author of a delivered head once, and wakes only that author", async () => {
  const product = await delivered();
  const git = fakeGit();
  const observer = new EarlyConflictObserver(f.store, git as never, f.clock);
  const before = f.state();
  await observer.tick(f.id);
  await observer.tick(f.id);
  expect(git.trialMerge).toHaveBeenCalledOnce();
  expect(git.trialMerge).toHaveBeenCalledWith(
    git.projectOf(),
    baseline,
    product.subject.value,
  );
  expect(early()).toHaveLength(1);
  expect(early()[0]?.payload).toMatchObject({
    delivery_id: product.id,
    baseline_sha: baseline,
    files: ["a.ts"],
  });
  expect(f.state().cards).toEqual(before.cards);
  expect(f.state().work_items).toEqual(before.work_items);
  expect(f.state().reviews).toEqual(before.reviews);
  // Further main advances for the same delivery are folded into that notice.
  git.move("c".repeat(40));
  await observer.tick(f.id);
  expect(early()).toHaveLength(1);
  expect(git.trialMerge).toHaveBeenCalledOnce();
  routeProjectEvents(f.store, f.id, { clock: f.clock });
  expect(
    f.store
      .listNotifications({ project_id: f.id })
      .filter((n) => n.event_id === early()[0]?.id),
  ).toMatchObject([
    {
      recipient: { kind: "assignment", assignment_id: f.coder.id },
      kind: "instruction",
    },
  ]);
});

test("C-782: an author with a running Run is not probed or told until it ends", async () => {
  await delivered();
  f.start(f.coder);
  const git = fakeGit();
  const observer = new EarlyConflictObserver(f.store, git as never, f.clock);
  await observer.tick(f.id);
  expect(git.baseline).not.toHaveBeenCalled();
  expect(early()).toEqual([]);
  f.finish(f.coder);
  await observer.tick(f.id);
  expect(early()).toHaveLength(1);
});

test("C-782: without overlapping paths, or with a clean trial merge, nothing is recorded", async () => {
  await delivered();
  const disjoint = fakeGit();
  disjoint.deliveryChangedPaths
    .mockResolvedValueOnce(["author.ts"])
    .mockResolvedValueOnce(["main.ts"]);
  await new EarlyConflictObserver(f.store, disjoint as never, f.clock).tick(
    f.id,
  );
  expect(disjoint.trialMerge).not.toHaveBeenCalled();
  const clean = fakeGit([]);
  await new EarlyConflictObserver(f.store, clean as never, f.clock).tick(f.id);
  expect(clean.trialMerge).toHaveBeenCalledOnce();
  expect(early()).toEqual([]);
});

test("C-782: a baseline move during the probes discards them until the next tick", async () => {
  await delivered();
  const git = fakeGit();
  git.trialMerge.mockImplementationOnce(async () => {
    git.move("c".repeat(40));
    return ["a.ts"];
  });
  const observer = new EarlyConflictObserver(f.store, git as never, f.clock);
  await observer.tick(f.id);
  expect(early()).toEqual([]);
  await observer.tick(f.id);
  expect(early()[0]?.payload).toMatchObject({ baseline_sha: "c".repeat(40) });
});

test("C-782: Git failures record nothing and are retried after a pause", async () => {
  await delivered();
  const git = fakeGit();
  git.trialMerge.mockRejectedValueOnce(new Error("fatal: raw diagnostics"));
  const observer = new EarlyConflictObserver(f.store, git as never, f.clock);
  await observer.tick(f.id);
  expect(early()).toEqual([]);
  await observer.tick(f.id);
  expect(git.trialMerge).toHaveBeenCalledOnce();
  f.advance(EARLY_CONFLICT_RETRY_MS);
  await observer.tick(f.id);
  expect(git.trialMerge).toHaveBeenCalledTimes(2);
  expect(early()).toHaveLength(1);
  expect(JSON.stringify(early())).not.toContain("raw diagnostics");
});

test.each([
  [["a.ts"], ["a.ts"], true],
  [["src/a.ts"], ["src"], true],
  [["src"], ["src/a.ts"], true],
  [["src/a.ts"], ["src/b.ts"], false],
  [["srcx/a.ts"], ["src"], false],
])("C-782: %j and %j overlap: %s", (left, right, expected) => {
  expect(pathsOverlap(left, right)).toBe(expected);
});

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

test("C-782: the real trial merge reports conflicts while the project repository lock is held, takes no lock and writes nothing to the center", async () => {
  const m4 = m4Fixture();
  const root = mkdtempSync(join(tmpdir(), "cardigan-early-conflict-"));
  try {
    const dataDir = join(root, "data"),
      source = join(root, "source");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    git(root, "init", "-q", "-b", "main", source);
    writeFileSync(join(source, "README.md"), "base\n");
    git(source, "add", "README.md");
    git(source, "commit", "-qm", "init");
    const initial = git(source, "rev-parse", "HEAD");
    m4.store.setProjectRepo({
      project_id: m4.project_id,
      repo_path: source,
      base_branch: "main",
    });
    const samples: RepositoryLockSample[] = [];
    const observed = new ServerGit({
      store: m4.store,
      dataDir,
      onLockSample: (sample) => samples.push(sample),
    });
    const project = observed.projectOf(m4.project_id);
    if (!project) throw new Error("Missing fixture project");
    writeFileSync(join(source, "README.md"), "main\n");
    git(source, "commit", "-qam", "main");
    await observed.sync(project);
    const base = await observed.baseline(project);
    // An author head forked from the initial commit, written straight into the center.
    const repository = join(dataDir, "central", `${m4.project_id}.git`);
    const blob = execFileSync(
      "git",
      ["-C", repository, "hash-object", "-w", "--stdin"],
      { input: "author\n", encoding: "utf8" },
    ).trim();
    const tree = execFileSync("git", ["-C", repository, "mktree"], {
      input: `100644 blob ${blob}\tREADME.md\n`,
      encoding: "utf8",
    }).trim();
    const head = git(repository, "commit-tree", tree, "-p", initial, "-m", "a");
    const refs = () =>
      git(repository, "for-each-ref", "--format=%(refname) %(objectname)");
    const refsBefore = refs();
    const objects = () => git(repository, "count-objects", "-v");
    const objectsBefore = objects();
    // Its own in-process queue and (on Linux) flock: a waiting trial merge would hang here.
    const lock = (observed as unknown as { lock: RepositoryLock }).lock;
    const held = Promise.withResolvers<void>();
    const holding = lock(
      { project_id: m4.project_id, repository, operation: "probe" },
      () => held.promise,
    );
    try {
      await expect(observed.trialMerge(project, base, head)).resolves.toEqual([
        "README.md",
      ]);
      await expect(
        observed.trialMerge(project, base, initial),
      ).resolves.toEqual([]);
    } finally {
      held.resolve();
      await holding;
    }
    expect(samples.map((sample) => sample.operation)).toEqual(["probe"]);
    // No ref moved or appeared, and the merge objects went to a removed scratch directory.
    expect(refs()).toBe(refsBefore);
    expect(objects()).toBe(objectsBefore);
    expect(
      readdirSync(join(dataDir, "central")).filter((n) =>
        n.startsWith(".trial-merge-"),
      ),
    ).toEqual([]);
  } finally {
    m4.close();
    rmSync(root, { recursive: true, force: true });
  }
});
