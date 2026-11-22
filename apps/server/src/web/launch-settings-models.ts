import { createHash } from "node:crypto";
import {
  findProviderModel,
  listProviderModels,
  type ModelCatalogSnapshot,
  readModelCatalog,
} from "@cardigan/host";
import type { CatalogEntry } from "@cardigan/roles";
import { providerTarget } from "./launch-settings-check.js";
import {
  invalid,
  publicFields,
  type SettingsFile,
} from "./launch-settings-file.js";

/** How long a Provider's listing is reused, and a failed one before retrying. */
export const MODEL_LIST_TTL_MS = 5 * 60_000;
export const MODEL_LIST_RETRY_MS = 30_000;
/** A catalog that could not be refreshed is tried again after this. */
export const MODEL_CATALOG_RETRY_MS = 60_000;
/** The whole listing (all pages) answers within this, or counts as failed. */
export const MODEL_LIST_DEADLINE_MS = 15_000;
const MAX_CACHED_LISTS = 64;
const DAY_MS = 24 * 60 * 60_000;

export interface ModelOption {
  readonly id: string;
  /** Where the ID was found: the models.dev catalog, the Provider's own list. */
  readonly sources: readonly ("catalog" | "provider")[];
  readonly context_window?: number;
  readonly max_output_tokens?: number;
  readonly reasoning_efforts?: readonly string[];
  readonly cost?: { readonly input: number; readonly output: number };
}
export type CatalogStatus = "ok" | "stale" | "unavailable" | "not_listed";
export type ListingStatus =
  | "ok"
  | "partial"
  | "failed"
  | "no_endpoint"
  | "missing_secret";
export interface ModelListView {
  readonly version: string;
  readonly provider: string;
  readonly catalog: {
    readonly status: CatalogStatus;
    /** The models.dev providers this Provider is matched with. */
    readonly providers: readonly string[];
    readonly fetched_at: string | null;
  };
  readonly listing: { readonly status: ListingStatus };
  readonly models: readonly ModelOption[];
}
export type ModelCheckStatus =
  | "listed"
  | "not_listed"
  | "incomplete"
  | "failed"
  | "no_endpoint"
  | "missing_secret";

type Listing =
  | { status: "ok" | "partial"; ids: readonly string[] }
  | { status: "failed" };

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/**
 * C-564: the models a saved Provider can be set to, for the launch profile
 * form. Two sources:
 * - the public models.dev catalog, matched exactly: every model of the
 *   catalog provider whose name is this Provider's ID, plus each model alias
 *   of this Provider by its exact (catalog_provider or provider, id). An
 *   alias never brings in the rest of a vendor's catalog, and a protocol
 *   alone never lends metadata (docs/plans/launch-profiles.md);
 * - the Provider's own `/models` listing, made on the host with the
 *   credential it actually uses, to its own endpoint only.
 * Never calls inference. The answer holds only model IDs and public
 * metadata, all redacted against secrets.env. Listings are cached per
 * Provider definition and credential, so one Provider never answers for
 * another, nor an old credential for a new one.
 */
