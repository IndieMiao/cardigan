import { expect, test } from "vitest";
import { githubCheckScope } from "./github-check-scope.js";

test.each([
  [{ name: "test", run: "true" }, "full", "", ""],
  [
    { name: "test", run: "true", skipReason: "docs_only" },
    "docs_only",
    "",
    "test",
  ],
  [
    {
      name: "test",
      run: "true",
      affectedPaths: ["apps/web", "packages/host", "apps/web"],
    },
    "affected",
    "apps/web packages/host",
    "",
  ],
] as const)(
  "scope is derived from trusted metadata: %j",
  (check, scope, paths, skips) => {
    expect(githubCheckScope({ checks: [check] })).toEqual({
      scope,
      affected_paths: paths,
      skip_checks: skips,
    });
  },
);

test.each([
  { name: "test", run: "true", affectedPaths: ["apps/web;touch injected"] },
  { name: "test", run: "true", affectedPaths: ["--help"] },
  { name: "test", run: "true", affectedPaths: ["../domain"] },
  { name: "test", run: "true", affectedPaths: ["apps/web\ninjected"] },
  { name: "test", run: "true", affectedPaths: ["apps/$(id)"] },
  { name: "test", run: "true", affectedPaths: Array(65).fill("apps/web") },
  { name: "lint", run: "true", affectedPaths: ["apps/web"] },
  { name: "build", run: "true", skipReason: "docs_only" },
  { name: "test", run: "true", skipReason: "unknown" },
  {
    name: "test",
    run: "true",
    skipReason: "docs_only",
    affectedPaths: ["apps/web"],
  },
])("invalid scope metadata falls back to full: %j", (check) => {
  expect(githubCheckScope({ checks: [check as never] })).toEqual({
    scope: "full",
    affected_paths: "",
    skip_checks: "",
  });
});

test("C-391: card tier omits only e2e while preserving affected test scope", () => {
  expect(
    githubCheckScope({
      mergeTier: "card",
      checks: [
        { name: "test", run: "true", affectedPaths: ["apps/web"] },
        { name: "e2e", run: "true", skipReason: "card_tier" },
      ],
    }),
  ).toEqual({
    scope: "affected",
    affected_paths: "apps/web",
    skip_checks: "",
    merge_tier: "card",
  });
  expect(
    githubCheckScope({
      mergeTier: "batch",
      checks: [{ name: "test", run: "true" }],
    }),
  ).toEqual({
    scope: "full",
    affected_paths: "",
    skip_checks: "",
    merge_tier: "batch",
  });
});
