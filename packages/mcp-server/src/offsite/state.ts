import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { CorsOriginResult } from "./cors.js";
import type { LoopDelay } from "./loop-delay.js";

/**
 * C-614 bookkeeping under `<dataDir>/offsite/` (0700). The background sync
 * writes the status; it and verified restores append to the ledger; any
 * process may read them. Usage counters are written per process role so two
 * processes never share a file. Nothing here is ever deleted by Cardigan.
 *
 * The ledger and the status belong to one target (endpoint, bucket and
 * region, see `offsiteTarget`): switching the configuration to another bucket
 * starts an empty ledger, so every object is copied there again.
 */
export const offsiteDirectory = (dataDir: string) =>
  resolve(dataDir, "offsite");

export interface SyncedEntry {
  readonly key: string;
  readonly sha256: string;
  readonly size: number;
  readonly at: string;
}

function ensureDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory()) throw new Error("offsite directory");
}

const TARGET = /^[a-f0-9]{16}$/u;
const KEY = /^(?:attachments\/[a-f0-9]{64}|artifacts\/[a-f0-9-]{36})$/u;

/** Append-only record of objects whose upload was verified. */
export class SyncedLedger {
  private readonly dir: string;
  private readonly file: string;
  private entries = new Map<string, SyncedEntry>();
  private offset = 0;
  private identity = "";
  private bytes = 0;

  constructor(
    dataDir: string,
    readonly target: string,
  ) {
    if (!TARGET.test(target)) throw new Error("invalid offsite target");
    this.dir = offsiteDirectory(dataDir);
    this.file = join(this.dir, `synced-${target}.jsonl`);
  }

