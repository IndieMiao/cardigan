import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  formatAttachmentLimit,
  resolveVideoMaxBytes,
  VIDEO_CHUNK_BYTES,
} from "./attachment-limits.js";
import { publishAttachmentFile } from "./attachments.js";
import { ToolError } from "./errors.js";
import {
  checkVideoContent,
  isVideoMime,
  VIDEO_SNIFF_BYTES,
} from "./video-format.js";

/**
 * C-683: resumable uploads of large files (videos), shared by the Workbench
 * and the Card MCP endpoint.
 *
 * A client opens an upload with the size and type, sends the bytes in
 * chunks of at most `chunk_bytes` at the offset the server reports, and on
 * a failure asks for that offset and continues from it. The last chunk makes
 * the server hash the whole file and check its first bytes against the type;
 * only a complete, checked upload can be published into the attachment
 * store. Nothing is kept in memory: `<dataDir>/uploads/<id>.part` holds the
 * bytes and `<id>.json` the manifest, so another process (or a restart)
 * continues the same upload. An upload untouched for a day is removed.
 */
export interface UploadInput {
  readonly size: number;
  readonly mime: string;
  /** Checked when the last byte arrives (Agents state it up front). */
  readonly sha256?: string | undefined;
  /** Resumes the owner's upload of the same key instead of opening another. */
  readonly key?: string | undefined;
  /** Opaque data the caller needs when publishing (the MCP target). */
  readonly target?: unknown;
}

export interface UploadStatus {
  readonly upload_id: string;
  readonly size: number;
  readonly mime: string;
  readonly received: number;
  readonly chunk_bytes: number;
  readonly complete: boolean;
  readonly sha256?: string;
  readonly expires_at: string;
}

interface Manifest {
  readonly id: string;
  readonly owner: string;
  readonly key?: string;
  readonly size: number;
  readonly mime: string;
  readonly sha256?: string;
  readonly target?: unknown;
  readonly created_at: number;
  updated_at: number;
  complete?: { readonly sha256: string };
}

const UPLOAD_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const DAY_MS = 24 * 60 * 60_000;
/** Open uploads per owner and in total; finished ones are removed. */
const MAX_PER_OWNER = 8;
const MAX_TOTAL = 64;

const missing = () =>
  ToolError.notFound("Upload not found or expired; start a new upload");

export function videoTooLargeMessage(maxBytes: number) {
  return `Video exceeds ${formatAttachmentLimit(maxBytes)}`;
}

export interface UploadSessionsOptions {
  readonly maxBytes?: number;
  readonly chunkBytes?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export class UploadSessions {
  readonly maxBytes: number;
  readonly chunkBytes: number;
  private readonly directory: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dataDir: string,
    options: UploadSessionsOptions = {},
  ) {
    this.directory = join(resolve(dataDir), "uploads");
    this.maxBytes = options.maxBytes ?? resolveVideoMaxBytes(process.env);
    this.chunkBytes = options.chunkBytes ?? VIDEO_CHUNK_BYTES;
    this.ttlMs = options.ttlMs ?? DAY_MS;
    this.now = options.now ?? Date.now;
  }

  /** Open an upload, or return the owner's open upload with the same key. */
  async create(owner: string, input: UploadInput): Promise<UploadStatus> {
    if (!isVideoMime(input.mime))
      throw ToolError.validation(
        "Only mp4, mov, webm and m4v videos use chunked uploads",
      );
    if (!Number.isSafeInteger(input.size) || input.size < 1)
      throw ToolError.validation("Invalid upload size");
    if (input.size > this.maxBytes)
      throw ToolError.validation(videoTooLargeMessage(this.maxBytes), {
        max_bytes: this.maxBytes,
      });
    if (input.sha256 !== undefined && !/^[a-f0-9]{64}$/u.test(input.sha256))
      throw ToolError.validation("Invalid sha256");
    return this.locked(`owner:${owner}`, async () => {
      const open = await this.sweep();
      if (input.key !== undefined) {
        const same = open.find((m) => m.owner === owner && m.key === input.key);
        if (same) {
          if (
            same.size !== input.size ||
            same.mime !== input.mime ||
            same.sha256 !== input.sha256 ||
            JSON.stringify(same.target) !== JSON.stringify(input.target)
          )
            throw new ToolError(
              "idempotency_conflict",
              "Another upload uses this key with different parameters",
            );
          return this.status(owner, same.id);
        }
      }
      if (
        open.filter((m) => m.owner === owner).length >= MAX_PER_OWNER ||
        open.length >= MAX_TOTAL
      )
        throw ToolError.validation(
          "Too many uploads in progress; finish or wait for one to expire",
        );
      const at = this.now();
      const manifest: Manifest = {
        id: randomUUID(),
        owner,
        ...(input.key === undefined ? {} : { key: input.key }),
        size: input.size,
        mime: input.mime,
        ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
        ...(input.target === undefined ? {} : { target: input.target }),
        created_at: at,
        updated_at: at,
      };
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(this.part(manifest.id), "", { flag: "wx", mode: 0o600 });
      await this.save(manifest);
      return this.view(manifest, 0);
    });
  }