export class ModelLists {
  private catalog?: {
    until: number;
    value: Promise<ModelCatalogSnapshot | undefined>;
  };
  private readonly lists = new Map<
    string,
    { until: number; value: Promise<Listing> }
  >();
  constructor(
    private readonly dataDir: string,
    private readonly options: {
      fetch?: typeof fetch;
      now?: () => number;
      deadlineMs?: number;
    } = {},
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  /** Runs `work` with an abort signal that fires at the overall deadline. */
  private async withDeadline<T>(work: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.deadlineMs ?? MODEL_LIST_DEADLINE_MS,
    );
    timer.unref?.();
    try {
      return await work(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }
  private fetchOption() {
    return this.options.fetch ? { fetch: this.options.fetch } : {};
  }
  private readCatalog(file: SettingsFile) {
    const now = this.now();
    if (this.catalog && this.catalog.until > now) return this.catalog.value;
    const entry = {
      until: now + MODEL_CATALOG_RETRY_MS,
      value: readModelCatalog(this.dataDir, file.config.model_catalog, {
        ...this.fetchOption(),
        now: () => new Date(this.now()),
      }).catch(() => undefined),
    };
    this.catalog = entry;
    // A fresh snapshot is reused until the catalog's own age limit; anything
    // else waits the retry interval before downloading again.
    void entry.value.then((snapshot) => {
      if (snapshot?.fresh && this.catalog === entry)
        entry.until =
          Date.parse(snapshot.fetched_at) +
          (file.config.model_catalog?.max_age_ms ?? DAY_MS);
    });
    return entry.value;
  }
  /** The cache key: the whole Provider definition as resolved, and a digest of each credential. */
  private listingKey(
    file: SettingsFile,
    target: ReturnType<typeof providerTarget>,
  ) {
    const { resolved, definition } = target;
    return digest(
      JSON.stringify({
        id: resolved.provider?.name,
        harness: resolved.profile.harness,
        resolved: resolved.provider?.definition ?? null,
        definition,
        secrets: Object.entries(definition.secret_env).map(([env, ref]) => [
          env,
          ref,
          digest(file.secrets[ref] ?? ""),
        ]),
        limits: file.config.launch_check ?? null,
      }),
    );
  }
  private readListing(
    file: SettingsFile,
    target: ReturnType<typeof providerTarget>,
  ) {
    const key = this.listingKey(file, target);
    const now = this.now();
    const cached = this.lists.get(key);
    if (cached && cached.until > now) return cached.value;
    const entry = {
      until: now + MODEL_LIST_TTL_MS,
      value: this.withDeadline(async (signal): Promise<Listing> => {
        try {
          const listed = await listProviderModels(
            target.resolved,
            file.secrets,
            file.config.launch_check,
            { ...this.fetchOption(), signal },
          );
          return {
            status: listed.complete ? "ok" : "partial",
            ids: listed.ids,
          };
        } catch {
          return { status: "failed" };
        }
      }),
    };
    this.lists.delete(key);
    this.lists.set(key, entry);
    while (this.lists.size > MAX_CACHED_LISTS)
      this.lists.delete(this.lists.keys().next().value ?? "");
    void entry.value.then((listing) => {
      if (listing.status === "failed")
        entry.until = Math.min(entry.until, now + MODEL_LIST_RETRY_MS);
    });
    return entry.value;
  }
  /** The saved Provider, how it is reached (if at all), and whether a credential is missing. */
  private provider(file: SettingsFile, id: string) {
    const { config, secrets } = file;
    const definition = Object.hasOwn(config.providers, id)
      ? config.providers[id]
      : undefined;
    if (!definition || publicFields(id, secrets) !== id)
      throw invalid("provider");
    let target: ReturnType<typeof providerTarget> | undefined;
    try {
      target = providerTarget(file, id);
    } catch {
      target = undefined;
    }
    const missing = Object.values(definition.secret_env).some(
      (ref) => !Object.hasOwn(secrets, ref) || !secrets[ref],
    );
    return { target, missing };
  }
  async list(file: SettingsFile, id: string): Promise<ModelListView> {
    const { config, secrets } = file;
    const { target, missing } = this.provider(file, id);
    const [snapshot, listing] = await Promise.all([
      this.readCatalog(file),
      target && !missing
        ? this.readListing(file, target)
        : Promise.resolve(undefined),
    ]);
    const entries = snapshot?.entries ?? [];
    const key = (provider: string, model: string) => `${provider}\n${model}`;
    const byKey = new Map(entries.map((e) => [key(e.provider, e.id), e]));
    // Exact catalog rows for this Provider, by model ID.
    const exact = new Map<string, CatalogEntry>();
    const matched = new Set<string>();
    for (const entry of entries)
      if (entry.provider === id) {
        exact.set(entry.id, entry);
        matched.add(id);
      }
    for (const model of Object.values(config.models ?? {}))
      if (model.provider === id) {
        const row = byKey.get(
          key(model.catalog_provider ?? model.provider, model.id),
        );
        if (row) {
          if (!exact.has(row.id)) exact.set(row.id, row);
          matched.add(row.provider);
        }
      }
    const plain = (value: string) => publicFields(value, secrets) === value;
    const options = new Map<string, ModelOption>();
    const add = (modelId: string, source: "catalog" | "provider") => {
      if (!plain(modelId)) return;
      const old = options.get(modelId);
      if (old) {
        if (!old.sources.includes(source))
          options.set(modelId, { ...old, sources: [...old.sources, source] });
        return;
      }
      const meta = exact.get(modelId);
      options.set(modelId, {
        id: modelId,
        sources: [source],
        ...(meta?.context_window !== undefined && {
          context_window: meta.context_window,
        }),
        ...(meta?.max_output_tokens !== undefined && {
          max_output_tokens: meta.max_output_tokens,
        }),
        ...(meta?.reasoning_efforts !== undefined && {
          reasoning_efforts: meta.reasoning_efforts,
        }),
        ...(meta?.cost !== undefined && { cost: meta.cost }),
      });
    };
    for (const modelId of exact.keys()) add(modelId, "catalog");
    if (listing && listing.status !== "failed")
      for (const modelId of listing.ids) add(modelId, "provider");
    const view: ModelListView = {
      version: file.version,
      provider: id,
      catalog: {
        status: !snapshot
          ? "unavailable"
          : !matched.size
            ? "not_listed"
            : snapshot.fresh
              ? "ok"
              : "stale",
        providers: [...matched],
        fetched_at: snapshot?.fetched_at ?? null,
      },
      listing: {
        status: !target
          ? "no_endpoint"
          : missing
            ? "missing_secret"
            : (listing?.status ?? "failed"),
      },
      models: [...options.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };
    // Every dynamic text that leaves, including catalog metadata.
    return publicFields(view, secrets) as ModelListView;
  }
  /**
   * C-564: whether the saved Provider lists a model ID typed in the form,
   * before anything is saved. The ID is compared on the host only; nothing
   * calls inference and nothing is recorded.
   */
  async check(
    file: SettingsFile,
    id: string,
    model: string,
  ): Promise<{ provider: string; model: string; status: ModelCheckStatus }> {
    const { target, missing } = this.provider(file, id);
    if (publicFields(model, file.secrets) !== model) throw invalid("model");
    const status: ModelCheckStatus = !target
      ? "no_endpoint"
      : missing
        ? "missing_secret"
        : await this.withDeadline((signal) =>
            findProviderModel(
              target.resolved,
              file.secrets,
              file.config.launch_check,
              model,
              { ...this.fetchOption(), signal },
            ),
          ).catch(() => "failed" as const);
    return { provider: id, model, status };
  }
}
