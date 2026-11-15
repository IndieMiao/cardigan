import type { UpstreamProbe } from "@cardigan/domain";
import type { Store } from "./store.js";

export interface UpstreamProbeSample extends UpstreamProbe {
  /** Host publication identity; stripped before constructing the domain view. */
  readonly publication_id?: string;
}

/** The caller may already hold its command transaction; no nested UnitOfWork. */
export function readUpstreamProbeSample(
  store: Store,
  provider: string,
  configurationKey: string,
): UpstreamProbeSample | undefined {
  const row = store.database
    .prepare(
      "SELECT doc FROM upstream_probe_samples WHERE provider = ? AND configuration_key = ?",
    )
    .get(provider, configurationKey);
  return row ? (JSON.parse(String(row.doc)) as UpstreamProbeSample) : undefined;
}

/** Fence recovery before external IO. A failed begin never starts the probe. */
export function beginUpstreamProbeSample(
  store: Store,
  configurationKey: string,
  provider: string,
  group: string,
  publicationId: string,
): boolean {
  return store.uow.run(() => {
    const previous = readUpstreamProbeSample(store, provider, configurationKey);
    const updated = store.database
      .prepare(
        "UPDATE upstream_probe_samples SET doc = json_set(doc, '$.publication_id', ?) WHERE provider = ? AND configuration_key = ?",
      )
      .run(publicationId, provider, configurationKey);
    if (updated.changes === 0)
      store.database
        .prepare(
          "INSERT INTO upstream_probe_samples (provider, configuration_key, doc) VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET configuration_key = excluded.configuration_key, doc = excluded.doc",
        )
        .run(
          provider,
          configurationKey,
          JSON.stringify({
            provider,
            group,
            status: "unknown",
            publication_id: publicationId,
          }),
        );
    return previous?.publication_id !== undefined;
  });
}

/** Graceful cancellation may release only its own otherwise clean observation. */
export function cancelUpstreamProbeSample(
  store: Store,
  configurationKey: string,
  provider: string,
  publicationId: string,
): void {
  store.database
    .prepare(
      "UPDATE upstream_probe_samples SET doc = json_remove(doc, '$.publication_id') WHERE provider = ? AND configuration_key = ? AND json_extract(doc, '$.publication_id') = ?",
    )
    .run(provider, configurationKey, publicationId);
}

/** One atomic SQLite statement, after connection IO completes. No origin or credentials. */
export function writeUpstreamProbeSample(
  store: Store,
  configurationKey: string,
  sample: UpstreamProbe,
  publicationId?: string,
  complete = true,
): void {
  const result = store.database
    .prepare(
      "INSERT INTO upstream_probe_samples (provider, configuration_key, doc) VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET configuration_key = excluded.configuration_key, doc = excluded.doc WHERE ? IS NULL OR (upstream_probe_samples.configuration_key = excluded.configuration_key AND json_extract(upstream_probe_samples.doc, '$.publication_id') = ?)",
    )
    .run(
      sample.provider,
      configurationKey,
      JSON.stringify({
        ...sample,
        ...(!complete && publicationId
          ? { publication_id: publicationId }
          : {}),
      }),
      publicationId ?? null,
      publicationId ?? null,
    );
  if (result.changes !== 1)
    throw new Error("Upstream probe publication no longer owned");
}
