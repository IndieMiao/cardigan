import { expect, test } from "vitest";
import { supervisorChanges } from "./deployment-supervisor-scope.js";

const scope = (path: string, before?: unknown, after?: unknown) =>
  supervisorChanges("old", "new", async (args) =>
    args[0] === "diff"
      ? `M\0${path}\0`
      : JSON.stringify(args.at(-1)?.startsWith("old:") ? before : after),
  );

test.each([
  ["apps/cli/src/self-deploy.ts", "apps/cli"],
  ["packages/host/src/deployment-retention-fs.py", "packages/host"],
  ["packages/host/src/deployment-node.ts", "packages/host"],
  ["packages/host/src/deployment-config.ts", "packages/host"],
  ["packages/host/src/deployment-server-log.ts", "packages/host"],
  ["packages/host/src/repository-lock.ts", "packages/host"],
  ["packages/store/migrations/1234.sql", "packages/store"],
  ["packages/domain/src/commands/deployment.ts", "packages/domain"],
])("watch source %s names its package", async (path, pkg) => {
  expect(await scope(path)).toEqual([pkg]);
});
test.each([
  "apps/web/src/index.ts",
  "apps/server/package.json",
  "packages/domain/src/commands/test-fixtures.ts",
  "packages/store/src/test-support.ts",
  "packages/router/src/route.ts",
  "packages/host/src/deployment-node.test.ts",
  "packages/host/src/other.ts",
  "packages/domain/src/commands/deployment.contract.test.ts",
  "docs/plans/C-490.md",
])("unrelated change %s stays quiet", async (path) => {
  expect(await scope(path)).toEqual([]);
});

test("manifest dependencies and the reachable lock graph, not unrelated importers, metadata or test tools", async () => {
  const path = "packages/host/package.json";
  expect(await scope(path, {}, { scripts: { test: "vitest" } })).toEqual([]);
  expect(await scope(path, {}, { dependencies: { yaml: "2" } })).toEqual([
    path,
  ]);
  expect(
    await scope("package.json", {}, { devDependencies: { vitest: "2" } }),
  ).toEqual([]);
  expect(
    await scope("package.json", {}, { packageManager: "pnpm@11" }),
  ).toEqual(["package.json"]);
  const lock = {
    lockfileVersion: "9.0",
    importers: {
      "packages/host": {
        dependencies: { used: { specifier: "1", version: "1" } },
      },
      "apps/web": { dependencies: { ui: { specifier: "1", version: "1" } } },
    },
    snapshots: {
      "used@1": { dependencies: { child: "1" } },
      "child@1": {},
      "ui@1": {},
    },
    packages: { "used@1": {}, "child@1": {}, "ui@1": {} },
  };
  const next = structuredClone(lock);
  next.importers["apps/web"].dependencies.ui.specifier = "^1";
  next.packages["ui@1"] = { resolution: { integrity: "changed" } };
  expect(await scope("pnpm-lock.yaml", lock, next)).toEqual([]);
  next.packages["child@1"] = { resolution: { integrity: "changed" } };
  expect(await scope("pnpm-lock.yaml", lock, next)).toEqual(["pnpm-lock.yaml"]);
});

test("an unreadable manifest before a verified dependency change cannot mask that change", async () => {
  const affected = await supervisorChanges("old", "new", async (args) => {
    if (args[0] === "diff")
      return "M\0package.json\0M\0packages/host/package.json\0";
    if (args.at(-1) === "new:package.json") throw new Error("blob unavailable");
    return args.at(-1) === "new:packages/host/package.json"
      ? '{"dependencies":{"yaml":"2"}}'
      : "{}";
  });
  expect(affected).toEqual(["packages/host/package.json"]);
});
