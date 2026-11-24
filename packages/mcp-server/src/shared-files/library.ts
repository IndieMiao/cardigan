import { randomUUID } from "node:crypto";
import {
  canDeleteShared,
  normalizeSharedDir,
  normalizeSharedFile,
  SHARED_FILE_MAX_BYTES,
  type SharedDirectory,
  type SharedFile,
  type SharedFileActor,
  SharedFilesError,
  type SharedFileVersion,
  type SharedListing,
  sharedContentType,
  sharedDirChain,
} from "@cardigan/domain";
import { type Offsite, OffsiteUnavailable } from "../offsite/offsite.js";
import { OssError } from "../offsite/oss.js";

/**
 * C-685: the shared file library behind both the Agent tools and the
 * Workbench page. Contents go straight between the uploader or downloader
 * and the private OSS bucket through signed URLs; the host signs, records
 * metadata and checks an upload's size with one HEAD. It never reads or
 * forwards file bytes.
 */

/** The store's `SharedFileStore` satisfies this structurally (§20.2). */
export interface SharedFilesRepository {
  listing(dir: string): SharedListing;
  dirExists(dir: string): boolean;
  file(path: string): SharedFile | undefined;
  createDir(dir: string, by: SharedFileActor, at: string): SharedDirectory;
  beginVersion(
    input: Omit<SharedFileVersion, "status" | "committed_at" | "file_id">,
  ): SharedFileVersion;
  version(id: string): SharedFileVersion | undefined;
  commitVersion(id: string, at: string): SharedFile;
  versions(path: string, limit?: number): readonly SharedFileVersion[];
  removeFile(path: string, by: SharedFileActor, at: string): void;
  removeDir(dir: string, by: SharedFileActor, at: string): void;
}

/** A pending upload may be committed within this long after it was started. */
export const SHARED_UPLOAD_COMMIT_HOURS = 24;
/** Shown with every tool result and on the Workbench page. */
export const SHARED_FILES_NOTICE =
  "共享文件库各项目都能看到，不要放密钥和凭据。";

export interface SharedUploadTicket {
  readonly upload_id: string;
  readonly path: string;
  readonly size: number;
  readonly method: "PUT";
  readonly url: string;
  /** Send exactly these headers with the PUT; they are signed. */
  readonly headers: Readonly<Record<string, string>>;
  readonly url_expires_at: string;
  readonly commit_before: string;
  readonly replaces_version?: string;
}

export interface SharedDownload {
  readonly path: string;
  readonly version: SharedFileVersion;
  readonly url: string;
  readonly expires_at: string;
}

export interface SharedFileLibraryOptions {
  readonly repository: SharedFilesRepository;
  /** Looked up per call: the process registers its off-site copy later. */
  readonly offsite: () => Offsite | undefined;
  readonly now?: () => Date;
}

function unavailable(error: unknown): never {
  if (error instanceof OffsiteUnavailable)
    throw new SharedFilesError(
      "unavailable",
      error.reason === "not_configured"
        ? "共享文件库不可用：主机未配置私有存储"
        : "共享文件库暂不可用：私有存储不可达，请稍后重试",
    );
  if (error instanceof OssError)
    throw new SharedFilesError(
      "unavailable",
      "共享文件库暂不可用：私有存储请求失败，请稍后重试",
    );
  throw error;
}

const sameUploader = (a: SharedFileActor, b: SharedFileActor) =>
  a.kind === "human"
    ? b.kind === "human"
    : b.kind === "assignment" &&
      a.project_id === b.project_id &&
      a.assignment_id === b.assignment_id;

