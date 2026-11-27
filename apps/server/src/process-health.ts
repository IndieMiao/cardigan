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

/**
 * C-835: one hourly point of a process's short history. `boot_id` is new on
 * every start, so points of one continuous run share it and a restart opens
 * a new segment.
 */
export interface ProcessHealthPoint {
  readonly boot_id: string;
  readonly started_at: string;
  readonly checked_at: string;
  readonly heap_used_bytes: number;
  readonly heap_limit_bytes: number;
  readonly rss_bytes: number;
}

/** C-835: one continuous run (one `boot_id`) within the short history. */
export interface ProcessHealthSegment {
  readonly boot_id: string;
  readonly started_at: string;
  readonly first_at: string;
  readonly last_at: string;
  readonly points: number;
  /** Least-squares heap growth; null below two points (cannot be computed). */
  readonly heap_growth_bytes_per_day: number | null;
}

export interface ProcessHealthHistory {
  readonly points: readonly ProcessHealthPoint[];
  readonly segments: readonly ProcessHealthSegment[];
}

export interface ProcessHealthEntry extends ProcessHealth {
  readonly history: ProcessHealthHistory;
}

export const PROCESS_HEALTH_INTERVAL_MS = 30_000;
/** A published sample older than this belongs to a stopped process. */
export const PROCESS_HEALTH_STALE_MS = 10 * 60_000;
/** C-835: one history point per hour of continuous running. */
export const PROCESS_HEALTH_HISTORY_INTERVAL_MS = 60 * 60_000;
/** C-835: default points kept per process (two days at one per hour). */
export const PROCESS_HEALTH_HISTORY_POINTS = 48;
export const PROCESS_HEALTH_HISTORY_POINTS_MAX = 720;
const FILE_LIMIT = 4096;
const HISTORY_FILE_LIMIT = 512 * 1024;
const DAY_MS = 86_400_000;
const BOOT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * C-835: `CARDIGAN_PROCESS_HEALTH_HISTORY_POINTS`, an integer 2–720; unset
 * means 48. An invalid value keeps the default and is reported once.
 */
export function processHealthHistoryPoints(
  env: { readonly CARDIGAN_PROCESS_HEALTH_HISTORY_POINTS?: string | undefined },
  warn: (line: string) => void = () => {},
): number {
  const text = env.CARDIGAN_PROCESS_HEALTH_HISTORY_POINTS?.trim();
  if (!text) return PROCESS_HEALTH_HISTORY_POINTS;
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (value >= 2 && value <= PROCESS_HEALTH_HISTORY_POINTS_MAX) return value;
  warn(
    `CARDIGAN_PROCESS_HEALTH_HISTORY_POINTS 须为 2–${PROCESS_HEALTH_HISTORY_POINTS_MAX} 的整数，已按默认 ${PROCESS_HEALTH_HISTORY_POINTS} 个点保留`,
  );
  return PROCESS_HEALTH_HISTORY_POINTS;
}

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
const instant = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

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

function parsePoint(value: unknown): ProcessHealthPoint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    typeof v.boot_id !== "string" ||
    !BOOT_ID.test(v.boot_id) ||
    !instant(v.started_at) ||
    !instant(v.checked_at) ||
    !count(v.heap_used_bytes) ||
    !count(v.heap_limit_bytes) ||
    !count(v.rss_bytes)
  )
    return;
  return {
    boot_id: v.boot_id,
    started_at: new Date(v.started_at).toISOString(),
    checked_at: new Date(v.checked_at).toISOString(),
    heap_used_bytes: v.heap_used_bytes,
    heap_limit_bytes: v.heap_limit_bytes,
    rss_bytes: v.rss_bytes,
  };
}

