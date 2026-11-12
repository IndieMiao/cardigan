import { parse } from "yaml";

/**
 * P2a-13 A1 (plan §2.1): the change scope of a merge candidate.
 *
 * Pure: the host reads the changed paths and the candidate's workspace from
 * the central repository (apps/server `ServerGit`), and this module decides
 * which checks may be narrowed. Never part of domain: domain does not know
 * about file paths.
 */

/** One workspace package as read from the candidate tree. */
export interface WorkspacePackage {
  /** Directory relative to the repository root, e.g. `packages/store`. */
  readonly dir: string;
  readonly name: string;
  /** `@cardigan/*` names from `dependencies` and `devDependencies`. */
  readonly dependencies: readonly string[];
}

export type FullScopeReason =
  | "empty"
  | "domain"
  | "global_file"
  | "outside_workspace"
  | "unknown_package";

export type ChangeScope =
  | { readonly kind: "docs_only" }
  | { readonly kind: "full"; readonly reason: FullScopeReason }
  | {
      readonly kind: "affected";
      /** Sorted package directories, each `^(packages|apps)/[a-z0-9-]+$`. */
      readonly packages: readonly string[];
    };

export interface ChangeScopeInput {
  readonly paths: readonly string[];
  readonly workspace: readonly WorkspacePackage[];
  /**
   * Extra reverse edges the dependency graph cannot see (plan §2.2
   * `affected.extra_dependents`): a change in the key directory also affects
   * every listed directory.
   */
  readonly extraDependents?: Readonly<Record<string, readonly string[]>>;
}

/** Package directories that may reach `CARDIGAN_AFFECTED_PATHS` (§2.2). */
export const AFFECTED_PACKAGE_DIR = /^(packages|apps)\/[a-z0-9-]+$/u;

/** Root files whose change makes every check run in full (§2.1). */
const GLOBAL_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "vitest.config.ts",
  "biome.json",
  ".dependency-cruiser.cjs",
]);
const GLOBAL_DIRS = ["test-support/", "e2e/"];
const DOMAIN_DIR = "packages/domain";

const isRootFile = (path: string) => !path.includes("/");
const isDocs = (path: string) =>
  path.startsWith("docs/") || (isRootFile(path) && path.endsWith(".md"));
const isGlobal = (path: string) =>
  (isRootFile(path) &&
    (GLOBAL_FILES.has(path) || /^tsconfig[^/]*\.json$/u.test(path))) ||
  GLOBAL_DIRS.some((dir) => path.startsWith(dir));
/** `packages/x` or `apps/x` for a file inside such a directory. */
const packageDirOf = (path: string) =>
  /^((?:packages|apps)\/[^/]+)\/./u.exec(path)?.[1];

/**
 * §2.1 table: `docs_only` when every path is under `docs/` or a root `*.md`;
 * `full` for domain, global files and anything outside docs/packages/apps;
 * otherwise `affected` = changed packages plus their transitive dependents.
 *
 * Conservative where the plan is silent: an empty change list, or a changed
 * package directory that is not a workspace package of the candidate (or has
 * a name outside the allowed pattern), is `full`.
 */
export function computeChangeScope(input: ChangeScopeInput): ChangeScope {
  const { paths, workspace } = input;
  if (paths.length === 0) return { kind: "full", reason: "empty" };
  if (paths.every(isDocs)) return { kind: "docs_only" };
  const changed = new Set<string>();
  for (const path of paths) {
    if (isDocs(path)) continue;
    if (isGlobal(path)) return { kind: "full", reason: "global_file" };
    const dir = packageDirOf(path);
    if (dir === undefined) return { kind: "full", reason: "outside_workspace" };
    if (dir === DOMAIN_DIR) return { kind: "full", reason: "domain" };
    changed.add(dir);
  }
  const byDir = new Map(workspace.map((p) => [p.dir, p]));
  for (const dir of changed)
    if (!byDir.has(dir) || !AFFECTED_PACKAGE_DIR.test(dir))
      return { kind: "full", reason: "unknown_package" };
  const dependents = reverseDependencies(workspace, input.extraDependents);
  const affected = new Set<string>();
  const pending = [...changed];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    if (affected.has(dir)) continue;
    affected.add(dir);
    pending.push(...(dependents.get(dir) ?? []));
  }
  // Workspace members outside packages/apps (e.g. `e2e`) never reach the
  // controlled variable; changing them is already `full`.
  return {
    kind: "affected",
    packages: [...affected].filter((d) => AFFECTED_PACKAGE_DIR.test(d)).sort(),
  };
}

