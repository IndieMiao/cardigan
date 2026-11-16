import { expect, test } from "vitest";
import { testReviewFixture } from "../../domain/src/commands/test-review/test-fixtures.js";
import { compileAssignmentLaunch, parseLaunchConfig } from "./index.js";
import { testReviewPrompt } from "./test-review.js";

test("Run context includes exact versions, every diff range and all four weakening checks", async () => {
  const f = await testReviewFixture();
  const delivery = (await f.deliver()).data;
  const prompt = testReviewPrompt(delivery.test_review);
  for (const text of [
    delivery.id,
    delivery.subject.value,
    f.first.id,
    f.passed.id,
    "tests/assert.test.ts",
    "git --literal-pathspecs diff",
    "断言",
    "超时",
    "跳过",
    "夹具",
    "must_fix",
    "不消耗完整审核轮数",
  ])
    expect(prompt).toContain(text);
  expect(testReviewPrompt(undefined)).toContain("完整复核");
});

test("suggested diff commands quote literal file names without shell expansion", async () => {
  const f = await testReviewFixture();
  const delivery = (await f.deliver()).data;
  const proof = delivery.test_review;
  if (!proof) throw new Error("Missing scope");
  const path = "tests/a'$(printf injected)`printf x`.test.ts";
  const prompt = testReviewPrompt({
    ...proof,
    files: [path],
    ranges: [{ base: proof.old_sha, head: proof.new_sha, files: [path] }],
  });
  expect(prompt).toContain(
    "-- 'tests/a'\"'\"'$(printf injected)`printf x`.test.ts'",
  );
});

test("the compiler carries host scope into first.md without expanding tools", async () => {
  const f = await testReviewFixture();
  const delivery = (await f.deliver()).data;
  const compiled = compileAssignmentLaunch({
    assignment: {
      project_id: "fixture",
      assignment_id: "A-2",
      run_id: "R-20",
      work_item_id: "W-2",
    },
    role: {
      role_id: "independent_reviewer",
      harness: "codex",
      launch_profile: "fixture",
      allowed_tools: ["submit_review"],
      worktree: "readonly",
    },
    launch: parseLaunchConfig({
      providers: { fixture: { harness: "codex" } },
      profiles: {
        fixture: { harness: "codex", provider: "fixture", model: "fixture" },
      },
    }),
    mcp: { url: "http://127.0.0.1:3004/mcp" },
    run_dir: "/fixture/runs/A-2",
    work_dir: "/fixture/work/A-2",
    first_prompt: testReviewPrompt(delivery.test_review),
    secrets: {},
  });
  expect(
    compiled.files.find((f) => f.path.endsWith("/first.md"))?.content,
  ).toContain(delivery.subject.value);
  expect(
    compiled.files.find((f) => f.path.endsWith("/first.md"))?.content,
  ).toContain("增量复核（只改测试）");
});
