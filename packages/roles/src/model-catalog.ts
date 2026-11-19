import { z } from "zod";

const tokens = z.number().int().positive();
const efforts = z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).nonempty();

export const modelMetadata = z.object({
  context_window: tokens.optional(),
  max_output_tokens: tokens.optional(),
  reasoning_efforts: efforts.optional(),
});

const catalogEntry = modelMetadata.extend({
  provider: z.string().min(1),
  id: z.string().min(1),
});
export const catalogCache = z.object({
  fetched_at: z.iso.datetime(),
  entries: z.array(catalogEntry),
});
export type CatalogEntry = z.infer<typeof catalogEntry>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Yield one public row at a time: the caller can stop before materializing an oversized projection. */
export function* catalogEntries(json: unknown, previous: CatalogEntry[] = []) {
  const index = new Map<string, Map<string, CatalogEntry>>();
  for (const entry of previous) {
    let group = index.get(entry.provider);
    if (!group) {
      group = new Map();
      index.set(entry.provider, group);
    }
    group.set(entry.id, entry);
  }
  let sawProvider = false;
  for (const [provider, data] of Object.entries(record(json) ?? {})) {
    const models = record(record(data)?.models);
    if (!models || !provider) throw new Error("invalid models.dev provider");
    sawProvider = true;
    for (const [id, raw] of Object.entries(models)) {
      if (!id) continue;
      const old = index.get(provider)?.get(id);
      const model = record(raw);
      const limit = record(model?.limit);
      const options = model?.reasoning_options;
      const effort = Array.isArray(options)
        ? options.find((o) => record(o)?.type === "effort")
        : undefined;
      let recovered = false;
      function field<T>(
        schema: z.ZodType<T>,
        value: unknown,
        last: T | undefined,
      ) {
        const parsed = schema.safeParse(value);
        if (parsed.success) return parsed.data;
        if (last !== undefined) recovered = true;
        return last;
      }
      // Only a row present in the response can recover fields from its old row.
      // A delisted ID is never synthesized. Valid siblings always survive.
      const entry: CatalogEntry = {
        provider,
        id,
        context_window: field(tokens, limit?.context, old?.context_window),
        max_output_tokens: field(
          tokens,
          limit?.output,
          limit?.output === undefined && limit
            ? undefined
            : old?.max_output_tokens,
        ),
        reasoning_efforts: field(
          efforts,
          effort?.values,
          model &&
            (options === undefined || (Array.isArray(options) && !effort))
            ? undefined
            : old?.reasoning_efforts,
        ),
      };
      yield { entry, recovered };
    }
  }
  if (!sawProvider) throw new Error("models.dev 未返回有效的模型目录");
}
