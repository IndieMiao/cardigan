import { createHash } from "node:crypto";
import {
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

type Listing =
  | { status: "ok" | "partial"; ids: readonly string[] }
  | { status: "failed" };

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Protocol family → the models.dev provider whose metadata a listed ID may borrow. */
const FAMILY: Record<string, string> = {
  "anthropic-messages": "anthropic",
  "openai-responses": "openai",
  "openai-completions": "openai",
};

/**
 * C-564: the models a saved Provider can be set to, for the launch profile
 * form. Two sources: the public models.dev catalog (matched by the Provider's
 * ID or the catalog provider of its model aliases) and the Provider's own
 * `/models` listing, made on the host with the Provider's own credential to
 * its own endpoint only. Never calls inference; the credential never leaves
 * the host, and the answer holds only model IDs and public metadata.
 * Each Provider's listing is cached apart, keyed by its endpoint, protocol
 * and credential, so one Provider never answers for another.
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
    } = {},
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private readCatalog(file: SettingsFile) {
    const now = this.now();
    if (this.catalog && this.catalog.until > now) return this.catalog.value;
    const entry = {
      until: now + MODEL_CATALOG_RETRY_MS,
      value: readModelCatalog(this.dataDir, file.config.model_catalog, {
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        now: () => new Date(this.now()),
      }).catch(() => undefined),
    };
    this.catalog = entry;
    // A fresh snapshot is reused for the catalog's own age limit.
    void entry.value.then((snapshot) => {
      if (snapshot?.fresh && this.catalog === entry)
        entry.until =
          Date.parse(snapshot.fetched_at) +
          (file.config.model_catalog?.max_age_ms ?? 24 * 60 * 60_000);
    });
    return entry.value;
  }
  private readListing(
    file: SettingsFile,
    target: ReturnType<typeof providerTarget>,
  ) {
    const { resolved, definition } = target;
    const provider = resolved.provider?.definition;
    // The credential takes part in the key only as a digest.
    const key = digest(
      JSON.stringify({
        id: resolved.provider?.name,
        harness: resolved.profile.harness,
        api: provider?.api,
        base_url: provider?.base_url,
        codex: definition.codex ?? null,
        secrets: Object.entries(definition.secret_env).map(([env, ref]) => [
          env,
          ref,
          digest(file.secrets[ref] ?? ""),
        ]),
        limits: file.config.launch_check ?? null,
      }),
    );
    const now = this.now();
    const cached = this.lists.get(key);
    if (cached && cached.until > now) return cached.value;
    const entry = {
      until: now + MODEL_LIST_TTL_MS,
      value: (async (): Promise<Listing> => {
        let timer: NodeJS.Timeout | undefined;
        try {
          const listed = await Promise.race([
            listProviderModels(
              resolved,
              file.secrets,
              file.config.launch_check,
              this.options.fetch,
            ),
            new Promise<never>((_, reject) => {
              timer = setTimeout(reject, MODEL_LIST_DEADLINE_MS);
              timer.unref?.();
            }),
          ]);
          return {
            status: listed.complete ? "ok" : "partial",
            ids: listed.ids,
          };
        } catch {
          return { status: "failed" };
        } finally {
          clearTimeout(timer);
        }
      })(),
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
  async list(file: SettingsFile, id: string): Promise<ModelListView> {
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
    const [snapshot, listing] = await Promise.all([
      this.readCatalog(file),
      target && !missing
        ? this.readListing(file, target)
        : Promise.resolve(undefined),
    ]);
    // The catalog providers this Provider stands for.
    const matched = new Set<string>();
    const known = new Set(snapshot?.entries.map((e) => e.provider));
    if (known.has(id)) matched.add(id);
    for (const model of Object.values(config.models ?? {}))
      if (model.provider === id) {
        const name = model.catalog_provider ?? model.provider;
        if (known.has(name)) matched.add(name);
      }
    const plain = (value: string) => publicFields(value, secrets) === value;
    const byId = new Map<string, CatalogEntry>();
    const family = FAMILY[target?.resolved.provider?.definition.api ?? ""];
    for (const entry of snapshot?.entries ?? [])
      if (matched.has(entry.provider) || entry.provider === family) {
        const own = matched.has(entry.provider);
        // A matched provider's row wins over the protocol family's.
        if (own || !byId.has(entry.id)) byId.set(entry.id, entry);
      }
    const options = new Map<string, ModelOption>();
    const add = (modelId: string, source: "catalog" | "provider") => {
      if (!plain(modelId)) return;
      const old = options.get(modelId);
      if (old) {
        if (!old.sources.includes(source))
          options.set(modelId, {
            ...old,
            sources: [...old.sources, source],
          });
        return;
      }
      const meta = byId.get(modelId);
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
    for (const entry of snapshot?.entries ?? [])
      if (matched.has(entry.provider)) add(entry.id, "catalog");
    if (listing && listing.status !== "failed")
      for (const modelId of listing.ids) add(modelId, "provider");
    return {
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
        providers: [...matched].filter(plain),
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
  }
}