  async status(owner: string, id: string): Promise<UploadStatus> {
    const manifest = await this.load(owner, id);
    return this.view(manifest, await this.received(id));
  }

  /** The opaque `target` the upload was opened with. */
  async target(owner: string, id: string): Promise<unknown> {
    return (await this.load(owner, id)).target;
  }

  /**
   * Write one chunk at `offset`, which must be exactly what the server has.
   * A chunk that fails part way is cut back off, so a retry starts from the
   * same offset. The last byte completes and checks the upload.
   */
  async append(
    owner: string,
    id: string,
    offset: number,
    source: AsyncIterable<Buffer | Uint8Array | string>,
    noteProgress: () => void = () => undefined,
  ): Promise<UploadStatus> {
    return this.locked(`upload:${id}`, async () => {
      const manifest = await this.load(owner, id);
      const received = await this.received(id);
      if (manifest.complete || offset !== received)
        throw new ToolError(
          "stale_target",
          `Upload has ${received} of ${manifest.size} bytes; send from offset ${received}`,
          { received, size: manifest.size, complete: !!manifest.complete },
        );
      const limit = Math.min(this.chunkBytes, manifest.size - offset);
      const file = await open(
        this.part(id),
        constants.O_WRONLY | constants.O_NOFOLLOW,
      );
      let written = 0;
      try {
        for await (const piece of source) {
          const chunk =
            typeof piece === "string" ? Buffer.from(piece) : Buffer.from(piece);
          if (written + chunk.length > limit)
            throw ToolError.validation(
              `A chunk holds at most ${limit} bytes here`,
              { received, size: manifest.size, chunk_bytes: this.chunkBytes },
            );
          await file.write(chunk, 0, chunk.length, offset + written);
          written += chunk.length;
          noteProgress();
        }
      } catch (error) {
        await file.truncate(offset).catch(() => undefined);
        throw error instanceof ToolError
          ? error
          : ToolError.validation("Chunk upload interrupted; retry it", {
              received,
              size: manifest.size,
            });
      } finally {
        await file.close();
      }
      manifest.updated_at = this.now();
      if (offset + written === manifest.size) {
        try {
          manifest.complete = { sha256: await this.check(manifest) };
        } catch (error) {
          // Wrong bytes never become an attachment; the client starts over.
          await this.remove(owner, id);
          throw error;
        }
      }
      await this.save(manifest);
      return this.view(manifest, offset + written);
    });
  }

  /**
   * Publish a complete upload into the content-addressed attachment store.
   * The upload stays until `remove`, so a failed record write can retry.
   */
  async publish(
    owner: string,
    id: string,
  ): Promise<{
    sha256: string;
    size: number;
    mime: string;
    storage_path: string;
  }> {
    return this.locked(`upload:${id}`, async () => {
      const manifest = await this.load(owner, id);
      if (!manifest.complete)
        throw ToolError.validation("Upload is not complete yet", {
          received: await this.received(id),
          size: manifest.size,
        });
      const { storage_path } = await publishAttachmentFile(
        this.dataDir,
        manifest.complete.sha256,
        manifest.size,
        this.part(id),
      );
      return {
        sha256: manifest.complete.sha256,
        size: manifest.size,
        mime: manifest.mime,
        storage_path,
      };
    });
  }

  async remove(owner: string, id: string): Promise<void> {
    await this.load(owner, id);
    await rm(this.manifestPath(id), { force: true });
    await rm(this.part(id), { force: true });
  }

