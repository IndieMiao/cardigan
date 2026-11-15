import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testReviewForAssignment } from "@cardigan/domain";
import { expect, test } from "vitest";
import { CommandDraft } from "../../domain/src/commands/core.js";
import { reviewRound } from "../../domain/src/commands/review-round.js";
import { human, id } from "../../domain/src/commands/test-fixtures.js";
import { testReviewFixture } from "../../domain/src/commands/test-review/test-fixtures.js";
import { Store } from "./store.js";

test("SQLite replay preserves composite scope and historical free count, but never revives the live authority", async () => {
  const f = await testReviewFixture(3);
  const next = (await f.deliver()).data;
  f.start();
  f.commit(f.review());
  const root = mkdtempSync(join(tmpdir(), "cg-test-review-"));
  let store = Store.open({ dataDir: root });
  try {
    store.createProject({ id: f.state.project_id });
    store.setTestReviewTrust(f.trust);
    store.uow.run((tx) => {
      for (const e of f.state.employees ?? []) tx.employees.put(e);
      for (const collection of [
        "cards",
        "work_items",
        "assignments",
        "runs",
        "deliveries",
        "reviews",
        "roles",
      ] as const)
        for (const entity of f.state[collection])
          (tx[collection].put as (p: string, e: unknown) => void)(
            f.state.project_id,
            entity,
          );
      for (const e of f.state.events) tx.events.append(f.state.project_id, e);
    });
    const read = () =>
      store.uow.read((tx) => {
        const { test_review_trust: _old, ...base } = f.state;
        return {
          ...base,
          ...(tx.test_review_trust
            ? { test_review_trust: tx.test_review_trust }
            : {}),
          deliveries: tx.deliveries.list(base.project_id),
          reviews: tx.reviews.list(base.project_id),
          runs: tx.runs.list(base.project_id),
        };
      });
    expect(
      read().deliveries.find((v) => v.id === next.id)?.test_review,
    ).toEqual(next.test_review);
    const recorded = read().reviews.find((r) => r.test_review);
    expect(recorded?.test_review?.new_sha).toBe(next.subject.value);
    store.close();
    store = Store.open({ dataDir: root });
    expect(read().test_review_trust).toBeUndefined();
    expect(
      testReviewForAssignment(read(), id("assignment", 2)),
    ).toBeUndefined();
    const d = new CommandDraft(read(), human, "queue_run");
    expect(reviewRound(d, d.work(id("work_item", 2)))).toBe(2);
    // Changing the installed port bypasses the command-state DATA cache.
    store.setTestReviewTrust(f.trust);
    expect(read().test_review_trust).toBe(f.trust);
    store.setTestReviewTrust(undefined);
    expect(read().test_review_trust).toBeUndefined();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
