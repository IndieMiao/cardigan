import { expect, test } from "vitest";
import { testReviewFixture } from "../../domain/src/commands/test-review/test-fixtures.js";
import { testReviewRunPrompt } from "./test-review-prompt.js";

test("host scope gives exact context and refuses revoked dispatched scope", async () => {
  const f = await testReviewFixture(3);
  const delivery = (await f.deliver()).data;
  const run = f.start();
  expect(testReviewRunPrompt(f.state, "A-2", run.id)).toContain(delivery.id);
  expect(testReviewRunPrompt(f.state, "A-2", run.id)).toContain(
    delivery.subject.value,
  );
  f.revoke();
  expect(() => testReviewRunPrompt(f.state, "A-2", run.id)).toThrow(
    "scope expired",
  );
});

test("default full scope and unrelated roles keep their existing behavior", async () => {
  const f = await testReviewFixture();
  f.disableProof();
  await f.deliver();
  expect(testReviewRunPrompt(f.state, "A-2", "unused")).toContain("完整复核");
  expect(testReviewRunPrompt(f.state, "A-1", "unused")).toBeUndefined();
});
