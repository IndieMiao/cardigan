import type { UpstreamProbe } from "@cardigan/domain";
import type { Store } from "./store.js";

/** The caller may already hold its command transaction; no nested UnitOfWork. */
export function readUpstreamProbeSample(
  store: Store,
  provider: string,
  configurationKey: string,
): UpstreamProbe | undefined {
  const row = store.database
    .prepare(
      "SELECT doc FROM upstream_probe_samples WHERE provider = ? AND configuration_key = ?",
    )
    .get(provider, configurationKey);
  return row ? (JSON.parse(String(row.doc)) as UpstreamProbe) : undefined;
}

/** One atomic SQLite statement, after connection IO completes. No origin or credentials. */
export function writeUpstreamProbeSample(
  store: Store,
  configurationKey: string,
  sample: UpstreamProbe,
): void {
  store.database
    .prepare(
      "INSERT INTO upstream_probe_samples (provider, configuration_key, doc) VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET configuration_key = excluded.configuration_key, doc = excluded.doc",
    )
    .run(sample.provider, configurationKey, JSON.stringify(sample));
}