  private async check(manifest: Manifest) {
    const file = await open(
      this.part(manifest.id),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const hash = createHash("sha256");
    const head = Buffer.alloc(VIDEO_SNIFF_BYTES);
    let size = 0;
    try {
      await file.read(head, 0, head.length, 0);
      for await (const chunk of file.createReadStream({
        autoClose: false,
        start: 0,
        end: manifest.size,
      })) {
        size += (chunk as Buffer).length;
        hash.update(chunk as Buffer);
      }
    } finally {
      await file.close();
    }
    const digest = hash.digest("hex");
    if (size !== manifest.size)
      throw ToolError.validation("Upload size changed; start a new upload");
    if (manifest.sha256 !== undefined && manifest.sha256 !== digest)
      throw ToolError.validation("Upload sha256 does not match the content");
    checkVideoContent(manifest.mime, head.subarray(0, Math.min(size, 64)));
    return digest;
  }

  private view(manifest: Manifest, received: number): UploadStatus {
    return {
      upload_id: manifest.id,
      size: manifest.size,
      mime: manifest.mime,
      received,
      chunk_bytes: this.chunkBytes,
      complete: !!manifest.complete,
      ...(manifest.complete ? { sha256: manifest.complete.sha256 } : {}),
      expires_at: new Date(manifest.updated_at + this.ttlMs).toISOString(),
    };
  }

  private part(id: string) {
    return join(this.directory, `${id}.part`);
  }
  private manifestPath(id: string) {
    return join(this.directory, `${id}.json`);
  }

  private async received(id: string) {
    const info = await lstat(this.part(id)).catch(() => undefined);
    if (!info?.isFile()) throw missing();
    return info.size;
  }

  private async load(owner: string, id: string): Promise<Manifest> {
    if (!UPLOAD_ID.test(id)) throw missing();
    const manifest = await this.read(id);
    // Another owner's upload is indistinguishable from a missing one.
    if (!manifest || manifest.owner !== owner) throw missing();
    if (manifest.updated_at + this.ttlMs <= this.now()) {
      await rm(this.manifestPath(id), { force: true });
      await rm(this.part(id), { force: true });
      throw missing();
    }
    return manifest;
  }

  private async read(id: string): Promise<Manifest | undefined> {
    try {
      const info = await lstat(this.manifestPath(id));
      if (!info.isFile()) return undefined;
      return JSON.parse(
        await readFile(this.manifestPath(id), "utf8"),
      ) as Manifest;
    } catch {
      return undefined;
    }
  }

  private async save(manifest: Manifest) {
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(manifest), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, this.manifestPath(manifest.id));
  }

  /** Open uploads; removes expired ones and stray parts on the way. */
  private async sweep(): Promise<Manifest[]> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    const open: Manifest[] = [];
    const at = this.now();
    for (const name of names) {
      // A part or temporary file without a manifest (a crash in between)
      // goes once it is as old as an expired upload.
      if (!name.endsWith(".json")) {
        const id = name.replace(/\.part$/u, "");
        if (names.includes(`${id}.json`)) continue;
        const info = await lstat(join(this.directory, name)).catch(
          () => undefined,
        );
        if (info?.isFile() && info.mtimeMs + this.ttlMs <= at)
          await rm(join(this.directory, name), { force: true });
        continue;
      }
      const match = /^(.+)\.json$/u.exec(name);
      if (!match?.[1] || !UPLOAD_ID.test(match[1])) continue;
      const manifest = await this.read(match[1]);
      if (manifest && manifest.updated_at + this.ttlMs > at) {
        open.push(manifest);
        continue;
      }
      await rm(this.manifestPath(match[1]), { force: true });
      await rm(this.part(match[1]), { force: true });
    }
    return open;
  }

  private async locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => undefined);
    this.locks.set(key, settled);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    }
  }
}

/** One instance per data directory and process (locks are per process). */
const sessions = new Map<string, UploadSessions>();
export function uploadSessionsFor(dataDir: string): UploadSessions {
  const key = resolve(dataDir);
  let found = sessions.get(key);
  if (!found) {
    found = new UploadSessions(key);
    sessions.set(key, found);
  }
  return found;
}

/**
 * C-683: copy a local video into the attachment store without loading it:
 * stream it once into a private file while hashing, check its first bytes
 * against the type, then publish by hard link. `onProgress` gets the bytes
 * copied so far. Used by the CLI, which reads files on the host itself.
 */
export async function importVideoFile(
  dataDir: string,
  path: string,
  mime: string,
  maxBytes: number,
  onProgress: (copied: number, size: number) => void = () => undefined,
): Promise<{ sha256: string; size: number; storage_path: string }> {
  const source = await open(path, constants.O_RDONLY);
  const directory = join(resolve(dataDir), "uploads");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    const info = await source.stat();
    if (!info.isFile()) throw ToolError.validation("Not a regular file");
    if (info.size > maxBytes)
      throw ToolError.validation(videoTooLargeMessage(maxBytes), {
        max_bytes: maxBytes,
      });
    const head = Buffer.alloc(VIDEO_SNIFF_BYTES);
    const { bytesRead } = await source.read(head, 0, head.length, 0);
    checkVideoContent(mime, head.subarray(0, bytesRead));
    const target = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const chunk of source.createReadStream({
        autoClose: false,
        start: 0,
      })) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        if (size > maxBytes)
          throw ToolError.validation(videoTooLargeMessage(maxBytes), {
            max_bytes: maxBytes,
          });
        hash.update(buffer);
        await target.write(buffer);
        onProgress(size, info.size);
      }
    } finally {
      await target.close();
    }
    const sha256 = hash.digest("hex");
    const { storage_path } = await publishAttachmentFile(
      dataDir,
      sha256,
      size,
      temporary,
    );
    return { sha256, size, storage_path };
  } finally {
    await source.close();
    await rm(temporary, { force: true });
  }
}
