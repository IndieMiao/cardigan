import type { ToolName } from "./entities.js";
import type { ProjectPreferences } from "./preferences.js";

/**
 * C-685: the shared file library every project can see. File contents live
 * only in the private OSS bucket; the host keeps the directory tree, the
 * version history and who wrote what. Pure rules only (§20.2): no IO here.
 */

/** OSS accepts at most 5 GiB in one PUT; larger files would need multipart. */
export const SHARED_FILE_MAX_BYTES = 5 * 1024 ** 3;
const MAX_SEGMENT = 120;
const MAX_DEPTH = 16;
const MAX_PATH = 1024;

/**
 * Agent tools of the library. Every role holds them by default; the project
 * narrows by role through `shared_files_access`. There is no delete tool.
 */
export const SHARED_FILE_TOOLS = [
  "list_shared_files",
  "get_shared_file",
  "upload_shared_file",
  "commit_shared_file",
] as const satisfies readonly ToolName[];

/** Who wrote a version, created a directory or removed something. */
export type SharedFileActor =
  | { readonly kind: "human"; readonly member_id: string | null }
  | {
      readonly kind: "assignment";
      readonly project_id: string;
      readonly assignment_id: string;
      readonly role_id: string;
    };

export interface SharedDirectory {
  /** `a/b`, never the root. */
  readonly path: string;
  readonly created_at: string;
  readonly created_by: SharedFileActor;
}

export interface SharedFileVersion {
  readonly id: string;
  /** The file it became a version of; null while pending. */
  readonly file_id: string | null;
  /** Path the version was written to. */
  readonly path: string;
  readonly object_key: string;
  readonly size: number;
  /** Declared by the uploader; not computed by the host, which never reads the bytes. */
  readonly sha256: string | null;
  readonly content_type: string;
  readonly status: "pending" | "committed";
  readonly created_at: string;
  readonly created_by: SharedFileActor;
  readonly committed_at: string | null;
  /** A pending upload is refused after this time. */
  readonly expires_at: string;
}

export interface SharedFile {
  readonly id: string;
  readonly path: string;
  readonly dir: string;
  readonly name: string;
  readonly current: SharedFileVersion;
  readonly version_count: number;
  readonly created_at: string;
}

export interface SharedListing {
  readonly path: string;
  readonly dirs: readonly SharedDirectory[];
  readonly files: readonly SharedFile[];
}

/** A refusal every layer (store, MCP tools, Workbench routes) maps the same way. */
export class SharedFilesError extends Error {
  constructor(
    readonly code:
      | "invalid"
      | "not_found"
      | "conflict"
      | "forbidden"
      | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "SharedFilesError";
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point.
const FORBIDDEN = /[\u0000-\u001f\u007f\\:*?"<>|]/u;

function segment(value: string): string {
  const name = value.normalize("NFC");
  if (
    name.length === 0 ||
    name.length > MAX_SEGMENT ||
    name === "." ||
    name === ".." ||
    name.trim() !== name ||
    FORBIDDEN.test(name)
  )
    throw new SharedFilesError(
      "invalid",
      `路径中的名称“${value.slice(0, 40)}”无效`,
    );
  return name;
}

/**
 * A directory path as stored: segments joined by `/`, `""` for the root.
 * Leading and trailing slashes are accepted; `.`, `..`, empty segments,
 * control characters and Windows-reserved characters are not.
 */
export function normalizeSharedDir(path: string): string {
  if (path.length > MAX_PATH) throw new SharedFilesError("invalid", "路径过长");
  const trimmed = path.replace(/^\/+|\/+$/gu, "");
  if (trimmed === "") return "";
  const parts = trimmed.split("/").map(segment);
  if (parts.length > MAX_DEPTH)
    throw new SharedFilesError("invalid", "目录层级过深");
  return parts.join("/");
}

/** A file path: at least a name, optionally inside directories. */
export function normalizeSharedFile(path: string): {
  readonly path: string;
  readonly dir: string;
  readonly name: string;
} {
  const full = normalizeSharedDir(path);
  if (full === "") throw new SharedFilesError("invalid", "缺少文件名");
  const at = full.lastIndexOf("/");
  return {
    path: full,
    dir: at < 0 ? "" : full.slice(0, at),
    name: at < 0 ? full : full.slice(at + 1),
  };
}

/** `a/b/c` → `["a", "a/b", "a/b/c"]`; the root has no ancestors. */
export function sharedDirChain(dir: string): readonly string[] {
  if (dir === "") return [];
  const parts = dir.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

export function sharedParent(dir: string): string {
  const at = dir.lastIndexOf("/");
  return at < 0 ? "" : dir.slice(0, at);
}

/** `video/mp4`-like; anything else is stored as a plain byte stream. */
export function sharedContentType(value: string | undefined): string {
  const type = value?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u.test(
    type,
  )
    ? type
    : "application/octet-stream";
}

export type SharedFilesAccess = "read_write" | "read" | "none";
export const sharedFilesAccessLevels: readonly SharedFilesAccess[] = [
  "read_write",
  "read",
  "none",
];
const RANK: Readonly<Record<SharedFilesAccess, number>> = {
  none: 0,
  read: 1,
  read_write: 2,
};

/**
 * What an Agent of `role_id` may do in the shared library from this project.
 * Every role reads and writes unless the project narrows it: the role's own
 * entry wins over `*`. Deletion is never an Agent's: see `canDeleteShared`.
 */
export function sharedFilesAccess(
  preferences: Pick<ProjectPreferences, "shared_files_access"> | undefined,
  role_id: string,
): SharedFilesAccess {
  const rules = preferences?.shared_files_access;
  return rules?.[role_id] ?? rules?.["*"] ?? "read_write";
}

export function sharedFilesAllows(
  access: SharedFilesAccess,
  needed: Exclude<SharedFilesAccess, "none">,
): boolean {
  return RANK[access] >= RANK[needed];
}

/** Deleting is a default human category: Agents only add and update. */
export function canDeleteShared(actor: SharedFileActor): boolean {
  return actor.kind === "human";
}

/** Validates a `shared_files_access` preference value. */
export function validSharedFilesAccess(
  value: unknown,
): value is Readonly<Record<string, SharedFilesAccess>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 64 &&
    entries.every(
      ([role, level]) =>
        (role === "*" || /^[a-z][a-z0-9_-]{0,63}$/u.test(role)) &&
        (sharedFilesAccessLevels as readonly unknown[]).includes(level),
    )
  );
}
