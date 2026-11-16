import { describe, expect, test } from "vitest";
import {
  computeChangeScope,
  loadWorkspace,
  parseWorkspacePackage,
  parseWorkspacePatterns,
  type WorkspacePackage,
} from "./change-scope.js";

const pkg = (
  dir: string,
  name: string,
  ...deps: string[]
): WorkspacePackage => ({
  dir,
  name: `@cardigan/${name}`,
  dependencies: deps.map((d) => `@cardigan/${d}`),
});

/** The repository's dependency graph as of 2026-11-12 (plan §2.1). */
const workspace: readonly WorkspacePackage[] = [
  pkg("packages/domain", "domain"),
  pkg("packages/git-service", "git-service", "domain"),
  pkg("packages/git-transport", "git-transport", "domain", "git-service"),
  pkg(
    "packages/host",
    "host",
    "domain",
    "git-service",
    "git-transport",
    "mcp-server",
    "roles",
    "runtime-herdr",
    "store",
  ),
  pkg("packages/mcp-server", "mcp-server", "domain", "store"),
  pkg("packages/roles", "roles", "domain"),
  pkg("packages/router", "router", "domain"),
  pkg("packages/runtime-herdr", "runtime-herdr", "domain"),
  pkg("packages/store", "store", "domain"),
  pkg(
    "apps/cli",
    "cli",
    "domain",
    "roles",
    "store",
    "mcp-server",
    "runtime-herdr",
    "git-service",
    "git-transport",
    "host",
    "router",
  ),
  pkg(
    "apps/server",
    "server",
    "domain",
    "git-service",
    "git-transport",
    "host",
    "mcp-server",
    "roles",
    "router",
    "runtime-herdr",
    "store",
    "cli",
  ),
  pkg("apps/web", "web"),
  pkg("e2e", "e2e", "cli", "domain", "mcp-server", "server", "store"),
];
const scope = (paths: string[], extraDependents?: Record<string, string[]>) =>
  computeChangeScope({
    paths,
    workspace,
    ...(extraDependents ? { extraDependents } : {}),
  });

describe("§2.1 docs_only", () => {
  test("only docs/ changes", () => {
    expect(
      scope(["docs/plans/flow-lite.md", "docs/plans/p2a-13-merge-queue.md"]),
    ).toEqual({ kind: "docs_only" });
  });
  test("only root *.md changes", () => {
    expect(scope(["README.md"])).toEqual({ kind: "docs_only" });
    expect(scope(["README.md", "AGENTS.md"])).toEqual({
      kind: "full",
      reason: "test_document",
    });
    expect(scope(["CLAUDE.md", "docs/adr/0004-merge-batch-check.md"])).toEqual({
      kind: "docs_only",
    });
  });
  test("a nested *.md outside docs/ is not docs", () => {
    expect(scope(["packages/store/README.md"])).toEqual({
      kind: "affected",
      packages: [
        "apps/cli",
        "apps/server",
        "packages/host",
        "packages/mcp-server",
        "packages/store",
      ],
    });
  });
});

describe("§2.1 full", () => {
  test.each([
    "AGENTS.md",
    "docs/development-plan.md",
    "docs/plans/p2a-1-merge-gate.md",
    "docs/research/pm-practice-distillation.md",
  ])(
    "test input document %s runs full checks while neighboring docs remain docs-only",
    (document) => {
      expect(scope([document])).toEqual({
        kind: "full",
        reason: "test_document",
      });
      expect(scope(["apps/web/src/App.tsx", document])).toEqual({
        kind: "full",
        reason: "test_document",
      });
      expect(scope(["docs/research/other.md"])).toEqual({ kind: "docs_only" });
    },
  );
  test("changing packages/domain is full", () => {
    expect(
      scope(["packages/domain/src/card.ts", "packages/store/src/x.ts"]),
    ).toEqual({ kind: "full", reason: "domain" });
  });
  test.each([
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "tsconfig.base.json",
    "vitest.config.ts",
    "biome.json",
    ".dependency-cruiser.cjs",
    "test-support/git.ts",
    "e2e/tests/merge.spec.ts",
  ])("global file %s is full", (path) => {
    expect(scope(["apps/web/src/App.tsx", path])).toEqual({
      kind: "full",
      reason: "global_file",
    });
  });
  test.each([
    "scripts/release.sh",
    ".github/workflows/ci.yml",
    "LICENSE",
    "packages/README",
    "apps/notes.txt",
  ])("unknown location %s is full", (path) => {
    expect(scope([path])).toEqual({
      kind: "full",
      reason: "outside_workspace",
    });
  });
  test("a package directory missing from the candidate workspace is full", () => {
    expect(scope(["packages/new-thing/src/index.ts"])).toEqual({
      kind: "full",
      reason: "unknown_package",
    });
  });
  test("a package directory outside the allowed name pattern is full", () => {
    expect(
      computeChangeScope({
        paths: ["packages/Odd_Name/x.ts"],
        workspace: [pkg("packages/Odd_Name", "odd")],
      }),
    ).toEqual({ kind: "full", reason: "unknown_package" });
  });
  test("an empty change list is full (conservative)", () => {
    expect(scope([])).toEqual({ kind: "full", reason: "empty" });
  });
  test("a root tsconfig lookalike in a package is not global", () => {
    expect(scope(["apps/web/tsconfig.json"])).toEqual({
      kind: "affected",
      packages: ["apps/web"],
    });
  });
});

