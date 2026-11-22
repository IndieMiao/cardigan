import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import {
  type CatalogEntry,
  catalogCache,
  catalogEntries,
  type LaunchConfig,
  prepareLaunchConfig,
} from "@cardigan/roles";

const CACHE = "models-dev.json";
const SOURCE = "https://models.dev/api.json";
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024;

function readCache(dir: string, limit = DEFAULT_CACHE_BYTES) {
  let fd: number | undefined;
  try {
    fd = openSync(
      join(dir, CACHE),
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) return undefined;
    // Read only this bounded snapshot, even if the file grows after fstat.
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const n = readSync(fd, data, offset, data.length - offset, null);
      if (!n) return undefined;
      offset += n;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null)) return undefined;
    return catalogCache.parse(JSON.parse(data.toString("utf8")));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Count the exact UTF-8 envelope, delimiters and escaped rows before retaining each row. */
function projectCache(
  json: unknown,
  now: Date,
  limit: number,
  previous?: ReturnType<typeof readCache>,
) {
  const prefix = (at: Date) =>
    `{"fetched_at":${JSON.stringify(at.toISOString())},"entries":[`;
  const rows: string[] = [];
  const entries: CatalogEntry[] = [];
  let bytes = Buffer.byteLength(prefix(now)) + 2;
  if (bytes > limit) throw new Error("catalog cache too large");
  let recovered = false;
  for (const row of catalogEntries(json, previous?.entries)) {
    const entry = row.entry;
    // Early cheap lower bound before escaping a potentially long repeated provider/ID.
    let lowerBound = bytes + entry.provider.length + entry.id.length;
    if (lowerBound > limit) throw new Error("catalog cache too large");
    for (const effort of entry.reasoning_efforts ?? []) {
      lowerBound += effort.length + 2;
      if (lowerBound > limit) throw new Error("catalog cache too large");
    }
    const text = JSON.stringify(entry);
    bytes += Buffer.byteLength(text) + (rows.length ? 1 : 0);
    if (bytes > limit) throw new Error("catalog cache too large");
    rows.push(text);
    entries.push(entry);
    recovered ||= row.recovered;
  }
  // One freshness clock for the whole snapshot: publish healthy siblings,
  // but keep the older watermark while any field still relies on it.
  const at =
    recovered && previous
      ? new Date(Math.min(now.getTime(), Date.parse(previous.fetched_at)))
      : now;
  const text = `${prefix(at)}${rows.join(",")}]}`;
  if (Buffer.byteLength(text) > limit)
    throw new Error("catalog cache too large");
  return { entries, text, fetched_at: at.toISOString() };
}

/** Read-only CLI views never contact the network. Legacy configs do no catalog IO. */
export function parseCachedLaunchConfig(config: unknown, dir: string) {
  const parsed = prepareLaunchConfig(config);
  return parsed.resolve(
    parsed.catalogPolicy
      ? readCache(dir, parsed.catalogPolicy.cache_max_bytes)?.entries
      : undefined,
  );
}

/** The bounded public models.dev download, projected to catalog rows. */
async function fetchCatalog(
  options: CatalogOptions,
  now: Date,
  cache: ReturnType<typeof readCache>,
  limits: { timeout_ms: number; max_bytes: number; cache_max_bytes: number },
) {
  const response = await (options.fetch ?? fetch)(SOURCE, {
    signal: AbortSignal.timeout(limits.timeout_ms),
    redirect: "error",
    credentials: "omit",
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("catalog unavailable");
  }
  // Enforce the limit on decoded bytes, including chunked/compressed responses.
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > limits.max_bytes) throw new Error("catalog too large");
    chunks.push(chunk);
  }
  return projectCache(
    JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")),
    now,
    limits.cache_max_bytes,
    cache,
  );
}

interface CatalogOptions {
  fetch?: typeof fetch;
  now?: () => Date;
}
interface StagedConfig {
  config: LaunchConfig;
  /** Bounded public projection. Staging confers no filesystem write capability. */
  catalog?: string;
}

/** Validation may fetch fresh public metadata, but cannot replace the shared cache.
 * The installer publishes the staged projection only after committing to this candidate. */
export async function stageModelLaunchConfig(
  config: unknown,
  dir: string,
  options: CatalogOptions = {},
): Promise<StagedConfig> {
  const parsed = prepareLaunchConfig(config);
  if (!parsed.catalogPolicy) return { config: parsed.resolve() };
  const {
    max_age_ms = DAY_MS,
    cache_max_bytes = DEFAULT_CACHE_BYTES,
    timeout_ms = 5_000,
    max_bytes = 32 * 1024 * 1024,
  } = parsed.catalogPolicy;
  const cache = readCache(dir, cache_max_bytes);
  const now = options.now?.() ?? new Date();
  const age = now.getTime() - Date.parse(cache?.fetched_at ?? "");
  if (cache && age >= 0 && age < max_age_ms)
    return { config: parsed.resolve(cache.entries) };

  let projection: ReturnType<typeof projectCache>;
  try {
    projection = await fetchCatalog(options, now, cache, {
      timeout_ms,
      max_bytes,
      cache_max_bytes,
    });
  } catch {
    return { config: parsed.resolve(cache?.entries) };
  }

  // A real removal or an unsupported effort is a configuration error, not a network failure.
  const resolved = parsed.resolve(projection.entries);
  return { config: resolved, catalog: projection.text };
}

export interface ModelCatalogSnapshot {
  readonly entries: readonly CatalogEntry[];
  readonly fetched_at: string;
  /** False when a refresh failed and this is an older snapshot. */
  readonly fresh: boolean;
}

/**
 * C-564: the models.dev catalog for the launch settings model picker. A fresh
 * shared cache is used as is; otherwise the public catalog is fetched within
 * the same limits as staging (no credentials, no redirects). Read-only: the
 * shared cache file is published only by the launch config installer. Falls
 * back to the older cache when the download fails; `undefined` when neither
 * is available.
 */
export async function readModelCatalog(
  dir: string,
  policy: LaunchConfig["model_catalog"] = {},
  options: CatalogOptions = {},
): Promise<ModelCatalogSnapshot | undefined> {
  const {
    max_age_ms = DAY_MS,
    cache_max_bytes = DEFAULT_CACHE_BYTES,
    timeout_ms = 5_000,
    max_bytes = 32 * 1024 * 1024,
  } = policy;
  const cache = readCache(dir, cache_max_bytes);
  const now = options.now?.() ?? new Date();
  const age = now.getTime() - Date.parse(cache?.fetched_at ?? "");
  if (cache && age >= 0 && age < max_age_ms)
    return {
      entries: cache.entries,
      fetched_at: cache.fetched_at,
      fresh: true,
    };
  try {
    const projection = await fetchCatalog(options, now, cache, {
      timeout_ms,
      max_bytes,
      cache_max_bytes,
    });
    return {
      entries: projection.entries,
      fetched_at: projection.fetched_at,
      fresh: true,
    };
  } catch {
    return cache
      ? { entries: cache.entries, fetched_at: cache.fetched_at, fresh: false }
      : undefined;
  }
}
