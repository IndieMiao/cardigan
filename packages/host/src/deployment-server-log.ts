import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { requireHostDirectory } from "./deployment-config.js";

export interface ServerLogLimits {
  maxBytes: number;
  maxFiles: number;
}
export type ServerLogAudit =
  | { status: "opened"; file_name: string }
  | { status: "failed"; reason: "io" | "capacity"; file_name?: string };

const logName = /^server-[0-9]{16}-[a-f0-9]{40}-[a-f0-9-]{36}-[0-9]{16}\.log$/u;
const directoryFlags =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** Pin and validate every ancestor before creating anything in the host tree. */
async function hostDirectory(path: string): Promise<FileHandle> {
  let handle = await open("/", directoryFlags);
  try {
    for (const part of resolve(path).split("/").filter(Boolean)) {
      const next = await open(
        `/proc/self/fd/${handle.fd}/${part}`,
        directoryFlags,
      );
      await handle.close();
      handle = next;
      const stat = await handle.stat();
      if (
        ![0, process.getuid?.()].includes(stat.uid) ||
        (stat.mode & 0o022 && !(stat.mode & 0o1000))
      )
        throw new Error("Unsafe host directory");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Never backpressure the child. A failed sink is disabled for this generation. */
export class DeploymentServerLog {
  readonly finished: Promise<void>;
  private finish!: () => void;
  private readonly prefix: string;
  private readonly path: string;
  private directory: FileHandle | undefined;
  private file: FileHandle | undefined;
  private fileName: string | undefined;
  private size = 0;
  private segment = 0;
  private queue: Buffer[] = [];
  private pendingBytes = 0;
  private working = false;
  private ended = false;
  private failed = false;
  private disposed = false;

  constructor(
    deploymentDirectory: string,
    sha: string,
    private readonly limits: ServerLogLimits,
    private readonly audit: (entry: ServerLogAudit) => void,
    private readonly previous: Promise<void> = Promise.resolve(),
  ) {
    this.path = join(deploymentDirectory, "logs");
    this.prefix = `server-${String(Date.now()).padStart(16, "0")}-${sha}-${randomUUID()}`;
    this.finished = new Promise((done) => {
      this.finish = done;
    });
    if (
      !/^[a-f0-9]{40}$/u.test(sha) ||
      !Number.isSafeInteger(limits.maxBytes) ||
      limits.maxBytes < 1 ||
      !Number.isSafeInteger(limits.maxFiles) ||
      limits.maxFiles < 1 ||
      !Number.isSafeInteger(limits.maxBytes * limits.maxFiles)
    )
      this.fail("io");
    this.kick();
  }

  append(data: Buffer): void {
    if (this.ended || this.failed || !data.length) return;
    // Memory budget follows the explicit retention budget, with no hidden default.
    if (
      this.pendingBytes + data.length >
      this.limits.maxBytes * this.limits.maxFiles
    ) {
      this.fail("capacity");
      this.kick();
      return;
    }
    this.pendingBytes += data.length;
    this.queue.push(Buffer.from(data));
    this.kick();
  }

  close(): Promise<void> {
    this.ended = true;
    this.kick();
    return this.finished;
  }

  private fail(reason: "io" | "capacity") {
    if (this.failed) return;
    this.failed = true;
    this.queue = [];
    this.pendingBytes = 0;
    try {
      this.audit({
        status: "failed",
        reason,
        ...(this.fileName ? { file_name: this.fileName } : {}),
      });
    } catch {
      /* Audit failure must not turn a logging error into a server error. */
    }
  }

  private kick() {
    if (this.working || this.disposed) return;
    this.working = true;
    void this.drain()
      .catch(() => this.fail("io"))
      .then(async () => {
        // A stream callback may append between drain resolving and this callback.
        if (!this.failed && this.queue.length) {
          this.working = false;
          this.kick();
          return;
        }
        if (this.ended || this.failed) {
          for (const handle of [this.file, this.directory]) {
            try {
              await handle?.close();
            } catch {
              this.fail("io");
            }
          }
          this.file = this.directory = undefined;
          this.disposed = true;
          this.finish();
        }
        this.working = false;
        if (this.queue.length) this.kick();
      });
  }

  private async drain() {
    await this.previous; // Serialize generations without delaying server startup/stop.
    if (this.failed) return;
    if (!this.directory) {
      const parent = await hostDirectory(join(this.path, ".."));
      try {
        const stat = await parent.stat();
        if (stat.uid !== process.getuid?.() || stat.mode & 0o077)
          throw new Error("Unsafe deployment directory");
        const path = `/proc/self/fd/${parent.fd}/logs`;
        await mkdir(path, { mode: 0o700 }).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          },
        );
        this.directory = await open(path, directoryFlags);
      } finally {
        await parent.close();
      }
      await this.rotate();
    }
    while (!this.failed && this.queue.length) {
      const data = this.queue.shift();
      if (!data) break;
      for (let offset = 0; offset < data.length && !this.failed; ) {
        if (this.size === this.limits.maxBytes) await this.rotate();
        await this.checkDirectory();
        const file = this.file;
        if (!file) throw new Error("Missing log file");
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o777) !== 0o600 ||
          stat.nlink !== 1
        )
          throw new Error("Unsafe log file");
        const length = Math.min(
          data.length - offset,
          this.limits.maxBytes - this.size,
        );
        const { bytesWritten } = await file.write(data, offset, length);
        if (!bytesWritten) throw new Error("Log write made no progress");
        offset += bytesWritten;
        this.size += bytesWritten;
      }
      if (!this.failed) this.pendingBytes -= data.length;
    }
  }

  private async checkDirectory() {
    if (!this.directory) throw new Error("Missing log directory");
    await requireHostDirectory(this.path);
    const stat = await this.directory.stat();
    const named = await lstat(this.path);
    if (
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077 ||
      named.dev !== stat.dev ||
      named.ino !== stat.ino
    )
      throw new Error("Unsafe log directory");
    return `/proc/self/fd/${this.directory.fd}`;
  }

  private async rotate() {
    const directory = await this.checkDirectory();
    await this.file?.close();
    this.file = undefined;
    const entries = [];
    for (const name of await readdir(directory)) {
      if (!logName.test(name)) continue;
      const stat = await lstat(join(directory, name), { bigint: true });
      if (
        !stat.isFile() ||
        stat.uid !== BigInt(process.getuid?.() ?? -1) ||
        (stat.mode & 0o777n) !== 0o600n ||
        stat.nlink !== 1n
      )
        throw new Error("Unsafe retained log");
      entries.push({ name, stat });
    }
    entries.sort((a, b) =>
      a.stat.mtimeNs < b.stat.mtimeNs
        ? -1
        : a.stat.mtimeNs > b.stat.mtimeNs
          ? 1
          : a.name.localeCompare(b.name),
    );
    const retained = entries.filter(
      (e) => e.stat.size <= BigInt(this.limits.maxBytes),
    );
    const remove = new Set(
      retained
        .slice(0, Math.max(0, retained.length - this.limits.maxFiles + 1))
        .map((e) => e.name),
    );
    for (const entry of entries)
      if (
        entry.stat.size > BigInt(this.limits.maxBytes) ||
        remove.has(entry.name)
      )
        await unlink(join(directory, entry.name));
    this.fileName = `${this.prefix}-${String(this.segment++).padStart(16, "0")}.log`;
    this.file = await open(
      join(directory, this.fileName),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    this.size = 0;
    this.audit({ status: "opened", file_name: this.fileName });
  }
}