function writeAtomically(dataDir: string, name: string, content: string) {
  const dir = processHealthDirectory(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error("process-health");
  const path = join(dir, name);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** A regular file under the health directory, no larger than `limit`. */
function readSmallFile(path: string, limit: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit) return;
    const buffer = Buffer.alloc(info.size);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Publish this process's sample; failures are left for the next interval. */
export function writeProcessHealth(dataDir: string, sample: ProcessHealth) {
  writeAtomically(
    dataDir,
    `${sample.role}.json`,
    `${JSON.stringify(sample)}\n`,
  );
}

/** The last published sample of `role`, unless missing, invalid or stale. */
export function readProcessHealth(
  dataDir: string,
  role: ProcessRole,
  now = new Date(),
): ProcessHealth | undefined {
  const text = readSmallFile(
    join(processHealthDirectory(dataDir), `${role}.json`),
    FILE_LIMIT,
  );
  if (text === undefined) return;
  try {
    const sample = parse(JSON.parse(text), role);
    if (
      !sample ||
      now.getTime() - Date.parse(sample.checked_at) > PROCESS_HEALTH_STALE_MS
    )
      return;
    return sample;
  } catch {
    return;
  }
}

const historyName = (role: ProcessRole) => `${role}-history.json`;

/**
 * C-835: the kept hourly points of `role`, oldest first. A missing or
 * unreadable file is an empty history; invalid points are dropped.
 */
export function readProcessHealthHistory(
  dataDir: string,
  role: ProcessRole,
): readonly ProcessHealthPoint[] {
  const text = readSmallFile(
    join(processHealthDirectory(dataDir), historyName(role)),
    HISTORY_FILE_LIMIT,
  );
  if (text === undefined) return [];
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const v = value as Record<string, unknown>;
    if (v.role !== role || !Array.isArray(v.points)) return [];
    return v.points
      .slice(-PROCESS_HEALTH_HISTORY_POINTS_MAX)
      .map(parsePoint)
      .filter((p): p is ProcessHealthPoint => p !== undefined);
  } catch {
    return [];
  }
}

/**
 * C-835: append one point and keep only the newest `limit`, so the file
 * stays bounded across restarts.
 */
export function appendProcessHealthHistory(
  dataDir: string,
  role: ProcessRole,
  point: ProcessHealthPoint,
  limit = PROCESS_HEALTH_HISTORY_POINTS,
) {
  const points = [...readProcessHealthHistory(dataDir, role), point].slice(
    -Math.max(1, Math.min(limit, PROCESS_HEALTH_HISTORY_POINTS_MAX)),
  );
  writeAtomically(
    dataDir,
    historyName(role),
    `${JSON.stringify({ role, points })}\n`,
  );
}

/** Least-squares slope of heap use over time, in bytes per day. */
function growthPerDay(points: readonly ProcessHealthPoint[]): number | null {
  if (points.length < 2) return null;
  const xs = points.map((p) => Date.parse(p.checked_at));
  const x0 = xs[0] ?? 0;
  const t = xs.map((x) => (x - x0) / DAY_MS);
  const y = points.map((p) => p.heap_used_bytes);
  const n = points.length;
  const tMean = t.reduce((a, b) => a + b, 0) / n;
  const yMean = y.reduce((a, b) => a + b, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    const dt = (t[i] ?? 0) - tMean;
    numerator += dt * ((y[i] ?? 0) - yMean);
    denominator += dt * dt;
  }
  if (!(denominator > 0)) return null;
  return Math.round(numerator / denominator);
}

/** C-835: group the points by continuous run, in order of first point. */
export function processHealthSegments(
  points: readonly ProcessHealthPoint[],
): readonly ProcessHealthSegment[] {
  const runs = new Map<string, ProcessHealthPoint[]>();
  for (const point of points) {
    const run = runs.get(point.boot_id);
    if (run) run.push(point);
    else runs.set(point.boot_id, [point]);
  }
  return [...runs.values()].map((run) => {
    const sorted = [...run].sort(
      (a, b) => Date.parse(a.checked_at) - Date.parse(b.checked_at),
    );
    const first = sorted[0] as ProcessHealthPoint;
    const last = sorted[sorted.length - 1] as ProcessHealthPoint;
    return {
      boot_id: first.boot_id,
      started_at: first.started_at,
      first_at: first.checked_at,
      last_at: last.checked_at,
      points: sorted.length,
      heap_growth_bytes_per_day: growthPerDay(sorted),
    };
  });
}

function withHistory(
  dataDir: string,
  sample: ProcessHealth,
): ProcessHealthEntry {
  const points = readProcessHealthHistory(dataDir, sample.role);
  return {
    ...sample,
    history: { points, segments: processHealthSegments(points) },
  };
}

/** What the health page shows: this process, plus the background one. */
export function processHealthView(
  dataDir: string,
  role: ProcessRole,
  now = new Date(),
): { readonly processes: readonly ProcessHealthEntry[] } {
  const background =
    role === "web" ? readProcessHealth(dataDir, "background", now) : undefined;
  return {
    processes: [
      withHistory(dataDir, sampleProcessHealth(role, now)),
      ...(background ? [withHistory(dataDir, background)] : []),
    ],
  };
}

export interface PublishProcessHealthOptions {
  readonly intervalMs?: number;
  readonly historyIntervalMs?: number;
  readonly historyPoints?: number;
}

/**
 * Publish now and every interval until stopped. C-835: after each full hour
 * of running, also append a history point for this start; the start itself
 * is not a point, so warm-up does not count as growth.
 */
export function publishProcessHealth(
  dataDir: string,
  role: ProcessRole,
  options: PublishProcessHealthOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? PROCESS_HEALTH_INTERVAL_MS;
  const historyIntervalMs =
    options.historyIntervalMs ?? PROCESS_HEALTH_HISTORY_INTERVAL_MS;
  const historyPoints = options.historyPoints ?? PROCESS_HEALTH_HISTORY_POINTS;
  const bootId = randomUUID();
  const startedAt = new Date();
  let lastPointAt = startedAt.getTime();
  const publish = () => {
    const sample = sampleProcessHealth(role);
    try {
      writeProcessHealth(dataDir, sample);
    } catch {
      // Retried on the next interval; the page shows the sample as missing.
    }
    const at = Date.parse(sample.checked_at);
    if (at - lastPointAt < historyIntervalMs) return;
    lastPointAt = at;
    try {
      appendProcessHealthHistory(
        dataDir,
        role,
        {
          boot_id: bootId,
          started_at: startedAt.toISOString(),
          checked_at: sample.checked_at,
          heap_used_bytes: sample.heap_used_bytes,
          heap_limit_bytes: sample.heap_limit_bytes,
          rss_bytes: sample.rss_bytes,
        },
        historyPoints,
      );
    } catch {
      // This hour's point is lost; the next one follows an hour later.
    }
  };
  publish();
  const timer = setInterval(publish, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
