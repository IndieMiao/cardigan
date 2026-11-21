import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Delivery,
  type DeliveryVerifier,
  prepareDelivery,
  submitDelivery,
  submitReview,
  type TestReviewCandidate,
} from "@cardigan/domain";
import { expect, vi } from "vitest";
import { actor, id, value } from "../../domain/src/commands/test-fixtures.js";
import { testReviewFixture } from "../../domain/src/commands/test-review/test-fixtures.js";
import {
  type centralFixture,
  git,
} from "../../git-transport/test-support/git.js";
import {
  HostTestReviewTrust,
  type TestIsolationSource,
} from "../src/test-review.js";

export const policyText =
  "project_id: project\nversion: v1\nsource_version: fixture-v1\ntest_files:\n  - tests/assert.test.ts\n  - tests/fixture.json\n";

/** Synthetic source contract. Real Git and filesystem IO, NO production isolation claim. */
export async function realReviewTrust(
  x: Awaited<ReturnType<typeof centralFixture>>,
  project = "project",
) {
  x.project.project_id = project;
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
  await writeFile(
    file,
    policyText.replace("project_id: project", `project_id: ${project}`),
    { mode: 0o600 },
  );
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
    isCurrent: vi.fn(
      (_proof, publication) =>
        sourceValid &&
        publication.candidate_tree === _proof.new_tree &&
        publication.baseline_sha === _proof.baseline_sha,
    ),
  };
  const options = {
    git: x.transport,
    repository: () => repo,
    baseline: () => x.transport.readRef(repo, "refs/heads/main"),
    baselineNow: () => x.transport.readRefSync(repo, "refs/heads/main"),
    pinned: (_project: string, delivery: string) =>
      x.transport.readRef(repo, `refs/cardigan/deliveries/${delivery}`),
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
      project_id: project,
      work_item_id: id("work_item", 1),
      verifier_id: id("work_item", 2),
      assignment_id: id("assignment", 2),
      previous_delivery_id: id("delivery", 1),
      previous_review_id: id("review", 1),
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

export async function reviewedCompletion(
  t: Awaited<ReturnType<typeof realReviewTrust>>,
) {
  const candidate = await t.candidate();
  const d = await testReviewFixture(3);
  // Retain real state transitions/identity proof, replace only Git evidence
  // with commits from this test's actual protected center repository.
  d.state = {
    ...d.state,
    test_review_trust: t.trust,
    deliveries: d.state.deliveries.map((v) => ({
      ...v,
      subject: { kind: "git_head", value: candidate.old_sha },
      evidence: [
        {
          kind: "commit",
          details: { sha: candidate.old_sha, tree_sha: candidate.old_tree },
        },
      ],
    })),
    reviews: d.state.reviews.map((r) => ({
      ...r,
      target_sha: candidate.old_sha,
    })),
  };
  await git(
    t.repo,
    "update-ref",
    `refs/cardigan/deliveries/${d.first.id}`,
    candidate.old_sha,
  );
  const verifier: DeliveryVerifier = {
    verify: async (s) => ({
      ok: true,
      value: [
        {
          kind: "commit",
          details: {
            sha: s.value,
            tree_sha: await t.x.transport.treeOfCommit(t.repo, s.value),
          },
        },
      ],
    }),
  };
  const params = d.params(candidate.new_sha);
  const product = d.commit(
    submitDelivery(
      d.state,
      actor(),
      params,
      value(await prepareDelivery(d.state, actor(), params, verifier)),
      d.io,
    ),
  ).data;
  expect(product.test_review).toBeDefined();
  d.start();
  const review = d.commit(d.review()).data;
  expect(review.test_review).toBeDefined();
  const beforeCompletion = d.state;
  const complete = {
    ...params,
    kind: "card_completion" as const,
    requested_verifiers: [id("work_item", 3)],
    plain_summary: { changed: "更新测试", impact: "验证更新", risk: "无" },
  };
  const receipt = value(
    await prepareDelivery(d.state, actor(), complete, verifier),
  );
  const completion: Delivery = d.commit(
    submitDelivery(d.state, actor(), complete, receipt, d.io),
  ).data;
  d.commit(
    submitReview(
      d.state,
      actor(3, "pm"),
      {
        delivery_id: completion.id,
        target_sha: completion.subject.value,
        kind: "product",
        issues: [],
      },
      d.io,
    ),
  );
  const decision = d.state.decisions.find(
    (q) => q.trigger === "merge_confirmation",
  );
  if (!decision) throw new Error("Missing merge confirmation");
  return {
    candidate,
    d,
    product,
    decision,
    beforeCompletion,
    complete,
    receipt,
  };
}
