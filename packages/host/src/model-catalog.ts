import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CatalogEntry,
  catalogCache,
  catalogEntries,
  prepareLaunchConfig,
} from "@cardigan/roles";

const CACHE = "models-dev.json";
const SOURCE = "https://models.dev/api.json";
const DAY_MS = 24 * 60 * 60 * 1000;

function readCache(dir: string) {
  try {
    return catalogCache.parse(
      JSON.parse(readFileSync(join(dir, CACHE), "utf8")),
    );
  } catch {
    return undefined;
  }
}

/** Read-only CLI views never contact the network. Legacy configs do no catalog IO. */
export function parseCachedLaunchConfig(config: unknown, dir: string) {
  const parsed = prepareLaunchConfig(config);
  return parsed.resolve(
    parsed.catalogPolicy ? readCache(dir)?.entries : undefined,
  );
}

export async function loadModelLaunchConfig(
  config: unknown,
  dir: string,
  options: {
    fetch?: typeof fetch;
    now?: () => Date;
  } = {},
) {
  const parsed = prepareLaunchConfig(config);
  if (!parsed.catalogPolicy) return parsed.resolve();
  const {
    max_age_ms = DAY_MS,
    timeout_ms = 5_000,
    max_bytes = 32 * 1024 * 1024,
  } = parsed.catalogPolicy;
  const cache = readCache(dir);
  const now = options.now?.() ?? new Date();
  const age = now.getTime() - Date.parse(cache?.fetched_at ?? "");
  if (cache && age >= 0 && age < max_age_ms)
    return parsed.resolve(cache.entries);

  let entries: CatalogEntry[];
  try {
    const response = await (options.fetch ?? fetch)(SOURCE, {
      signal: AbortSignal.timeout(timeout_ms),
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
      if (bytes > max_bytes) throw new Error("catalog too large");
      chunks.push(chunk);
    }
    entries = catalogEntries(
      JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")),
    );
  } catch {
    return parsed.resolve(cache?.entries);
  }

  const tmp = join(dir, `.${CACHE}.${randomUUID()}`);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(
      tmp,
      JSON.stringify({ fetched_at: now.toISOString(), entries }),
      { flag: "wx", mode: 0o600 },
    );
    await rename(tmp, join(dir, CACHE));
  } catch {
    // A read-only disk need not prevent using a successful public lookup.
    await rm(tmp, { force: true }).catch(() => {});
  }
  return parsed.resolve(entries);
}
