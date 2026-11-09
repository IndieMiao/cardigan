import { fileURLToPath } from "node:url";
import { DEFAULT_WEB_SESSION_TTL_MS } from "@cardigan/store";

/**
 * Workbench listener configuration (M5 plan §3.1, §3.2).
 *
 * The Workbench is a second, independent listener beside the MCP endpoint: it
 * serves `/api/*` for the SPA and the built `apps/web` assets, and it never
 * binds a non-loopback address. `CARDIGAN_WEB_PORT` can change the port only —
 * external access requires an explicitly configured HTTPS reverse proxy origin.
 */

/** Default Workbench port (M5 plan §3.1). */
export const DEFAULT_WEB_PORT = 7781;
/** The only address the Workbench may bind. */
export const DEFAULT_WEB_HOST = "127.0.0.1";

/** Bindable loopback spellings; anything else must refuse to start. */
export const WEB_LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"] as const;

export const WEB_LOCAL_ONLY_MESSAGE =
  "Workbench 只监听回环地址（127.0.0.1、::1、localhost）；对外开放需要 HTTPS 和单独拍板，从别的设备访问请用 ssh -L 隧道";

export interface WebConfig {
  /** Loopback address the listener binds. */
  readonly host: string;
  /** `0` asks the OS for a free port (tests). */
  readonly port: number;
  /** Explicit HTTPS reverse proxy origins; empty keeps local-only access. */
  readonly publicOrigins: readonly string[];
  /** Directory holding the SPA build (`apps/web/dist`). */
  readonly staticDir: string;
  /** Session lifetime; 7 days by default. */
  readonly sessionTtlMs: number;
  /** Minimum latency of a failed login, to slow down guessing (§3.2). */
  readonly loginFailureDelayMs: number;
}

export interface WebEnv {
  readonly CARDIGAN_WEB_PORT?: string | undefined;
  readonly CARDIGAN_WEB_PUBLIC_ORIGINS?: string | undefined;
}

export interface WebConfigOverrides {
  readonly host?: string;
  readonly port?: number;
  readonly staticDir?: string;
  readonly sessionTtlMs?: number;
  readonly loginFailureDelayMs?: number;
}

/** `dist/web/config.js` → `apps/web/dist` as built by `pnpm build`. */
export function defaultWebStaticDir(): string {
  return fileURLToPath(new URL("../../../web/dist/", import.meta.url));
}

/**
 * Resolve the Workbench configuration, refusing anything that would widen the
 * exposure. A non-loopback `host` is an error rather than a warning: a listener
 * that came up on the wrong interface has already leaked the token surface.
 */
export function resolveWebConfig(
  env: WebEnv = {},
  overrides: WebConfigOverrides = {},
): WebConfig {
  return {
    host: resolveWebHost(overrides.host),
    port: resolveWebPort(env.CARDIGAN_WEB_PORT, overrides.port),
    publicOrigins: resolvePublicOrigins(env.CARDIGAN_WEB_PUBLIC_ORIGINS),
    staticDir: overrides.staticDir ?? defaultWebStaticDir(),
    sessionTtlMs: positive(
      overrides.sessionTtlMs ?? DEFAULT_WEB_SESSION_TTL_MS,
      "sessionTtlMs",
    ),
    loginFailureDelayMs: positive(
      overrides.loginFailureDelayMs ?? 200,
      "loginFailureDelayMs",
      0,
    ),
  };
}

function resolvePublicOrigins(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim().length === 0) return [];
  return [
    ...new Set(
      value.split(",").map((entry) => {
        const text = entry.trim();
        // Check the raw spelling too: URL would silently remove paths such as
        // /.., empty query/fragment markers, credentials, and some whitespace.
        if (/^https:\/\/[^/?#\\@\s*%]+$/.test(text) && !text.endsWith(":")) {
          try {
            const url = new URL(text);
            if (url.hostname.length > 0 && !url.hostname.includes("*")) {
              return url.origin;
            }
          } catch {
            // Report the same configuration error for all malformed origins.
          }
        }
        // Do not echo the value: a rejected URL may contain credentials.
        throw new Error(
          "CARDIGAN_WEB_PUBLIC_ORIGINS 无效：请用逗号分隔 HTTPS 来源，每项必须以 https:// 开头并包含主机名，可带端口，不得带路径（含末尾 /）、用户名密码、查询、片段或通配符",
        );
      }),
    ),
  ];
}

/**
 * §0: the listener itself refuses a non-loopback address.
 *
 * `resolveWebConfig` is the only production caller, but `startWebServer` is
 * exported too and takes a `WebConfig` object; a hand-built one must not be able
 * to bind 0.0.0.0 (S03).
 */
export function requireLoopbackHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if ((WEB_LOOPBACK_HOSTS as readonly string[]).includes(normalized)) {
    return normalized;
  }
  throw new Error(
    `Web Workbench 拒绝监听 ${JSON.stringify(host)}。${WEB_LOCAL_ONLY_MESSAGE}`,
  );
}

function resolveWebHost(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    return DEFAULT_WEB_HOST;
  }
  const requested = value.trim();
  const normalized = requested.toLowerCase();
  if ((WEB_LOOPBACK_HOSTS as readonly string[]).includes(normalized)) {
    return normalized;
  }
  throw new Error(
    `Web Workbench 拒绝监听 ${JSON.stringify(requested)}。${WEB_LOCAL_ONLY_MESSAGE}`,
  );
}

function resolveWebPort(
  value: string | undefined,
  override: number | undefined,
): number {
  if (override !== undefined) {
    return portNumber(override, "port");
  }
  const text = value?.trim();
  if (text === undefined || text.length === 0) {
    return DEFAULT_WEB_PORT;
  }
  const parsed = Number(text);
  if (!Number.isInteger(parsed)) {
    throw new Error(
      `CARDIGAN_WEB_PORT must be an integer between 0 and 65535, got ${JSON.stringify(text)}`,
    );
  }
  return portNumber(parsed, "CARDIGAN_WEB_PORT");
}

function portNumber(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(
      `${name} must be an integer between 0 and 65535, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function positive(value: number, name: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

/** IPv6 literals need brackets in a URL and in a `Host` header. */
export function bracket(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * The `Host` headers a request may carry (M5 plan §3.2, DNS rebinding).
 *
 * The port is part of the value: without it, a page served from any port on the
 * loopback interface could reach this listener. `localhost` and the bound
 * literal are both accepted because a browser may be given either.
 */
export function allowedHosts(
  host: string,
  port: number,
  publicOrigins: readonly string[] = [],
): readonly string[] {
  const names = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `${bracket(host)}:${port}`,
    ...publicOrigins.map((origin) => new URL(origin).host),
  ]);
  return [...names];
}
