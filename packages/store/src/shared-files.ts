import { randomUUID } from "node:crypto";
import {
  type SharedDirectory,
  type SharedFile,
  type SharedFileActor,
  SharedFilesError,
  type SharedFileVersion,
  type SharedListing,
  sharedDirChain,
  sharedParent,
} from "@cardigan/domain";
import type { Store } from "./store.js";

/**
 * C-685: rows of the shared file library (`shared_dirs`, `shared_files`,
 * `shared_file_versions`). The tables are not scoped by project. The caller
 * (MCP tools or Workbench routes) decides who may do what; this layer keeps
 * the tree consistent: a path is either a directory or a file, a committed
 * version never changes, and removal only marks rows.
 */
type Row = Record<string, unknown>;

const actor = (value: unknown): SharedFileActor =>
  JSON.parse(String(value)) as SharedFileActor;

function versionOf(row: Row): SharedFileVersion {
  return {
    id: String(row.id),
    file_id: row.file_id === null ? null : String(row.file_id),
    path: String(row.path),
    object_key: String(row.object_key),
    size: Number(row.size),
    sha256: row.sha256 === null ? null : String(row.sha256),
    content_type: String(row.content_type),
    status: row.status === "committed" ? "committed" : "pending",
    created_at: String(row.created_at),
    created_by: actor(row.created_by),
    committed_at: row.committed_at === null ? null : String(row.committed_at),
    expires_at: String(row.expires_at),
  };
}

const VERSION_COLUMNS =
  "v.id, v.file_id, v.path, v.object_key, v.size, v.sha256, v.content_type, v.status, v.created_at, v.created_by, v.committed_at, v.expires_at";

export class SharedFileStore {
  constructor(private readonly store: Store) {}

  private get db() {
    return this.store.database;
  }

  private liveDir(path: string): Row | undefined {
    return this.db
      .prepare(
        "SELECT path, created_at, created_by FROM shared_dirs WHERE path = ? AND deleted_at IS NULL",
      )
      .get(path) as Row | undefined;
  }

  private liveFileRow(path: string): Row | undefined {
    return this.db
      .prepare(
        "SELECT id, path, dir, name, current_version, created_at FROM shared_files WHERE path = ? AND deleted_at IS NULL",
      )
      .get(path) as Row | undefined;
  }