export class SharedFileLibrary {
  private readonly now: () => Date;
  constructor(private readonly options: SharedFileLibraryOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private offsite(): Offsite {
    const offsite = this.options.offsite();
    if (!offsite) unavailable(new OffsiteUnavailable("not_configured"));
    return offsite;
  }

  /** `ready`, or why signed URLs cannot be issued now. */
  availability(): "ready" | "not_configured" | "unreachable" {
    return this.options.offsite()?.sharedAvailable() ?? "not_configured";
  }

  list(path: string): SharedListing {
    return this.options.repository.listing(normalizeSharedDir(path));
  }

  history(path: string): {
    readonly file: SharedFile;
    readonly versions: readonly SharedFileVersion[];
  } {
    const target = normalizeSharedFile(path);
    const file = this.options.repository.file(target.path);
    if (!file) throw new SharedFilesError("not_found", "文件不存在");
    return { file, versions: this.options.repository.versions(target.path) };
  }

  mkdir(by: SharedFileActor, path: string): SharedDirectory {
    return this.options.repository.createDir(
      normalizeSharedDir(path),
      by,
      this.now().toISOString(),
    );
  }

  /**
   * Starts a new file or a new version of `path`. The returned URL accepts one
   * PUT of exactly `size` bytes; the version shows up only after
   * `commitUpload` confirmed the object.
   */
  beginUpload(
    by: SharedFileActor,
    input: {
      readonly path: string;
      readonly size: number;
      readonly content_type?: string | undefined;
      readonly sha256?: string | undefined;
    },
  ): SharedUploadTicket {
    const target = normalizeSharedFile(input.path);
    if (
      !Number.isSafeInteger(input.size) ||
      input.size < 0 ||
      input.size > SHARED_FILE_MAX_BYTES
    )
      throw new SharedFilesError(
        "invalid",
        `文件大小须在 0 到 ${SHARED_FILE_MAX_BYTES} 字节之间`,
      );
    if (input.sha256 !== undefined && !/^[a-f0-9]{64}$/u.test(input.sha256))
      throw new SharedFilesError("invalid", "sha256 须为 64 位小写十六进制");
    const repository = this.options.repository;
    if (repository.dirExists(target.path))
      throw new SharedFilesError("conflict", `“${target.path}”已是目录`);
    const blocking = sharedDirChain(target.dir).find((dir) =>
      repository.file(dir),
    );
    if (blocking)
      throw new SharedFilesError("conflict", `“${blocking}”已是文件`);
    const contentType = sharedContentType(input.content_type);
    const id = randomUUID();
    const key = `shared/${id}`;
    let signed: ReturnType<Offsite["sharedUploadUrl"]>;
    try {
      signed = this.offsite().sharedUploadUrl(key, contentType);
    } catch (error) {
      unavailable(error);
    }
    const at = this.now();
    const commitBefore = new Date(
      at.getTime() + SHARED_UPLOAD_COMMIT_HOURS * 3_600_000,
    ).toISOString();
    repository.beginVersion({
      id,
      path: target.path,
      object_key: key,
      size: input.size,
      sha256: input.sha256 ?? null,
      content_type: contentType,
      created_at: at.toISOString(),
      created_by: by,
      expires_at: commitBefore,
    });
    const existing = repository.file(target.path);
    return {
      upload_id: id,
      path: target.path,
      size: input.size,
      method: "PUT",
      url: signed.url,
      headers: signed.headers,
      url_expires_at: signed.expires_at,
      commit_before: commitBefore,
      ...(existing ? { replaces_version: existing.current.id } : {}),
    };
  }

  /**
   * Confirms an upload with one HEAD (size only; no bytes pass through the
   * host) and makes it the file's current version. Only whoever started the
   * upload commits it.
   */
  async commitUpload(
    by: SharedFileActor,
    uploadId: string,
  ): Promise<SharedFile> {
    const repository = this.options.repository;
    const version = /^[a-f0-9-]{36}$/u.test(uploadId)
      ? repository.version(uploadId)
      : undefined;
    if (!version || !sameUploader(version.created_by, by))
      throw new SharedFilesError("not_found", "上传不存在");
    if (version.status === "committed")
      return repository.commitVersion(version.id, this.now().toISOString());
    let head: Awaited<ReturnType<Offsite["sharedHead"]>>;
    try {
      head = await this.offsite().sharedHead(version.object_key);
    } catch (error) {
      unavailable(error);
    }
    if (!head)
      throw new SharedFilesError(
        "conflict",
        "存储里还没有这个文件，请先用上传链接 PUT 文件内容",
      );
    if (head.size !== version.size)
      throw new SharedFilesError(
        "conflict",
        `存储里的文件大小（${head.size}）与声明的大小（${version.size}）不一致，请重新上传`,
      );
    return repository.commitVersion(version.id, this.now().toISOString());
  }

  /** A signed GET for the current version of `path`, or one of its versions. */
  download(path: string, versionId?: string): SharedDownload {
    const target = normalizeSharedFile(path);
    const repository = this.options.repository;
    const file = repository.file(target.path);
    if (!file) throw new SharedFilesError("not_found", "文件不存在");
    const version =
      versionId === undefined ? file.current : repository.version(versionId);
    if (version?.status !== "committed" || version.file_id !== file.id)
      throw new SharedFilesError("not_found", "版本不存在");
    let signed: ReturnType<Offsite["sharedDownloadUrl"]>;
    try {
      signed = this.offsite().sharedDownloadUrl(version.object_key, {
        filename: file.name,
        contentType: version.content_type,
        size: version.size,
      });
    } catch (error) {
      unavailable(error);
    }
    return {
      path: file.path,
      version,
      url: signed.url,
      expires_at: signed.expires_at,
    };
  }

  /**
   * Deletion is a default human category: an Agent is refused even if it
   * reaches this method. The rows are marked and the OSS objects kept.
   */
  remove(by: SharedFileActor, path: string, kind: "file" | "dir"): void {
    if (!canDeleteShared(by))
      throw new SharedFilesError("forbidden", "只有人可以删除共享文件");
    const at = this.now().toISOString();
    if (kind === "file")
      this.options.repository.removeFile(
        normalizeSharedFile(path).path,
        by,
        at,
      );
    else this.options.repository.removeDir(normalizeSharedDir(path), by, at);
  }
}
