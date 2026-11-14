import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SystemReviewLimitCandidate } from "@cardigan/domain";
import { afterEach, expect, test } from "vitest";
import { centralFixture, git } from "../../git-transport/test-support/git.js";
import { proveSystemReviewLimit } from "./system-review-limit.js";

let f: Awaited<ReturnType<typeof centralFixture>> | undefined;
afterEach(async () => {
  await f?.close();
});
async function fixture(conflict = false, extra = false) {
  f = await centralFixture();
  const repo = await f.central.ensureCentral(f.project);
  const work = join(f.root, "work");
  await git(f.root, "clone", f.source, work);
  await git(work, "switch", "-c", "feature");
  const file = conflict ? "shared.txt" : "feature.txt";
  await writeFile(join(work, file), "feature\n");
  await git(work, "add", ".");
  await git(work, "commit", "-m", "feature");
  const previous = await git(work, "rev-parse", "HEAD");
  await git(work, "switch", "main");
  await writeFile(
    join(work, conflict ? "shared.txt" : "baseline.txt"),
    "baseline\n",
  );
  await git(work, "add", ".");
  await git(work, "commit", "-m", "baseline");
  const base = await git(work, "rev-parse", "HEAD");
  await git(work, "switch", "feature");
  try {
    await git(work, "merge", "--no-edit", "main");
  } catch (error) {
    if (!conflict) throw error;
  }
  if (conflict || extra) {
    await writeFile(
      join(work, conflict ? "shared.txt" : "extra.txt"),
      "manual\n",
    );
    await git(work, "add", ".");
    await git(work, "commit", "-m", "manual change");
  }
  const delivery = await git(work, "rev-parse", "HEAD");
  await f.transport.fetchRefs(repo, work, [
    "+refs/heads/main:refs/heads/main",
    "+refs/heads/feature:refs/cardigan/incoming/A-1",
  ]);
  await f.central.pinDelivery(f.project, "D-1", previous);
  await f.central.pinDelivery(f.project, "D-2", delivery);
  const candidate: SystemReviewLimitCandidate = {
    decision_id: "Q-1" as never,
    card_id: "C-1" as never,
    work_item_id: "W-2" as never,
    review_id: "V-1" as never,
    previous_delivery_id: "D-1" as never,
    previous_sha: previous,
    delivery_id: "D-2" as never,
    delivery_sha: delivery,
    base_branch: "main",
    max_auto_raises: 1,
    role_rule_paths: ["AGENTS.md"],
  };
  return { repo, candidate, base, transport: f.transport };
}
test("real central Git proves the exact clean merge tree without moving refs", async () => {
  const x = await fixture();
  const proof = await proveSystemReviewLimit(
    x.transport,
    x.repo,
    "main",
    x.candidate,
  );
  expect(proof).toMatchObject({
    base_sha: x.base,
    candidate: x.candidate,
    changed_paths: ["baseline.txt", "feature.txt"],
  });
  expect(proof?.merged_tree).toBe(proof?.delivery_tree);
  expect(await git(x.repo, "rev-parse", "main")).toBe(x.base);
});
test.each([
  [true, false],
  [false, true],
])("rejects conflicts=%s and extra edits=%s", async (conflict, extra) => {
  const x = await fixture(conflict, extra);
  expect(
    await proveSystemReviewLimit(x.transport, x.repo, "main", x.candidate),
  ).toBeNull();
});
test("rejects unpinned/self-reported SHA, missing objects and mismatched baseline", async () => {
  const x = await fixture();
  for (const candidate of [
    { ...x.candidate, previous_sha: "f".repeat(40) },
    { ...x.candidate, previous_sha: x.base },
    { ...x.candidate, delivery_sha: x.base },
    { ...x.candidate, base_branch: "feature" },
    { ...x.candidate, delivery_id: "D-999" as never },
    { ...x.candidate, previous_sha: "HEAD" },
  ])
    expect(
      await proveSystemReviewLimit(x.transport, x.repo, "main", candidate),
    ).toBeNull();
});
test.each(["paths", "baseline moved", "unsupported Git"])(
  "uncertain %s proof fails closed",
  async (mode) => {
    const x = await fixture();
    let reads = 0;
    const transport = new Proxy(x.transport, {
      get(target, property) {
        if (mode === "paths" && property === "changedPaths")
          return async () => {
            throw new Error("unreadable");
          };
        if (mode === "unsupported Git" && property === "mergeTree")
          return async () => {
            throw new Error("unsupported");
          };
        if (mode === "baseline moved" && property === "readRef")
          return async (repo: string, ref: string) => {
            if (ref === "refs/heads/main" && ++reads > 1)
              return x.candidate.delivery_sha;
            return target.readRef(repo, ref);
          };
        const v = Reflect.get(target, property);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    expect(
      await proveSystemReviewLimit(transport, x.repo, "main", x.candidate),
    ).toBeNull();
  },
);
