import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { CardId, ProjectId } from "@cardigan/domain";
import type { Store } from "@cardigan/store";

/**
 * C-688 defaults: an open detail revalidates on every live change of its card.
 * The answer is kept per exact query while nothing at all was written (any
 * project, rollbacks included) and for at most `ttlMs`, the same bound the
 * cards page uses for inputs outside the versions (clock, other tables).
 */
export const CARD_DETAIL_CACHE_DEFAULTS = {
  ttlMs: 5_000,
  maxEntries: 64,
} as const;

interface Entry {
  readonly version: string;
  readonly expires: number;
  readonly etag: string;
  readonly body: string;
  /** Compressed once per answer, on the first client that accepts it. */
  gzip?: Uint8Array;
}

/** Smaller bodies are not worth a compression pass. */
const GZIP_MIN_BYTES = 1024;
const caches = new WeakMap<Store, Map<string, Entry>>();
const epochs = new WeakMap<Store, string>();

export interface CardDetailRead {
  readonly project: ProjectId;
  readonly card: CardId;
  readonly url: string;
  readonly mergeGateStatus: string;
  readonly ifNoneMatch?: string | undefined;
  readonly acceptGzip?: boolean | undefined;
}

export interface CardDetailAnswer {
  /** Absent when the client's validator still matches (HTTP 304) or `gzip` is set. */
  readonly body?: string;
  /** The body gzip-encoded, when the client accepts it and it is large enough. */
  readonly gzip?: Uint8Array;
  readonly etag: string;
  readonly notModified: boolean;
}

/** Every committed entity write changes it; undefined without command versions. */
function storeVersion(store: Store, project: ProjectId): string | undefined {
  return store.uow.read(() => {
    const revision = store.snapshotVersion(project);
    if (revision === undefined) return undefined;
    let epoch = epochs.get(store);
    if (!epoch) {
      epoch = randomUUID();
      epochs.set(store, epoch);
    }
    return JSON.stringify([
      epoch,
      revision,
      store.database
        .prepare(
          // Bell delivery bookkeeping is written all the time and never read
          // by a card detail, as in the Store's own command-state version.
          "SELECT project_id, collection, version FROM command_versions WHERE collection NOT IN ('notifications', 'bell_attempts') ORDER BY project_id, collection",
        )
        .all(),
    ]);
  });
}

const opaque = (tag: string) => tag.trim().replace(/^W\//, "");

/** `If-None-Match` (weak comparison): a list of validators, or `*`. */
export function matchesValidator(
  header: string | undefined,
  etag: string,
): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map(opaque)
    .some((tag) => tag === "*" || tag === opaque(etag));
}

/**
 * The weak ETag covers the response without its `now` stamp, so an unchanged
 * card answers 304 even though the stamp moved. `read` returns the payload.
 */
export function readCardDetailCached(
  store: Store,
  request: CardDetailRead,
  read: () => Record<string, unknown>,
  options: {
    ttlMs?: number;
    maxEntries?: number;
    /** C-774: version check, serialization and compression, in ms. */
    recordTiming?: (stage: string, ms: number) => void;
  } = {},
): CardDetailAnswer {
  const timed = <T>(stage: string, fn: () => T): T => {
    if (!options.recordTiming) return fn();
    const started = performance.now();
    try {
      return fn();
    } finally {
      options.recordTiming(stage, performance.now() - started);
    }
  };
  const ttlMs = options.ttlMs ?? CARD_DETAIL_CACHE_DEFAULTS.ttlMs;
  const maxEntries =
    options.maxEntries ?? CARD_DETAIL_CACHE_DEFAULTS.maxEntries;
  const query = new URL(request.url).searchParams;
  query.sort();
  const key = JSON.stringify([
    request.project,
    request.card,
    query.toString(),
    request.mergeGateStatus,
  ]);
  let cache = caches.get(store);
  if (!cache) {
    cache = new Map();
    caches.set(store, cache);
  }
  // Read before the detail: a write in between only costs a later rebuild.
  const version = timed("detail_version", () =>
    storeVersion(store, request.project),
  );
  let entry = cache.get(key);
  if (
    !entry ||
    version === undefined ||
    entry.version !== version ||
    entry.expires <= Date.now()
  ) {
    const payload = read();
    entry = timed("detail_serialize", () => {
      const { now: _now, ...stable } = payload;
      const etag = `W/"${createHash("sha256")
        .update(key)
        .update("\0")
        .update(JSON.stringify(stable))
        .digest("base64url")
        .slice(0, 32)}"`;
      return {
        version: version ?? "",
        expires: Date.now() + ttlMs,
        etag,
        body: JSON.stringify(payload),
      };
    });
    if (version !== undefined) {
      cache.delete(key);
      cache.set(key, entry);
      while (cache.size > maxEntries)
        cache.delete(cache.keys().next().value as string);
    }
  }
  if (matchesValidator(request.ifNoneMatch, entry.etag))
    return { etag: entry.etag, notModified: true };
  if (request.acceptGzip && entry.body.length >= GZIP_MIN_BYTES) {
    const body = entry.body;
    entry.gzip ??= timed("detail_gzip", () => gzipSync(body));
    return { etag: entry.etag, gzip: entry.gzip, notModified: false };
  }
  return { etag: entry.etag, body: entry.body, notModified: false };
}
