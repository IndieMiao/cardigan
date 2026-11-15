import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestReviewCandidate, TestReviewProof } from "@cardigan/domain";
import { afterEach, expect, test } from "vitest";
import { centralFixture, git } from "../../git-transport/test-support/git.js";
import {
  HostTestReviewTrust,
  parseTestReviewPolicy,
  readTestReviewPolicy,
  type TestIsolationSource,
} from "./test-review.js";

let f: Awaited<ReturnType<typeof centralFixture>> | undefined;
afterEach(async () => {
  await f?.close();
});
const policyText =
  "project_id: project\nversion: v1\nsource_version: fixture-v1\ntest_files:\n  - tests/assert.test.ts\n  - tests/fixture.json\n";
test.each([
  "test_files: ['*.test.ts']",
  "test_files: ['../test.ts']",
  "test_files: ['tests/']",
  "test_files: [x, x]",
  "test_files: []",
  "version: a\nversion: b",
])("policy refuses ambiguous or broad paths: %s", (override) => {
  expect(() =>
    parseTestReviewPolicy(`${policyText}\n${override}\n`, "project"),
  ).toThrow();
});
test("policy accepts only explicit project-bound paths", () => {
  expect(parseTestReviewPolicy(policyText, "project").test_files).toEqual([
    "tests/assert.test.ts",
    "tests/fixture.json",
  ]);
  expect(() => parseTestReviewPolicy(policyText, "other")).toThrow();
});

