import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { getHeapStatistics } from "node:v8";

/**
 * C-638: V8 heap use against its limit, plus RSS, per server process, for the
 * control host's health page. RSS alone does not tell how close a process is
 * to the heap limit. The web process samples itself on request; the
 * background process publishes its sample under `<dataDir>/process-health/`
 * (0700, host-owned) every `PROCESS_HEALTH_INTERVAL_MS`. Numbers only.
 */
export type ProcessRole = "web" | "background" | "server";

export interface ProcessHealth {
  readonly role: ProcessRole;
  readonly heap_used_bytes: number;
  readonly heap_limit_bytes: number;
  readonly rss_bytes: number;
  readonly checked_at: string;
}

export const PROCESS_HEALTH_INTERVAL_MS = 30_000;
/** A published sample older than this belongs to a stopped process. */
export const PROCESS_HEALTH_STALE_MS = 10 * 60_000;
const FILE_LIMIT = 4096;

export const processHealthDirectory = (dataDir: string) =>
  resolve(dataDir, "process-health");

export function sampleProcessHealth(
  role: ProcessRole,
  now = new Date(),
): ProcessHealth {
  const heap = getHeapStatistics();
  return {
    role,
    heap_used_bytes: heap.used_heap_size,
    heap_limit_bytes: heap.heap_size_limit,
    rss_bytes: process.memoryUsage.rss(),
    checked_at: now.toISOString(),
  };
}

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function parse(value: unknown, role: ProcessRole): ProcessHealth | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    v.role !== role ||
    !count(v.heap_used_bytes) ||
    !count(v.heap_limit_bytes) ||
    !count(v.rss_bytes) ||
    typeof v.checked_at !== "string" ||
    Number.isNaN(Date.parse(v.checked_at))
  )
    return;
  return {
    role,
    heap_used_bytes: v.heap_used_bytes,
    heap_limit_bytes: v.heap_limit_bytes,
    rss_bytes: v.rss_bytes,
    checked_at: new Date(v.checked_at).toISOString(),
  };
}

/** Publish this process's sample; failures are left for the next interval. */
export function writeProcessHealth(dataDir: string, sample: ProcessHealth) {
  const dir = processHealthDirectory(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error("process-health");
  const path = join(dir, `${sample.role}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(sample)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** The last published sample of `role`, unless missing, invalid or stale. */
export function readProcessHealth(
  dataDir: string,
  role: ProcessRole,
  now = new Date(),
): ProcessHealth | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(
      join(processHealthDirectory(dataDir), `${role}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > FILE_LIMIT) return;
    const buffer = Buffer.alloc(info.size);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, read);
      if (n === 0) break;
      read += n;
    }
    const sample = parse(
      JSON.parse(buffer.subarray(0, read).toString("utf8")),
      role,
    );
    if (
      !sample ||
      now.getTime() - Date.parse(sample.checked_at) > PROCESS_HEALTH_STALE_MS
    )
      return;
    return sample;
  } catch {
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** What the health page shows: this process, plus the background one. */
export function processHealthView(
  dataDir: string,
  role: ProcessRole,
  now = new Date(),
): { readonly processes: readonly ProcessHealth[] } {
  const background =
    role === "web" ? readProcessHealth(dataDir, "background", now) : undefined;
  return {
    processes: [
      sampleProcessHealth(role, now),
      ...(background ? [background] : []),
    ],
  };
}

/** Background role: publish now and every interval until stopped. */
export function publishProcessHealth(
  dataDir: string,
  role: ProcessRole,
  intervalMs = PROCESS_HEALTH_INTERVAL_MS,
): () => void {
  const publish = () => {
    try {
      writeProcessHealth(dataDir, sampleProcessHealth(role));
    } catch {
      // Retried on the next interval; the page shows the sample as missing.
    }
  };
  publish();
  const timer = setInterval(publish, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
