import { HARNESSES } from "@cardigan/domain";
import { z } from "zod";
import { modelMetadata } from "./model-catalog.js";

const nameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "name must start with a lowercase letter or digit and use only a-z 0-9 . _ -",
  );

const envVarSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "not a valid environment variable name");

const harnessSchema = z.enum(HARNESSES);
const positiveMillis = z.number().int().positive().max(2_147_483_647);
// Only a credential-free origin is accepted. Probes never send an HTTP request.
const probeOrigin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/" &&
      value === url.origin
    );
  } catch {
    return false;
  }
}, "probe_url must be an http(s) origin without credentials, path, query or fragment");

/**
 * Provider = "接入点": which harness it belongs to, the endpoint it talks to,
 * and references to credentials. Credentials are only ever referenced by name:
 * `secret_env` maps an environment variable to a key in `secrets.env`.
 */
const endpoint = z.url({ protocol: /^https?$/ }).refine((value) => {
  const url = URL.parse(value);
  return (
    url !== null && !url.username && !url.password && !url.search && !url.hash
  );
}, "base_url must not contain credentials, query or fragment");
const providerSchema = z.strictObject({
  name: z.string().min(1).max(128).optional(),
  harness: harnessSchema.optional(),
  api: z
    .enum(["openai-responses", "anthropic-messages", "openai-completions"])
    .optional(),
  base_url: endpoint.optional(),
  /** Optional additional export; Pi reads the literal URL from its registry. */
  base_url_env: envVarSchema.optional(),
  pi: z.strictObject({ env_key: envVarSchema }).optional(),
  codex: z
    .strictObject({
      name: z.string().min(1).optional(),
      profile: nameSchema.optional(),
      env_key: envVarSchema.optional(),
      requires_openai_auth: z.boolean().optional(),
    })
    .optional(),
  env: z.record(envVarSchema, z.string()).default({}),
  secret_env: z.record(envVarSchema, z.string().min(1)).default({}),
  upstream: z
    .strictObject({ group: nameSchema, probe_url: probeOrigin.optional() })
    .optional(),
});

/**
 * Launch profile = "启动配置": harness, provider, model, permission mode, extra
 * arguments, auto-update switch, and the rest of what a harness CLI needs.
 */
const profileSchema = z.strictObject({
  harness: harnessSchema,
  provider: nameSchema.optional(),
  model: z.string().min(1).optional(),
  effort: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
  /** Pi only: value for `--provider`. */
  provider_flag: z.string().min(1).optional(),
  /** Claude Code only: value for `--permission-mode`. */
  permission_mode: z.string().min(1).optional(),
  /** Claude Code only: when false, Cardigan disables the auto-updater. */
  auto_update: z.boolean().optional(),
  /** Pi only: value for `PI_CODING_AGENT_DIR`, expected outside the repository. */
  agent_dir: z.string().min(1).optional(),
  /** Codex only: `-c key=value` overrides, in insertion order. */
  config: z
    .record(z.string().min(1), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
  /** Extra arguments appended after Cardigan's own. */
  args: z.array(z.string()).optional(),
});

const absolutePathSchema = z
  .string()
  .min(1)
  .regex(/^\/[^\0\n]*$/u, "must be an absolute path");

/**
 * P2a-14 ⑧: the host's local headless browser for roles with the `browser`
 * capability. Host policy only (launch.yaml lives outside every project
 * repository); without this section no Assignment gets a browser.
 */
const browserSchema = z.strictObject({
  /** Installed `@playwright/mcp` CLI, e.g. `/opt/playwright-mcp-<v>/bin/mcp-server-playwright`. */
  command: absolutePathSchema,
  /** Read-only shared Chromium, exported as `PLAYWRIGHT_BROWSERS_PATH`. */
  browsers_path: absolutePathSchema,
  // No free-form `args`: extra flags could switch the server to HTTP
  // (`--port`), attach an existing browser (`--extension`) or move the
  // browser and output directory, undoing the fixed stdio/isolated launch.
});

export const launchConfigSchema = z.strictObject({
  providers: z.record(nameSchema, providerSchema).default({}),
  launch_check: z
    .strictObject({
      max_pages: z.number().int().positive().optional(),
      timeout_ms: positiveMillis.optional(),
      max_bytes: z.number().int().positive().optional(),
    })
    .optional(),
  model_catalog: z
    .strictObject({
      max_age_ms: positiveMillis.optional(),
      max_bytes: z.number().int().positive().optional(),
      cache_max_bytes: z.number().int().positive().optional(),
      timeout_ms: positiveMillis.optional(),
    })
    .optional(),
  models: z
    .record(
      nameSchema,
      z.strictObject({
        id: z.string().min(1),
        provider: nameSchema,
        catalog_provider: nameSchema.optional(),
        ...modelMetadata.shape,
      }),
    )
    .optional(),
  profiles: z.record(nameSchema, profileSchema).default({}),
  browser: browserSchema.optional(),
  /** Freshness of read-only interaction features; not a line-failure threshold. */
  interaction_stale_after_ms: positiveMillis.optional(),
  upstream_health: z
    .strictObject({
      // No unapproved defaults: the host must explicitly set all probe timings.
      probe: z
        .strictObject({
          interval_ms: positiveMillis,
          timeout_ms: positiveMillis,
          stale_after_ms: positiveMillis,
        })
        .optional(),
      inactive_session_count: z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER)
        .default(3),
      inactivity_window_ms: positiveMillis.default(600_000),
      recurrence_window_ms: positiveMillis.default(900_000),
    })
    .optional(),
  /** C-821: model service outages seen on the sessions' own screens. */
  upstream_outage: z
    .strictObject({
      probe_interval_ms: positiveMillis.optional(),
      remind_after_ms: positiveMillis.optional(),
      resume_window_ms: positiveMillis.optional(),
    })
    .optional(),
});

export type ProviderDefinition = z.infer<typeof providerSchema>;
export type LaunchProfileDefinition = z.infer<typeof profileSchema> & {
  /** Derived metadata for this exact alias, not a user-supplied registry. */
  pi_model?: z.infer<typeof modelMetadata>;
};
export type LaunchConfig = Omit<
  z.infer<typeof launchConfigSchema>,
  "profiles"
> & {
  profiles: Record<string, LaunchProfileDefinition>;
};
export type BrowserLaunchDefinition = z.infer<typeof browserSchema>;

export interface ResolvedProfile {
  readonly name: string;
  readonly profile: LaunchProfileDefinition;
  readonly provider?: {
    readonly name: string;
    readonly definition: ProviderDefinition;
  };
}
