import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readPrivateConfig } from "@cardigan/host";
import { parse } from "yaml";

/**
 * C-734: host-only image generation settings. The credential is named by a
 * path to a 0600 file and read at call time; it never enters this object,
 * the Agent environment, events or logs.
 */
export interface ImageGenerationConfig {
  /** Who enables a project or role; shown when a call is refused. */
  readonly contact: string;
  readonly provider: {
    /** Display name recorded in provenance. */
    readonly name: string;
    /** OpenAI-compatible images API root, e.g. `https://host/v1`. */
    readonly base_url: string;
    readonly api_key_file: string;
    readonly models: readonly string[];
    readonly default_model: string;
    readonly max_n: number;
    /** Ceiling for one provider request, downloads included. */
    readonly timeout_ms: number;
    readonly max_concurrent: number;
  };
  /** Enabled roles per project; anything absent is refused. */
  readonly projects: Readonly<Record<string, readonly string[]>>;
}
export const IMAGE_GENERATION_DEFAULT_CONTACT = "主机运维";
const invalid = (): never => {
  throw new Error("生图配置无效");
};
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : invalid();
const text = (v: unknown, pattern: RegExp) =>
  typeof v === "string" && pattern.test(v) ? v : invalid();
const integer = (v: unknown, min: number, max: number, fallback: number) =>
  v === undefined
    ? fallback
    : typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max
      ? v
      : invalid();
const only = (o: Record<string, unknown>, keys: readonly string[]) => {
  if (Object.keys(o).some((key) => !keys.includes(key))) invalid();
};
const ID = /^[A-Za-z0-9_-]{1,80}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const RESERVED = ["__proto__", "constructor", "prototype"];

export function parseImageGenerationConfig(
  source: string,
  home = homedir(),
): ImageGenerationConfig {
  const root = object(parse(source, { maxAliasCount: 0 }) ?? {});
  only(root, ["contact", "provider", "projects"]);
  const p = object(root.provider);
  only(p, [
    "name",
    "base_url",
    "api_key_file",
    "models",
    "default_model",
    "max_n",
    "timeout_ms",
    "max_concurrent",
  ]);
  const base = text(p.base_url, /^https?:\/\/[^\s?#]+$/u).replace(/\/+$/u, "");
  try {
    const url = new URL(base);
    if (url.username || url.password) invalid();
  } catch {
    invalid();
  }
  const rawKey = text(p.api_key_file, /^[^\0\n]{1,1024}$/u);
  const keyFile = rawKey.startsWith("~/")
    ? join(home, rawKey.slice(2))
    : rawKey;
  if (!isAbsolute(keyFile)) invalid();
  const models = Array.isArray(p.models)
    ? p.models.map((m) => text(m, MODEL))
    : invalid();
  if (models.length === 0 || models.length > 32) invalid();
  const defaultModel =
    p.default_model === undefined
      ? (models[0] as string)
      : text(p.default_model, MODEL);
  if (!models.includes(defaultModel)) invalid();
  const projects: Record<string, readonly string[]> = Object.create(null);
  for (const [project, raw] of Object.entries(object(root.projects ?? {}))) {
    if (!ID.test(project) || RESERVED.includes(project)) invalid();
    const entry = object(raw);
    only(entry, ["roles"]);
    if (!Array.isArray(entry.roles)) invalid();
    projects[project] = (entry.roles as unknown[]).map((r) => text(r, ID));
  }
  return {
    contact:
      root.contact === undefined
        ? IMAGE_GENERATION_DEFAULT_CONTACT
        : text(root.contact, /^[^\0\n]{1,80}$/u),
    provider: {
      name: p.name === undefined ? "image-provider" : text(p.name, ID),
      base_url: base,
      api_key_file: keyFile,
      models,
      default_model: defaultModel,
      max_n: integer(p.max_n, 1, 10, 4),
      timeout_ms: integer(p.timeout_ms, 10_000, 30 * 60_000, 5 * 60_000),
      max_concurrent: integer(p.max_concurrent, 1, 16, 4),
    },
    projects,
  };
}
export type LoadedImageGenerationConfig =
  | { readonly status: "absent" }
  | { readonly status: "invalid" }
  | { readonly status: "ready"; readonly config: ImageGenerationConfig };
/** Host-owned 0600 file; a missing file disables generation everywhere. */
export function loadImageGenerationConfig(
  path: string,
): LoadedImageGenerationConfig {
  try {
    const source = readPrivateConfig(path);
    return source === undefined
      ? { status: "absent" }
      : { status: "ready", config: parseImageGenerationConfig(source) };
  } catch {
    return { status: "invalid" };
  }
}
