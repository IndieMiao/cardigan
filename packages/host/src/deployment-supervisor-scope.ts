import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";

// Runtime roots of `self-deploy watch` (not the release processes it spawns).
// Shared persistence/command packages intentionally use a package boundary.
const watchSources = new Map<string, RegExp>([
  [
    "apps/cli",
    /^src\/(bin|index|self-deploy|command-access|errors|host|io)\.ts$/u,
  ],
  [
    "packages/host",
    /^src\/(deployment(?:-[\w-]+)?|index|runtime-workers-config|worker-mcp|runtime-target-fingerprint|warnings|capacity-owner|process-identity|repository-lock|preparation-budget|long-operations)\.ts$/u,
  ],
  ["packages/domain", /^src\//u],
  ["packages/store", /^(src\/|migrations\/.*\.sql$)/u],
  ["packages/mcp-server", /^src\//u],
  ["packages/git-service", /^src\/(index|lock)\.ts$/u],
  ["packages/git-transport", /^src\/(index|hardening)\.ts$/u],
  [
    "packages/runtime-herdr",
    /^src\/(index|execution|registered|agent-ssh)\.ts$/u,
  ],
  ["packages/roles", /^src\/(index|errors)\.ts$/u],
]);

const testSource =
  /(?:^|\/)(?:__tests__|__snapshots__|test-support)\/|\/(?:test-support|test-fixtures)\.ts$|\.(?:spec|test)\.[^/]+$/u;
const toolchain = ["node", "typescript"];
function manifest(text: string, root: boolean) {
  const p = JSON.parse(text);
  return [
    p.dependencies,
    p.optionalDependencies,
    p.peerDependencies,
    p.exports,
    p.bin,
    p.type,
    p.main,
    p.engines,
    p.devEngines,
    p.packageManager,
    root && toolchain.map((name) => p.devDependencies?.[name]),
  ];
}

type Deps<T> = {
  dependencies?: Record<string, T>;
  optionalDependencies?: Record<string, T>;
};
type Locked = { specifier: string; version: string };
interface Lock {
  lockfileVersion: string;
  settings: unknown;
  importers: Record<
    string,
    Deps<Locked> & { devDependencies?: Record<string, Locked> }
  >;
  snapshots: Record<string, Deps<string>>;
  packages: Record<string, unknown>;
}

/** Compare importer resolutions AND reachable transitive snapshots/integrities, not the whole workspace lock. */
function lockProjection(text: string) {
  const lock: Lock = parse(text, { maxAliasCount: 0 });
  if (lock.lockfileVersion !== "9.0")
    throw new Error("Unsupported supervisor lockfile");
  const entries = new Map<string, unknown>();
  entries.set("settings", lock.settings);
  function visit(name: string, version: string) {
    if (version.startsWith("link:")) return; // Workspace sources/importers have their own boundary above.
    // Aliases have a resolved name@version instead of a bare version.
    const id = Object.hasOwn(lock.snapshots, version)
      ? version
      : `${name}@${version}`;
    if (entries.has(id)) return;
    const snapshot = lock.snapshots[id];
    const metadata = lock.packages[id.split("(")[0] ?? id];
    if (!snapshot || !metadata)
      throw new Error("Incomplete supervisor lockfile");
    entries.set(id, [metadata, snapshot]);
    for (const [dep, ref] of Object.entries({
      ...snapshot.dependencies,
      ...snapshot.optionalDependencies,
    }))
      visit(dep, ref);
  }
  for (const dir of [".", ...watchSources.keys()]) {
    const importer = lock.importers[dir];
    const deps = {
      ...importer?.dependencies,
      ...importer?.optionalDependencies,
    };
    if (dir === ".")
      for (const name of toolchain) {
        const d = importer?.devDependencies?.[name];
        if (d) deps[name] = d;
      }
    entries.set(dir, deps);
    for (const [name, { version }] of Object.entries(deps))
      visit(name, version);
  }
  return entries;
}

type ReadGit = (args: string[]) => Promise<string>;

/** NUL-delimited with renames disabled: both sides of a move are classified. Never publish arbitrary Git paths. */
export async function supervisorChanges(
  from: string,
  to: string,
  git: ReadGit,
) {
  const affected = new Set<string>();
  let incomplete = false;
  if (from === to) return [];
  const fields = (
    await git([
      "diff",
      "--no-ext-diff",
      "--no-renames",
      "--name-status",
      "-z",
      from,
      to,
      "--",
      "pnpm-lock.yaml",
      "package.json",
      "tsconfig.base.json",
      ...watchSources.keys(),
    ])
  ).split("\0");
  for (let i = 0; i < fields.length - 1; i += 2) {
    const status = fields[i];
    const path = fields[i + 1] ?? "";
    const [, dir = "", local = ""] =
      /^((?:packages|apps)\/[^/]+)\/(.*)$/su.exec(path) ?? [];
    const scope = watchSources.get(dir);
    if (
      path === "pnpm-lock.yaml" ||
      path === "package.json" ||
      (scope && local === "package.json")
    ) {
      if (status === "M") {
        const project =
          path === "pnpm-lock.yaml"
            ? lockProjection
            : (text: string) => manifest(text, !dir);
        try {
          const [before, after] = await Promise.all(
            [from, to].map(async (sha) =>
              project(await git(["cat-file", "blob", `${sha}:${path}`])),
            ),
          );
          if (isDeepStrictEqual(before, after)) continue;
        } catch {
          incomplete = true;
          continue; // Other files can still independently prove the supervisor needs an upgrade.
        }
      }
      affected.add(path);
    } else if (
      scope &&
      !testSource.test(local) &&
      ((scope.test(local) && /\.(?:[cm]?[jt]s|json|sql)$/u.test(local)) ||
        local === "tsconfig.json")
    ) {
      affected.add(dir);
    } else if (path === "tsconfig.base.json") affected.add(path);
  }
  // Only a complete negative comparison can retire the running version's notice.
  if (incomplete && !affected.size)
    throw new Error("Incomplete supervisor comparison");
  return [...affected].sort();
}
