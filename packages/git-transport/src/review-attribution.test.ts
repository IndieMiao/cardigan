import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { attributeReviewChanges } from "@cardigan/git-service";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CentralGitTransport } from "./central.js";

const exec = promisify(execFile);
let root: string, source: string, repo: string, initial: string;
let transport: CentralGitTransport;
const git = async (...args: string[]) =>
  (
    await exec(
      "git",
      [
        "-C",
        source,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { timeout: 15000 },
    )
  ).stdout.trim();
async function commit() {
  await git("add", "-A");
  await git("commit", "-m", "fixture");
  return git("rev-parse", "HEAD");
}
async function edit(path: string, text: string) {
  await writeFile(join(source, path), text);
  return commit();
}
async function proof(old_sha = initial, baseline_sha = initial) {
  const new_sha = await git("rev-parse", "HEAD");
  await transport.fetchRefs(repo, source, ["+refs/heads/*:refs/heads/*"]);
  return attributeReviewChanges(transport, repo, {
    old_sha,
    new_sha,
    baseline_sha,
  });
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cardigan-review-attribution-"));
  source = join(root, "source");
  await mkdir(source);
  await git("init", "-b", "main");
  await mkdir(join(source, "test-support"));
  await writeFile(join(source, "test-support/fixture.txt"), "old fixture\n");
  await writeFile(join(source, "example.test.ts"), "old test\n");
  initial = await edit("production.ts", "old production\n");
  await git("checkout", "-b", "work");
  transport = new CentralGitTransport({ dataDir: root });
  repo = join(root, "central", "review.git");
  await transport.ensureBare(source, repo, "refs/heads/main");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("records exact chronological ranges and fixture paths from fixed center commits", async () => {
  const first = await edit("example.test.ts", "new test\n");
  const head = await edit("test-support/fixture.txt", "new fixture\n");
  const result = await proof();
  expect(result).toEqual({
    status: "attributed",
    proof: {
      old_sha: initial,
      new_sha: head,
      baseline_sha: initial,
      old_tree: await transport.treeOfCommit(repo, initial),
      new_tree: await transport.treeOfCommit(repo, head),
      baseline_tree: await transport.treeOfCommit(repo, initial),
      ranges: [
        { base: initial, head: first, files: ["example.test.ts"] },
        { base: first, head, files: ["test-support/fixture.txt"] },
      ],
      files: ["example.test.ts", "test-support/fixture.txt"],
      baseline_merges: [],
    },
  });
});

test("keeps transient production edits even when the final net diff only changes tests", async () => {
  await edit("production.ts", "temporary production\n");
  await edit("production.ts", "old production\n");
  await edit("example.test.ts", "new test\n");
  expect(await proof()).toMatchObject({
    status: "attributed",
    proof: {
      files: ["example.test.ts", "production.ts"],
      ranges: [
        { files: ["production.ts"] },
        { files: ["production.ts"] },
        { files: ["example.test.ts"] },
      ],
    },
  });
});

test("a rename reports both paths; attribution does not classify production as tests", async () => {
  await rename(join(source, "example.test.ts"), join(source, "renamed.ts"));
  await commit();
  expect(await proof()).toMatchObject({
    status: "attributed",
    proof: { files: ["example.test.ts", "renamed.ts"] },
  });
});

test("a deleted regular fixture stays in the attributed paths", async () => {
  await rm(join(source, "test-support/fixture.txt"));
  await commit();
  expect(await proof()).toMatchObject({
    status: "attributed",
    proof: {
      files: ["test-support/fixture.txt"],
    },
  });
});

test("excludes only a trusted, clean baseline merge whose recomputed tree matches", async () => {
  const first = await edit("example.test.ts", "new test\n");
  await git("checkout", "main");
  const baseline = await edit("production.ts", "baseline production\n");
  await git("checkout", "work");
  await git("merge", "--no-ff", "-m", "merge baseline", "main");
  const merge = await git("rev-parse", "HEAD");
  const last = await edit("test-support/fixture.txt", "new fixture\n");
  expect(await proof(initial, baseline)).toMatchObject({
    status: "attributed",
    proof: {
      new_sha: last,
      files: ["example.test.ts", "test-support/fixture.txt"],
      baseline_merges: [
        { commit: merge, first_parent: first, baseline_parent: baseline },
      ],
    },
  });
});

test("baseline production imports of a fixture remain visible in the complete new tree", async () => {
  await edit("test-support/fixture.txt", "new fixture\n");
  await git("checkout", "main");
  const baseline = await edit(
    "production.ts",
    "import './test-support/fixture.txt';\n",
  );
  await git("checkout", "work");
  await git("merge", "--no-ff", "-m", "merge baseline", "main");
  const result = await proof(initial, baseline);
  expect(result).toMatchObject({
    status: "attributed",
    proof: { files: ["test-support/fixture.txt"] },
  });
  // This proves why attribution alone must never grant test isolation.
  if (result.status !== "attributed") throw new Error("Missing attribution");
  expect(
    await transport.readTreeFile(repo, result.proof.new_sha, "production.ts"),
  ).toContain("import './test-support/fixture.txt'");
  expect(result.proof.new_tree).not.toEqual(result.proof.old_tree);
});

test("manual production conflict resolution forces full review", async () => {
  await edit("production.ts", "own production\n");
  await git("checkout", "main");
  const baseline = await edit("production.ts", "baseline production\n");
  await git("checkout", "work");
  await expect(
    git("merge", "--no-ff", "-m", "conflict", "main"),
  ).rejects.toThrow();
  await edit("production.ts", "manually resolved production\n");
  expect(await proof(initial, baseline)).toEqual({
    status: "full_review",
    reason: "merge_not_equivalent",
  });
});

test("extra manual changes during a clean baseline merge cannot be attributed to baseline", async () => {
  await edit("example.test.ts", "new test\n");
  await git("checkout", "main");
  const baseline = await edit("production.ts", "baseline production\n");
  await git("checkout", "work");
  await git("merge", "--no-ff", "--no-commit", "main");
  await edit("production.ts", "extra production edit\n");
  expect(await proof(initial, baseline)).toEqual({
    status: "full_review",
    reason: "merge_not_equivalent",
  });
});

test("an unknown side branch is not a trusted baseline merge", async () => {
  await edit("example.test.ts", "new test\n");
  await git("checkout", "-b", "side", initial);
  await edit("production.ts", "untrusted production\n");
  await git("checkout", "work");
  await git("merge", "--no-ff", "-m", "side branch", "side");
  expect(await proof()).toEqual({
    status: "full_review",
    reason: "untrusted_merge",
  });
});

test("baseline-only and empty changes do not create a test increment", async () => {
  expect(await proof()).toEqual({
    status: "full_review",
    reason: "no_own_changes",
  });
  await git("checkout", "main");
  const baseline = await edit("production.ts", "baseline production\n");
  await git("checkout", "work");
  await git("merge", "--no-ff", "-m", "baseline only", "main");
  expect(await proof(initial, baseline)).toEqual({
    status: "full_review",
    reason: "no_own_changes",
  });
});

test.each(["mode", "symlink"])(
  "rejects a disguised test %s change",
  async (kind) => {
    if (kind === "mode") await chmod(join(source, "example.test.ts"), 0o755);
    else {
      await rm(join(source, "example.test.ts"));
      await symlink("production.ts", join(source, "example.test.ts"));
    }
    await commit();
    expect(await proof()).toEqual({
      status: "full_review",
      reason: "unsupported_entry",
    });
  },
);

test("a test-named submodule is not a regular test file", async () => {
  await git(
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${initial},module.test.ts`,
  );
  await git("commit", "-m", "submodule fixture");
  expect(await proof()).toEqual({
    status: "full_review",
    reason: "unsupported_entry",
  });
});

test("control characters in paths cannot reach a review prompt", async () => {
  await edit("misleading\nproduction.test.ts", "test\n");
  expect(await proof()).toEqual({
    status: "full_review",
    reason: "unsupported_entry",
  });
});

test("literal pathspec characters in fixture directories are read literally", async () => {
  await mkdir(join(source, "[fixtures]"));
  await edit("[fixtures]/example.test.ts", "test\n");
  expect(await proof()).toMatchObject({
    status: "attributed",
    proof: {
      files: ["[fixtures]/example.test.ts"],
    },
  });
});

test("an octopus merge is unsupported even when all side parents are baseline ancestors", async () => {
  await edit("example.test.ts", "new test\n");
  await git("checkout", "-b", "side-one", initial);
  await edit("one.ts", "production one\n");
  await git("checkout", "-b", "side-two", initial);
  await edit("two.ts", "production two\n");
  await git("checkout", "main");
  await git(
    "merge",
    "--no-ff",
    "-m",
    "trusted baseline",
    "side-one",
    "side-two",
  );
  const baseline = await git("rev-parse", "HEAD");
  await git("checkout", "work");
  await git(
    "merge",
    "--no-ff",
    "-m",
    "unsupported merge",
    "side-one",
    "side-two",
  );
  expect(await proof(initial, baseline)).toEqual({
    status: "full_review",
    reason: "history_not_supported",
  });
});

test("an unavailable Git operation fails closed without exposing its error", async () => {
  await edit("example.test.ts", "new test\n");
  await transport.fetchRefs(repo, source, ["+refs/heads/*:refs/heads/*"]);
  const unavailable = Object.create(transport) as CentralGitTransport;
  unavailable.changedPaths = async () => {
    throw new Error("private Git diagnostic");
  };
  expect(
    await attributeReviewChanges(unavailable, repo, {
      old_sha: initial,
      new_sha: await git("rev-parse", "HEAD"),
      baseline_sha: initial,
    }),
  ).toEqual({ status: "full_review", reason: "git_read_failed" });
});

test("versions are fixed before asynchronous object reads", async () => {
  const head = await edit("example.test.ts", "new test\n");
  await transport.fetchRefs(repo, source, ["+refs/heads/*:refs/heads/*"]);
  const input = { old_sha: initial, new_sha: head, baseline_sha: initial };
  const observing = Object.create(transport) as CentralGitTransport;
  observing.treeOfCommit = async (repository, sha) => {
    input.new_sha = initial;
    return transport.treeOfCommit(repository, sha);
  };
  expect(await attributeReviewChanges(observing, repo, input)).toMatchObject({
    status: "attributed",
    proof: {
      old_sha: initial,
      new_sha: head,
      baseline_sha: initial,
    },
  });
});

test("rewritten first-parent history, missing objects and malformed versions fail closed", async () => {
  const old = await edit("example.test.ts", "old review\n");
  await git("branch", "previous-delivery", old);
  await git("reset", "--hard", initial);
  await edit("example.test.ts", "rewritten review\n");
  expect(await proof(old)).toEqual({
    status: "full_review",
    reason: "history_not_supported",
  });
  expect(await proof("f".repeat(40))).toEqual({
    status: "full_review",
    reason: "git_read_failed",
  });
  expect(await proof("HEAD")).toEqual({
    status: "full_review",
    reason: "invalid_sha",
  });
  expect(await proof("a".repeat(64))).toEqual({
    status: "full_review",
    reason: "invalid_sha",
  });
});
