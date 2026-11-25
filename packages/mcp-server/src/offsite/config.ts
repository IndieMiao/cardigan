import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { OssCredentials } from "./oss.js";

/**
 * C-614: the host-only storage credential. The file lives in
 * `<config dir>/storage/aliyun-config.json` (0600, directory 0700), separate
 * from the publication credentials, and is never copied, logged or exposed to
 * an Agent. Missing means "off-site copy not configured": every local path
 * keeps working exactly as before.
 */
export const STORAGE_CONFIG_FILE = "aliyun-config.json";

/** Yuan per unit; rough list prices, overridable in the file. */
export const DEFAULT_PRICES = Object.freeze({
  storage_gb_month: 0.13,
  egress_gb: 0.55,
  image_process_gb: 0.025,
  requests_10k: 0.01,
});
export const DEFAULT_MONTHLY_BUDGET_YUAN = 50;
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 600;

const name = z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u);
const region = z.string().regex(/^(?:oss-)?[a-z]{2}-[a-z0-9-]+$/u);
const secret = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[\x21-\x7e]+$/u);
const profile = z.object({
  mode: z.literal("AK"),
  region_id: region,
  access_key_id: secret,
  access_key_secret: secret,
});
const schema = z.object({
  bucket: name,
  region: region.optional(),
  access_key_id: secret.optional(),
  access_key_secret: secret.optional(),
  /** Aliyun CLI layout with exactly one AK profile, as for publication. */
  profiles: z.array(profile.passthrough()).length(1).optional(),
  /** Loopback fakes only; production uses the bucket's own origin. */
  endpoint: z
    .string()
    .regex(/^http:\/\/127\.0\.0\.1:\d{1,5}$/u)
    .optional(),
  monthly_budget_yuan: z.number().nonnegative().max(1_000_000).optional(),
  signed_url_ttl_seconds: z.number().int().min(120).max(3600).optional(),
  prices: z
    .object({
      storage_gb_month: z.number().nonnegative().optional(),
      egress_gb: z.number().nonnegative().optional(),
      image_process_gb: z.number().nonnegative().optional(),
      requests_10k: z.number().nonnegative().optional(),
    })
    .strict()
    .optional(),
});

export interface OffsiteSettings {
  readonly credentials: OssCredentials;
  readonly monthly_budget_yuan: number;
  readonly signed_url_ttl_seconds: number;
  readonly prices: Readonly<Record<keyof typeof DEFAULT_PRICES, number>>;
}
export type OffsiteConfig =
  | { readonly state: "absent" }
  | { readonly state: "invalid" }
  | { readonly state: "ready"; readonly settings: OffsiteSettings };

const owner = () => process.getuid?.();
function privateDirectory(path: string) {
  const info = lstatSync(path);
  return (
    info.isDirectory() && info.uid === owner() && (info.mode & 0o777) === 0o700
  );
}

/** Synchronous: one small file, read at most once per cache window. */
export function readOffsiteConfig(storageDir: string): OffsiteConfig {
  let fd: number | undefined;
  try {
    try {
      if (!privateDirectory(storageDir)) return { state: "invalid" };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { state: "absent" }
        : { state: "invalid" };
    }
    try {
      fd = openSync(
        join(storageDir, STORAGE_CONFIG_FILE),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { state: "absent" }
        : { state: "invalid" };
    }
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.uid !== owner() ||
      (info.mode & 0o777) !== 0o600 ||
      info.size === 0 ||
      info.size > 65536
    )
      return { state: "invalid" };
    const buffer = Buffer.alloc(info.size);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, read);
      if (n === 0) break;
      read += n;
    }
    const parsed = schema.safeParse(
      JSON.parse(buffer.subarray(0, read).toString("utf8")),
    );
    if (!parsed.success) return { state: "invalid" };
    const c = parsed.data;
    const p = c.profiles?.[0];
    const id = p?.access_key_id ?? c.access_key_id;
    const key = p?.access_key_secret ?? c.access_key_secret;
    const where = c.region ?? p?.region_id;
    if (
      !id ||
      !key ||
      !where ||
      (p && (c.access_key_id || c.access_key_secret)) ||
      (p && c.region && c.region !== p.region_id)
    )
      return { state: "invalid" };
    return {
      state: "ready",
      settings: Object.freeze({
        credentials: Object.freeze({
          bucket: c.bucket,
          region: where.replace(/^oss-/u, ""),
          access_key_id: id,
          access_key_secret: key,
          ...(c.endpoint ? { endpoint: c.endpoint } : {}),
        }),
        monthly_budget_yuan:
          c.monthly_budget_yuan ?? DEFAULT_MONTHLY_BUDGET_YUAN,
        signed_url_ttl_seconds:
          c.signed_url_ttl_seconds ?? DEFAULT_SIGNED_URL_TTL_SECONDS,
        prices: Object.freeze({
          ...DEFAULT_PRICES,
          ...Object.fromEntries(
            Object.entries(c.prices ?? {}).filter(([, v]) => v !== undefined),
          ),
        }),
      }),
    };
  } catch {
    return { state: "invalid" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
