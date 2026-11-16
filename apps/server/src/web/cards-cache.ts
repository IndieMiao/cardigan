import { createHash, randomUUID } from "node:crypto";
import type { ProjectId } from "@cardigan/domain";
import type { Store } from "@cardigan/store";
import { readCardsPage } from "./cards-page.js";

type Page = ReturnType<typeof readCardsPage>;
type Entry = { version: string; expires: number; page: Page };
const caches = new WeakMap<Store, Map<string, Entry[]>>();
export interface CardsCacheOptions {
  readonly ttlMs?: number;
  readonly maxQueries?: number;
}

/** Human-only read projection; the HTTP session/project checks run BEFORE this.
 * Include all queue dependencies (other projects and bell reservations). Versions
 * are checked inside the same transaction, including rollback generations.
 */
export function readCachedCardsPage(
  store: Store,
  project: ProjectId,
  url: URL,
  options: CardsCacheOptions = {},
) {
  const ttlMs = options.ttlMs ?? 5_000;
  const maxQueries = options.maxQueries ?? 64;
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 0 ||
    !Number.isSafeInteger(maxQueries) ||
    maxQueries < 1
  )
    throw new Error("Invalid cards cache options");
  const query = new URL(url);
  const since = query.searchParams.get("since_version");
  query.searchParams.delete("since_version");
  query.searchParams.sort();
  const key = JSON.stringify([project, query.search, ttlMs, maxQueries]);
  let cache = caches.get(store);
  if (!cache) {
    cache = new Map();
    caches.set(store, cache);
  }
  const entries = cache.get(key) ?? [];
  const result = store.uow.read((tx) => {
    const revision = store.snapshotVersion(project);
    const version = createHash("sha256")
      .update(
        JSON.stringify([
          key,
          revision ?? randomUUID(),
          revision === undefined
            ? null
            : store.database
                .prepare(
                  "SELECT project_id, collection, version FROM command_versions ORDER BY project_id, collection",
                )
                .all(),
        ]),
      )
      .digest("hex");
    const current = entries.find(
      (e) => e.version === version && e.expires > Date.now(),
    );
    if (current) return current;
    return {
      version,
      expires: Date.now() + ttlMs,
      page: readCardsPage(store, project, query, tx),
    };
  });
  // Publish only after the read commits. Retain one prior version for small deltas.
  cache.delete(key);
  cache.set(
    key,
    [result, ...entries.filter((e) => e.version !== result.version)].slice(
      0,
      2,
    ),
  );
  while (cache.size > maxQueries)
    cache.delete(cache.keys().next().value as string);
  const previous = entries.find((e) => e.version === since);
  if (!previous) return { ...result.page, snapshot_version: result.version };
  const old = new Map(
    previous.page.cards.map((c) => [c.id, JSON.stringify(c)]),
  );
  return {
    ...result.page,
    snapshot_version: result.version,
    delta: true,
    card_ids: result.page.cards.map((c) => c.id),
    cards: result.page.cards.filter((c) => old.get(c.id) !== JSON.stringify(c)),
  };
}
