import { chmod, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestReviewProof } from "@cardigan/domain";
import {
  humanMergeBlockers,
  pmMergeBlockers,
  prepareMergePlan,
  submitDelivery,
} from "@cardigan/domain";
import { afterEach, expect, test } from "vitest";
import { actor, id } from "../../domain/src/commands/test-fixtures.js";
import { centralFixture, git } from "../../git-transport/test-support/git.js";
import {
  policyText,
  realReviewTrust,
  reviewedCompletion,
} from "../test-support/real-review.js";
import {
  HostTestReviewTrust,
  parseTestReviewPolicy,
  readTestReviewPolicy,
} from "./test-review.js";

let f: Awaited<ReturnType<typeof centralFixture>> | undefined;
afterEach(async () => {
  await f?.close();
});
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

async function setup(project = "project") {
  f = await centralFixture();
  return realReviewTrust(f, project);
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

test("a delivery behind the current center baseline cannot obtain a test proof", async () => {
  const t = await setup();
  await git(t.x.source, "switch", "main");
  await writeFile(
    join(t.x.source, "production.ts"),
    "import fixture from './tests/fixture.json';\n",
  );
  await git(t.x.source, "add", ".");
  await git(t.x.source, "commit", "-m", "consume old fixture");
  // The author has NOT merged this newer main into feature.
  const candidate = await t.candidate();
  expect(await t.trust.prepare(candidate)).toBeUndefined();
  expect(t.collected).toEqual([]);
});

test("baseline moves after proof revoke completion, PM/human confirmation and mergePlan using real Git", async () => {
  const t = await setup("fixture-project");
  const {
    candidate,
    d,
    product,
    decision,
    beforeCompletion,
    complete,
    receipt,
  } = await reviewedCompletion(t);
  expect(prepareMergePlan(d.state, id("card", 1)).ok).toBe(true);
  expect(humanMergeBlockers(d.state, decision)).not.toContain(
    "增量复核的隔离证据已失效，须完整复核",
  );
  expect(t.source.isCurrent).toHaveBeenCalledWith(expect.anything(), {
    baseline_sha: product.test_review?.baseline_sha,
    candidate_sha: candidate.new_sha,
    candidate_tree: product.test_review?.new_tree,
  });
  await git(t.x.source, "switch", "main");
  await writeFile(
    join(t.x.source, "production.ts"),
    "import fixture from './tests/assert.test.ts';\n",
  );
  await git(t.x.source, "add", ".");
  await git(t.x.source, "commit", "-m", "consume changed test in production");
  await git(t.repo, "fetch", t.x.source, "+refs/heads/main:refs/heads/main");
  // Policy bytes, source generation and the scoped delivery are unchanged.
  // The synchronous fresh center ref alone must close every authorization gate.
  expect(
    submitDelivery(beforeCompletion, actor(), complete, receipt, d.io),
  ).toMatchObject({ ok: false, error: { code: "stale_target" } });
  expect(humanMergeBlockers(d.state, decision)).toContain(
    "增量复核的隔离证据已失效，须完整复核",
  );
  expect(pmMergeBlockers(d.state, decision)).toContain(
    "增量复核的隔离证据已失效，须完整复核",
  );
  expect(prepareMergePlan(d.state, id("card", 1))).toMatchObject({
    ok: false,
    error: { code: "stale_target" },
  });
});

test("a missing baseline at consumption invalidates the proof irreversibly", async () => {
  const t = await setup();
  const candidate = await t.candidate();
  const proof = (await t.trust.prepare(candidate)) as TestReviewProof;
  expect(t.trust.isCurrent(proof)).toBe(true);
  const baseline = t.options.baselineNow();
  await git(t.repo, "update-ref", "-d", "refs/heads/main");
  expect(t.trust.isCurrent(proof)).toBe(false);
  await git(t.repo, "update-ref", "refs/heads/main", baseline as string);
  expect(t.trust.isCurrent(proof)).toBe(false);
});