/** Synthetic source contract. Real Git and filesystem IO, NO production isolation claim. */
async function setup() {
  f = await centralFixture();
  const x = f;
  await mkdir(join(x.source, "tests"));
  await writeFile(join(x.source, "tests/assert.test.ts"), "assert(true)\n");
  await writeFile(join(x.source, "tests/fixture.json"), "{}\n");
  await writeFile(join(x.source, "production.ts"), "export const n = 1\n");
  await git(x.source, "add", ".");
  await git(x.source, "commit", "-m", "base");
  const old = await git(x.source, "rev-parse", "HEAD");
  const repo = await x.central.ensureCentral(x.project);
  await git(repo, "update-ref", "refs/cardigan/deliveries/D-1", old);
  await git(x.source, "switch", "-c", "feature");
  await writeFile(join(x.source, "tests/assert.test.ts"), "assert(1 === 1)\n");
  await git(x.source, "add", ".");
  await git(x.source, "commit", "-m", "test");
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("POSIX fixture required");
  const directory = join(x.root, "policy");
  await mkdir(directory, { mode: 0o700 });
  const file = join(directory, "review.yaml");
  await writeFile(file, policyText, { mode: 0o600 });
  let sourceValid = true;
  let generation = "identity-1";
  let productionInputs = ["production.ts"];
  let unknownReads = false;
  let sameUid = false;
  let collected: readonly string[] = [];
  const source: TestIsolationSource = {
    // Synthetic identities exercise POSIX boundary code; they are not evidence
    // that this test process or any actual deployed Agent has been isolated.
    policyBoundary: () => ({
      owner_uid: uid,
      untrusted_uids: [sameUid ? uid : uid + 10000],
      generation,
    }),
    collect: async (input) => {
      collected = input.entries.map((e) => e.path);
      return unknownReads
        ? undefined
        : {
            generation: "runtime-1",
            source_version: "fixture-v1",
            input_digest: "a".repeat(64),
            production_inputs: productionInputs,
          };
    },
    isCurrent: () => sourceValid,
  };
  const options = {
    git: x.transport,
    repository: () => repo,
    baseline: () => x.transport.readRef(repo, "refs/heads/main"),
    pinned: () => x.transport.readRef(repo, "refs/cardigan/deliveries/D-1"),
    policyFile: () => file,
    source,
  };
  const trust = new HostTestReviewTrust(options);
  async function candidate(): Promise<TestReviewCandidate> {
    await git(
      repo,
      "fetch",
      x.source,
      "+refs/heads/main:refs/heads/main",
      "+refs/heads/feature:refs/heads/feature",
    );
    return {
      project_id: "project",
      work_item_id: "W-1",
      verifier_id: "W-2",
      assignment_id: "A-2",
      previous_delivery_id: "D-1",
      previous_review_id: "V-1",
      context: "fixture",
      old_sha: old,
      old_tree: await x.transport.treeOfCommit(repo, old),
      new_sha: await git(repo, "rev-parse", "feature"),
      base_branch: "main",
    };
  }
  return {
    x,
    repo,
    file,
    directory,
    source,
    options,
    trust,
    candidate,
    get collected() {
      return collected;
    },
    revoke() {
      sourceValid = false;
    },
    changeGeneration() {
      generation = "identity-2";
    },
    unknown() {
      unknownReads = true;
    },
    local() {
      sameUid = true;
    },
    production(paths: string[]) {
      productionInputs = paths;
    },
  };
}
test("synthetic source contract composes real pinned Git, full-tree IO and protected policy; restart cannot revive it", async () => {
  const t = await setup();
  const proof = await t.trust.prepare(await t.candidate());
  expect(proof?.files).toEqual(["tests/assert.test.ts"]);
  expect(t.collected).toContain("production.ts");
  expect(t.collected).toContain("tests/fixture.json");
  expect(t.trust.isCurrent(proof as TestReviewProof)).toBe(true);
  expect(
    new HostTestReviewTrust(t.options).isCurrent(proof as TestReviewProof),
  ).toBe(false);
  expect(
    t.trust.isCurrent({
      ...proof,
      input_digest: "b".repeat(64),
    } as TestReviewProof),
  ).toBe(false);
  t.revoke();
  expect(t.trust.isCurrent(proof as TestReviewProof)).toBe(false);
});
test("a clean baseline merge that makes an old fixture a production input is rejected on the complete new tree", async () => {
  const t = await setup();
  await git(t.x.source, "switch", "main");
  await writeFile(
    join(t.x.source, "production.ts"),
    "import fixture from './tests/fixture.json';\n",
  );
  await git(t.x.source, "add", ".");
  await git(t.x.source, "commit", "-m", "consume fixture");
  await git(t.x.source, "switch", "feature");
  await git(t.x.source, "merge", "--no-edit", "main");
  t.production(["production.ts", "tests/fixture.json"]);
  expect(await t.trust.prepare(await t.candidate())).toBeUndefined();
  expect(t.collected).toContain("tests/fixture.json");
});
test.each([
  "unknown-read",
  "local-uid",
  "mutable-parent",
  "symlink-policy",
  "production-change",
  "no-source",
  "no-pin",
])("%s fails closed using real Git/files", async (kind) => {
  const t = await setup();
  if (kind === "unknown-read") t.unknown();
  if (kind === "local-uid") t.local();
  if (kind === "mutable-parent") await chmod(t.directory, 0o777);
  if (kind === "symlink-policy") {
    const target = join(t.directory, "target");
    await writeFile(target, policyText);
    await import("node:fs/promises").then((fs) => fs.unlink(t.file));
    await symlink(target, t.file);
  }
  if (kind === "production-change") {
    await writeFile(join(t.x.source, "production.ts"), "changed\n");
    await git(t.x.source, "add", ".");
    await git(t.x.source, "commit", "-m", "production");
  }
  if (kind === "no-pin")
    await git(t.repo, "update-ref", "-d", "refs/cardigan/deliveries/D-1");
  const trust =
    kind === "no-source"
      ? new HostTestReviewTrust({ ...t.options, source: undefined } as never)
      : t.trust;
  expect(await trust.prepare(await t.candidate())).toBeUndefined();
});
test("policy bytes and boundary generations are re-read at consumption", async () => {
  const t = await setup();
  const proof = (await t.trust.prepare(await t.candidate())) as TestReviewProof;
  expect(t.trust.isCurrent(proof)).toBe(true);
  await writeFile(t.file, policyText.replace("v1\n", "v2\n"));
  expect(t.trust.isCurrent(proof)).toBe(false);
  await writeFile(t.file, policyText);
  expect(t.trust.isCurrent(proof)).toBe(false);
  const next = (await t.trust.prepare(await t.candidate())) as TestReviewProof;
  t.changeGeneration();
  expect(t.trust.isCurrent(next)).toBe(false);
});
test("the filesystem loader refuses same-UID authority without relying on MCP tools", async () => {
  const t = await setup();
  expect(readTestReviewPolicy(t.file, "project", t.source).policy.version).toBe(
    "v1",
  );
  t.local();
  expect(() => readTestReviewPolicy(t.file, "project", t.source)).toThrow();
});