  private fileOf(row: Row): SharedFile {
    const current = this.db
      .prepare(
        `SELECT ${VERSION_COLUMNS} FROM shared_file_versions v WHERE v.id = ?`,
      )
      .get(String(row.current_version)) as Row;
    const count = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM shared_file_versions WHERE file_id = ? AND status = 'committed'",
      )
      .get(String(row.id)) as Row;
    return {
      id: String(row.id),
      path: String(row.path),
      dir: String(row.dir),
      name: String(row.name),
      current: versionOf(current),
      version_count: Number(count.n),
      created_at: String(row.created_at),
    };
  }

  dirExists(path: string): boolean {
    return path === "" || this.liveDir(path) !== undefined;
  }

  file(path: string): SharedFile | undefined {
    const row = this.liveFileRow(path);
    return row ? this.fileOf(row) : undefined;
  }

  /** Immediate children of `dir`, directories first, both by name. */
  listing(dir: string): SharedListing {
    return this.store.uow.read(() => {
      if (!this.dirExists(dir))
        throw new SharedFilesError("not_found", "目录不存在");
      const dirs = (
        this.db
          .prepare(
            "SELECT path, created_at, created_by FROM shared_dirs WHERE parent = ? AND deleted_at IS NULL ORDER BY path",
          )
          .all(dir) as Row[]
      ).map(
        (row): SharedDirectory => ({
          path: String(row.path),
          created_at: String(row.created_at),
          created_by: actor(row.created_by),
        }),
      );
      const files = (
        this.db
          .prepare(
            "SELECT id, path, dir, name, current_version, created_at FROM shared_files WHERE dir = ? AND deleted_at IS NULL ORDER BY name",
          )
          .all(dir) as Row[]
      ).map((row) => this.fileOf(row));
      return { path: dir, dirs, files };
    });
  }

  /** Creates `dir` and its missing ancestors; a file in the way is a conflict. */
  private ensureDirs(dir: string, by: SharedFileActor, at: string) {
    for (const path of sharedDirChain(dir)) {
      if (this.liveDir(path)) continue;
      if (this.liveFileRow(path))
        throw new SharedFilesError("conflict", `“${path}”已是文件`);
      this.db
        .prepare(
          "INSERT INTO shared_dirs (path, parent, created_at, created_by) VALUES (?, ?, ?, ?)",
        )
        .run(path, sharedParent(path), at, JSON.stringify(by));
    }
  }

  createDir(dir: string, by: SharedFileActor, at: string): SharedDirectory {
    if (dir === "") throw new SharedFilesError("invalid", "缺少目录名");
    return this.store.uow.run(() => {
      this.ensureDirs(dir, by, at);
      const row = this.liveDir(dir) as Row;
      return {
        path: dir,
        created_at: String(row.created_at),
        created_by: actor(row.created_by),
      };
    });
  }

  beginVersion(
    input: Omit<SharedFileVersion, "status" | "committed_at" | "file_id">,
  ): SharedFileVersion {
    return this.store.uow.run(() => {
      if (this.liveDir(input.path))
        throw new SharedFilesError("conflict", `“${input.path}”已是目录`);
      this.db
        .prepare(
          "INSERT INTO shared_file_versions (id, path, object_key, size, sha256, content_type, status, created_at, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
        )
        .run(
          input.id,
          input.path,
          input.object_key,
          input.size,
          input.sha256,
          input.content_type,
          input.created_at,
          JSON.stringify(input.created_by),
          input.expires_at,
        );
      return {
        ...input,
        file_id: null,
        status: "pending",
        committed_at: null,
      };
    });
  }

  version(id: string): SharedFileVersion | undefined {
    const row = this.db
      .prepare(
        `SELECT ${VERSION_COLUMNS} FROM shared_file_versions v WHERE v.id = ?`,
      )
      .get(id) as Row | undefined;
    return row ? versionOf(row) : undefined;
  }

  /**
   * Makes a pending version the file's current one, creating the file (and
   * its directories) on first write. Older versions stay. Committing an
   * already committed version returns the file unchanged.
   */
  commitVersion(id: string, at: string): SharedFile {
    return this.store.uow.run(() => {
      const version = this.version(id);
      if (!version) throw new SharedFilesError("not_found", "上传不存在");
      if (version.status === "committed") {
        const row = this.db
          .prepare(
            "SELECT f.id, f.path, f.dir, f.name, f.current_version, f.created_at FROM shared_files f JOIN shared_file_versions v ON v.file_id = f.id WHERE v.id = ?",
          )
          .get(id) as Row;
        return this.fileOf(row);
      }
      if (version.expires_at <= at)
        throw new SharedFilesError("conflict", "上传已过期，请重新开始");
      if (this.liveDir(version.path))
        throw new SharedFilesError("conflict", `“${version.path}”已是目录`);
      const at_ = version.path.lastIndexOf("/");
      const dir = at_ < 0 ? "" : version.path.slice(0, at_);
      const name = at_ < 0 ? version.path : version.path.slice(at_ + 1);
      this.ensureDirs(dir, version.created_by, at);
      let file = this.liveFileRow(version.path);
      if (!file) {
        const fileId = `SF-${randomUUID()}`;
        this.db
          .prepare(
            "INSERT INTO shared_files (id, path, dir, name, current_version, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(fileId, version.path, dir, name, id, at);
        file = this.liveFileRow(version.path) as Row;
      }
      this.db
        .prepare(
          "UPDATE shared_file_versions SET status = 'committed', committed_at = ?, file_id = ? WHERE id = ?",
        )
        .run(at, String(file.id), id);
      this.db
        .prepare("UPDATE shared_files SET current_version = ? WHERE id = ?")
        .run(id, String(file.id));
      return this.fileOf(this.liveFileRow(version.path) as Row);
    });
  }

  /** Committed versions of the live file at `path`, newest first. */
  versions(path: string, limit = 50): readonly SharedFileVersion[] {
    const file = this.liveFileRow(path);
    if (!file) return [];
    return (
      this.db
        .prepare(
          `SELECT ${VERSION_COLUMNS} FROM shared_file_versions v WHERE v.file_id = ? AND v.status = 'committed' ORDER BY v.committed_at DESC, v.rowid DESC LIMIT ?`,
        )
        .all(String(file.id), limit) as Row[]
    ).map(versionOf);
  }

  /** Marks the file removed; versions and OSS objects stay for the record. */
  removeFile(path: string, by: SharedFileActor, at: string): void {
    this.store.uow.run(() => {
      const changed = this.db
        .prepare(
          "UPDATE shared_files SET deleted_at = ?, deleted_by = ? WHERE path = ? AND deleted_at IS NULL",
        )
        .run(at, JSON.stringify(by), path);
      if (changed.changes === 0)
        throw new SharedFilesError("not_found", "文件不存在");
    });
  }

  /** Marks the directory and everything under it removed. */
  removeDir(dir: string, by: SharedFileActor, at: string): void {
    if (dir === "") throw new SharedFilesError("invalid", "不能删除根目录");
    this.store.uow.run(() => {
      if (!this.liveDir(dir))
        throw new SharedFilesError("not_found", "目录不存在");
      // LIKE folds ASCII case in SQLite; compare the exact prefix instead.
      const prefix = `${dir}/`;
      const who = JSON.stringify(by);
      this.db
        .prepare(
          "UPDATE shared_files SET deleted_at = ?, deleted_by = ? WHERE deleted_at IS NULL AND substr(path, 1, ?) = ?",
        )
        .run(at, who, prefix.length, prefix);
      this.db
        .prepare(
          "UPDATE shared_dirs SET deleted_at = ?, deleted_by = ? WHERE deleted_at IS NULL AND (path = ? OR substr(path, 1, ?) = ?)",
        )
        .run(at, who, dir, prefix.length, prefix);
    });
  }
}
