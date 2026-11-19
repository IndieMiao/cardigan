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
  context_window: tokens,
});
export const catalogCache = z.object({
  fetched_at: z.iso.datetime(),
  entries: z.array(catalogEntry).nonempty(),
});
export type CatalogEntry = z.infer<typeof catalogEntry>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Project only public metadata from api.json; never cache a raw response or host config. */
export function catalogEntries(json: unknown): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const [provider, data] of Object.entries(record(json))) {
    for (const [id, raw] of Object.entries(record(record(data).models))) {
      const model = record(raw);
      const limit = record(model.limit);
      const effort = Array.isArray(model.reasoning_options)
        ? model.reasoning_options.map(record).find((o) => o.type === "effort")
        : undefined;
      const parsed = catalogEntry.safeParse({
        provider,
        id,
        context_window: limit.context,
        max_output_tokens: limit.output || undefined,
        reasoning_efforts: effort?.values,
      });
      if (parsed.success) entries.push(parsed.data);
    }
  }
  if (!entries.length) throw new Error("models.dev 未返回有效的模型目录");
  return entries;
}