/** Directory → directories that depend on it directly. */
function reverseDependencies(
  workspace: readonly WorkspacePackage[],
  extra: ChangeScopeInput["extraDependents"] = {},
): Map<string, string[]> {
  const dirOfName = new Map(workspace.map((p) => [p.name, p.dir]));
  const edges = new Map<string, string[]>();
  const add = (from: string, to: string) => {
    const list = edges.get(from) ?? [];
    if (!list.includes(to)) list.push(to);
    edges.set(from, list);
  };
  for (const pkg of workspace)
    for (const name of pkg.dependencies) {
      const dir = dirOfName.get(name);
      if (dir !== undefined && dir !== pkg.dir) add(dir, pkg.dir);
    }
  for (const [from, list] of Object.entries(extra))
    for (const to of list) add(from, to);
  return edges;
}

/** A `pnpm-workspace.yaml` `packages` entry the host can expand from a tree. */
const WORKSPACE_PATTERN = /^[a-z0-9._-]+(?:\/[a-z0-9._-]+)*(?:\/\*)?$/u;

/**
 * The `packages` patterns of `pnpm-workspace.yaml`. Only plain directories and
 * one trailing `/*` are supported; anything else (negation, `**`, `..`) is
 * rejected so the host never guesses the workspace.
 */
export function parseWorkspacePatterns(text: string): readonly string[] {
  const doc = parse(text) as unknown;
  const packages =
    doc !== null && typeof doc === "object"
      ? (doc as { packages?: unknown }).packages
      : undefined;
  if (!Array.isArray(packages) || packages.length === 0)
    throw new Error("pnpm-workspace.yaml has no packages list");
  return packages.map((pattern) => {
    if (
      typeof pattern !== "string" ||
      !WORKSPACE_PATTERN.test(pattern) ||
      pattern.split("/").some((s) => s === "." || s === "..")
    )
      throw new Error(
        `Unsupported pnpm-workspace.yaml pattern: ${String(pattern)}`,
      );
    return pattern;
  });
}

/** A workspace package from its `package.json` text. */
export function parseWorkspacePackage(
  dir: string,
  text: string,
): WorkspacePackage {
  const json = JSON.parse(text) as unknown;
  if (json === null || typeof json !== "object" || Array.isArray(json))
    throw new Error(`${dir}/package.json is not an object`);
  const manifest = json as Record<string, unknown>;
  if (typeof manifest.name !== "string" || manifest.name.length === 0)
    throw new Error(`${dir}/package.json has no name`);
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = manifest[field];
    if (deps === undefined) continue;
    if (deps === null || typeof deps !== "object" || Array.isArray(deps))
      throw new Error(`${dir}/package.json ${field} is not an object`);
    for (const name of Object.keys(deps))
      if (name.startsWith("@cardigan/")) names.add(name);
  }
  return { dir, name: manifest.name, dependencies: [...names].sort() };
}

/** Read-only view of one commit's tree (the host binds it to the center). */
export interface WorkspaceTree {
  /** Subdirectory paths directly under `directory`. */
  listDirectories(directory: string): Promise<readonly string[]>;
  /** A regular file's text, or undefined when the path is absent. */
  readFile(path: string): Promise<string | undefined>;
}

/**
 * Expand `pnpm-workspace.yaml` against a tree and read every member's
 * `package.json`. Directories without one are not workspace members (pnpm
 * skips them too). Reads nothing outside the given tree.
 */
export async function loadWorkspace(
  tree: WorkspaceTree,
): Promise<readonly WorkspacePackage[]> {
  const manifest = await tree.readFile("pnpm-workspace.yaml");
  if (manifest === undefined)
    throw new Error("Candidate has no pnpm-workspace.yaml");
  const dirs = new Set<string>();
  for (const pattern of parseWorkspacePatterns(manifest)) {
    if (pattern.endsWith("/*"))
      for (const dir of await tree.listDirectories(pattern.slice(0, -2)))
        dirs.add(dir);
    else dirs.add(pattern);
  }
  const packages: WorkspacePackage[] = [];
  for (const dir of [...dirs].sort()) {
    const text = await tree.readFile(`${dir}/package.json`);
    if (text !== undefined) packages.push(parseWorkspacePackage(dir, text));
  }
  return packages;
}