describe("§2.1 affected", () => {
  test("changing apps/web affects only web", () => {
    expect(scope(["apps/web/src/components/MergeCheck.tsx"])).toEqual({
      kind: "affected",
      packages: ["apps/web"],
    });
  });
  test("changing store brings mcp-server, host, cli and server transitively", () => {
    expect(scope(["packages/store/src/store.ts"])).toEqual({
      kind: "affected",
      packages: [
        "apps/cli",
        "apps/server",
        "packages/host",
        "packages/mcp-server",
        "packages/store",
      ],
    });
  });
  test("changing git-service follows devDependencies (git-transport) and on", () => {
    expect(scope(["packages/git-service/src/central.ts"])).toEqual({
      kind: "affected",
      packages: [
        "apps/cli",
        "apps/server",
        "packages/git-service",
        "packages/git-transport",
        "packages/host",
      ],
    });
  });
  test("changing server affects only server (e2e never reaches the variable)", () => {
    expect(scope(["apps/server/src/git.ts"])).toEqual({
      kind: "affected",
      packages: ["apps/server"],
    });
  });
  test("docs alongside code keep the code's scope", () => {
    expect(scope(["docs/plans/x.md", "README.md", "apps/web/a.ts"])).toEqual({
      kind: "affected",
      packages: ["apps/web"],
    });
  });
  test("extra dependents add edges and are followed transitively", () => {
    expect(
      scope(["apps/web/src/x.ts"], { "apps/web": ["packages/router"] }),
    ).toEqual({
      kind: "affected",
      packages: ["apps/cli", "apps/server", "apps/web", "packages/router"],
    });
  });
});

describe("workspace reading", () => {
  test("patterns accept directories and one trailing /*", () => {
    expect(
      parseWorkspacePatterns(
        "packages:\n  - packages/*\n  - apps/*\n  - e2e\n",
      ),
    ).toEqual(["packages/*", "apps/*", "e2e"]);
  });
  test.each([
    "packages:\n  - '!packages/x'\n",
    "packages:\n  - packages/**\n",
    "packages:\n  - ../outside\n",
    "packages:\n  - /abs\n",
    "packages: []\n",
    "nothing: 1\n",
  ])("unsupported workspace %j is rejected", (text) => {
    expect(() => parseWorkspacePatterns(text)).toThrow();
  });
  test("package.json keeps only @cardigan deps from both dependency fields", () => {
    expect(
      parseWorkspacePackage(
        "packages/x",
        JSON.stringify({
          name: "@cardigan/x",
          dependencies: { "@cardigan/domain": "workspace:*", yaml: "2" },
          devDependencies: { "@cardigan/git-service": "workspace:*" },
          peerDependencies: { "@cardigan/store": "*" },
        }),
      ),
    ).toEqual({
      dir: "packages/x",
      name: "@cardigan/x",
      dependencies: ["@cardigan/domain", "@cardigan/git-service"],
    });
    expect(() => parseWorkspacePackage("packages/x", "{}")).toThrow(/name/);
    expect(() => parseWorkspacePackage("packages/x", "[]")).toThrow();
  });
  test("loadWorkspace expands patterns and skips directories without package.json", async () => {
    const files: Record<string, string> = {
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n  - e2e\n",
      "packages/a/package.json": '{"name":"@cardigan/a"}',
      "packages/b/package.json":
        '{"name":"@cardigan/b","dependencies":{"@cardigan/a":"workspace:*"}}',
    };
    const reads: string[] = [];
    const result = await loadWorkspace({
      listDirectories: async (dir) =>
        dir === "packages"
          ? ["packages/a", "packages/b", "packages/empty"]
          : [],
      readFile: async (path) => {
        reads.push(path);
        return files[path];
      },
    });
    expect(result).toEqual([
      { dir: "packages/a", name: "@cardigan/a", dependencies: [] },
      {
        dir: "packages/b",
        name: "@cardigan/b",
        dependencies: ["@cardigan/a"],
      },
    ]);
    expect(reads.sort()).toEqual([
      "e2e/package.json",
      "packages/a/package.json",
      "packages/b/package.json",
      "packages/empty/package.json",
      "pnpm-workspace.yaml",
    ]);
  });
  test("loadWorkspace refuses a tree without pnpm-workspace.yaml", async () => {
    await expect(
      loadWorkspace({
        listDirectories: async () => [],
        readFile: async () => undefined,
      }),
    ).rejects.toThrow(/pnpm-workspace/);
  });
});

test("cross-package file reads expand web and server checks through configured extra dependents", () => {
  const extra = {
    "apps/web": ["apps/server", "packages/store"],
    "apps/server": ["apps/web"],
  };
  const expected = {
    kind: "affected",
    packages: [
      "apps/cli",
      "apps/server",
      "apps/web",
      "packages/host",
      "packages/mcp-server",
      "packages/store",
    ],
  };
  expect(scope(["apps/web/public/avatars/v1/manifest.json"], extra)).toEqual(
    expected,
  );
  expect(scope(["apps/server/src/web/server.ts"], extra)).toEqual(expected);
});