  /** Read lines appended since the last call; a replaced file is re-read. */
  refresh(): this {
    let fd: number;
    try {
      fd = openSync(
        this.file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch {
      return this;
    }
    try {
      const info = fstatSync(fd);
      if (!info.isFile()) return this;
      const identity = `${info.dev}:${info.ino}`;
      if (identity !== this.identity || info.size < this.offset) {
        this.entries = new Map();
        this.offset = 0;
        this.bytes = 0;
        this.identity = identity;
      }
      if (info.size === this.offset) return this;
      const buffer = Buffer.alloc(info.size - this.offset);
      let read = 0;
      while (read < buffer.length) {
        const n = readSync(
          fd,
          buffer,
          read,
          buffer.length - read,
          this.offset + read,
        );
        if (n === 0) break;
        read += n;
      }
      // Only complete lines count; a line being appended is read next time.
      const end = buffer.subarray(0, read).lastIndexOf(10);
      if (end < 0) return this;
      for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
        try {
          const e = JSON.parse(line) as SyncedEntry;
          if (
            typeof e.key === "string" &&
            KEY.test(e.key) &&
            /^[a-f0-9]{64}$/u.test(e.sha256) &&
            Number.isSafeInteger(e.size) &&
            e.size >= 0 &&
            !this.entries.has(e.key)
          ) {
            this.entries.set(e.key, e);
            this.bytes += e.size;
          }
        } catch {
          // A torn or foreign line is ignored; the object is simply re-checked.
        }
      }
      this.offset += end + 1;
      return this;
    } finally {
      closeSync(fd);
    }
  }

  get(key: string): SyncedEntry | undefined {
    return this.entries.get(key);
  }
  get count() {
    return this.entries.size;
  }
  get totalBytes() {
    return this.bytes;
  }

  record(entry: SyncedEntry) {
    if (!KEY.test(entry.key)) throw new Error("invalid offsite key");
    ensureDirectory(this.dir);
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`, {
      mode: 0o600,
      flag: "a",
    });
    this.refresh();
  }
}

export interface SyncStatus {
  readonly checked_at: string;
  /** `offsiteTarget` of the configuration the status describes. */
  readonly target?: string;
  readonly configured: "absent" | "invalid" | "ready";
  readonly pending: { readonly count: number; readonly bytes: number };
  readonly failed: {
    readonly count: number;
    readonly last_code?: string;
    readonly last_at?: string;
  };
  readonly last_success_at?: string;
  /** Last attempt reached OSS and was refused or timed out. */
  readonly reachable: boolean;
  /** C-628: event-loop delay of the process that ran the sync. */
  readonly loop_delay?: LoopDelay;
  /** C-807: last browser-upload preflight, one result per Workbench origin. */
  readonly cors?: {
    readonly checked_at: string;
    readonly results: readonly CorsOriginResult[];
  };
}

function atomicWrite(path: string, content: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readJson(path: string, limit = 65536): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit) return undefined;
    const buffer = Buffer.alloc(info.size);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return JSON.parse(buffer.subarray(0, read).toString("utf8"));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function writeSyncStatus(dataDir: string, status: SyncStatus) {
  const dir = offsiteDirectory(dataDir);
  ensureDirectory(dir);
  atomicWrite(join(dir, "status.json"), `${JSON.stringify(status)}\n`);
}
export function readSyncStatus(dataDir: string): SyncStatus | undefined {
  const value = readJson(join(offsiteDirectory(dataDir), "status.json"));
  return value && typeof value === "object" && "checked_at" in value
    ? (value as SyncStatus)
    : undefined;
}

export interface Usage {
  egress_bytes: number;
  process_bytes: number;
  process_count: number;
  requests: number;
}
const emptyUsage = (): Usage => ({
  egress_bytes: 0,
  process_bytes: 0,
  process_count: 0,
  requests: 0,
});
export const usageMonth = (at: Date) => at.toISOString().slice(0, 7);

/**
 * Counters of what this process asked OSS to serve, kept per calendar month
 * (UTC). Signed URLs count when issued, so egress is an upper bound.
 */
export class UsageMeter {
  private month: string;
  private current: Usage;
  private dirty = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly dataDir: string,
    private readonly role: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!/^[a-z]+$/u.test(role)) throw new Error("invalid usage role");
    this.month = usageMonth(now());
    this.current = this.load(this.month);
  }

  private path(month: string) {
    return join(
      offsiteDirectory(this.dataDir),
      "usage",
      `${month}-${this.role}.json`,
    );
  }
  private load(month: string): Usage {
    const value = readJson(this.path(month)) as Partial<Usage> | undefined;
    const usage = emptyUsage();
    for (const k of Object.keys(usage) as (keyof Usage)[])
      if (Number.isSafeInteger(value?.[k]) && (value?.[k] ?? -1) >= 0)
        usage[k] = value?.[k] as number;
    return usage;
  }

  add(delta: Partial<Usage>) {
    const month = usageMonth(this.now());
    if (month !== this.month) {
      this.flush();
      this.month = month;
      this.current = this.load(month);
    }
    for (const [k, v] of Object.entries(delta) as [keyof Usage, number][])
      this.current[k] += v;
    this.dirty = true;
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 30_000).unref();
  }

  /** A full disk loses only the estimate, never a read or an upload. */
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty) return;
    try {
      ensureDirectory(join(offsiteDirectory(this.dataDir), "usage"));
      atomicWrite(this.path(this.month), `${JSON.stringify(this.current)}\n`);
      this.dirty = false;
    } catch {
      // Retried on the next change.
    }
  }
}

/** Sum of every process role's counters for one month. */
export function monthUsage(dataDir: string, month: string): Usage {
  const total = emptyUsage();
  let names: string[];
  try {
    names = readdirSync(join(offsiteDirectory(dataDir), "usage"));
  } catch {
    return total;
  }
  for (const file of names) {
    if (!new RegExp(`^${month}-[a-z]+\\.json$`, "u").test(file)) continue;
    const value = readJson(join(offsiteDirectory(dataDir), "usage", file)) as
      | Partial<Usage>
      | undefined;
    for (const k of Object.keys(total) as (keyof Usage)[]) {
      const v = value?.[k];
      if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0)
        total[k] += v;
    }
  }
  return total;
}
