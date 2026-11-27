import type { IncomingMessage } from "node:http";
import {
  bucketOrigin,
  nodeTransport,
  type OssCredentials,
  type OssTransport,
} from "./oss.js";

/**
 * C-807: whether the private bucket lets the Workbench upload from a browser.
 * The host's own requests never need CORS, so a bucket without a rule looks
 * healthy from the server while every browser upload fails. This sends the
 * same preflight a browser sends before a shared-file PUT, once per Workbench
 * origin.
 *
 * The preflight carries no credential, signature or signed URL: only `Origin`
 * and the two `Access-Control-Request-*` headers. The response body is read
 * (at most a few KiB) to tell "CORS is not enabled" from a rule that does not
 * match, and is never kept, logged or returned.
 */
export const CORS_UPLOAD_METHOD = "PUT";
/** Headers the signed upload sends, see `Offsite.sharedUploadUrl`. */
export const CORS_UPLOAD_HEADERS = Object.freeze([
  "content-type",
  "x-oss-forbid-overwrite",
]);
/** What the owner adds in the OSS console: uploads, downloads and HEAD. */
export const CORS_RULE_METHODS = Object.freeze(["PUT", "GET", "HEAD"]);
/** Any `shared/` key: a CORS rule applies to the whole bucket. */
const PREFLIGHT_PATH = "/shared/00000000-0000-4000-8000-000000000000";
const PREFLIGHT_TIMEOUT_MS = 15_000;
const BODY_LIMIT = 4096;

/**
 * - `ok`: the bucket answers the preflight for this origin.
 * - `not_enabled`: the bucket has no CORS rule at all.
 * - `not_allowed`: a rule exists but not for this origin, method or headers.
 * - `unreachable`: no answer (network, DNS, timeout); says nothing about CORS.
 * - `error`: any other answer; says nothing about CORS either.
 */
export type CorsVerdict =
  | "ok"
  | "not_enabled"
  | "not_allowed"
  | "unreachable"
  | "error";

/** Verdicts that prove a browser upload from that origin fails. */
export const corsBlocked = (verdict: CorsVerdict) =>
  verdict === "not_enabled" || verdict === "not_allowed";

export interface CorsOriginResult {
  readonly origin: string;
  readonly verdict: CorsVerdict;
  /** HTTP status of the preflight answer, when there was one. */
  readonly status?: number;
}

async function readSnippet(res: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of res as AsyncIterable<Buffer>) {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= BODY_LIMIT) break;
    }
  } catch {
    // A cut-off body still classifies by status.
  } finally {
    res.destroy();
  }
  return Buffer.concat(chunks).subarray(0, BODY_LIMIT).toString("utf8");
}

const header = (res: IncomingMessage, name: string) => {
  const value = res.headers[name];
  return (Array.isArray(value) ? value.join(",") : (value ?? "")).trim();
};
const tokens = (value: string) =>
  new Set(
    value
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );

/** Classify one preflight answer; exported for the unit tests. */
export function corsVerdictOf(
  origin: string,
  status: number,
  headers: {
    readonly allowOrigin: string;
    readonly allowMethods: string;
    readonly allowHeaders: string;
  },
  body: string,
): CorsVerdict {
  if (status === 403)
    return /CORS is not enabled/iu.test(body) ? "not_enabled" : "not_allowed";
  if (status < 200 || status >= 300) return "error";
  const methods = tokens(headers.allowMethods);
  const allowed = tokens(headers.allowHeaders);
  return (headers.allowOrigin === origin || headers.allowOrigin === "*") &&
    (methods.has("*") || methods.has(CORS_UPLOAD_METHOD.toLowerCase())) &&
    (allowed.has("*") || CORS_UPLOAD_HEADERS.every((h) => allowed.has(h)))
    ? "ok"
    : "not_allowed";
}

/** One browser-style preflight of a shared-file upload from `origin`. */
export async function corsPreflight(
  target: Pick<OssCredentials, "bucket" | "region" | "endpoint">,
  origin: string,
  options: { transport?: OssTransport; signal?: AbortSignal } = {},
): Promise<CorsOriginResult> {
  const base = (target.endpoint ?? bucketOrigin(target)).replace(/\/$/u, "");
  let res: IncomingMessage;
  try {
    res = await (options.transport ?? nodeTransport)(
      `${base}${PREFLIGHT_PATH}`,
      {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": CORS_UPLOAD_METHOD,
          "access-control-request-headers": CORS_UPLOAD_HEADERS.join(","),
        },
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: PREFLIGHT_TIMEOUT_MS,
      },
    );
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return { origin, verdict: "unreachable" };
  }
  const status = res.statusCode ?? 0;
  const headers = {
    allowOrigin: header(res, "access-control-allow-origin"),
    allowMethods: header(res, "access-control-allow-methods"),
    allowHeaders: header(res, "access-control-allow-headers"),
  };
  const body = status >= 200 && status < 300 ? "" : await readSnippet(res);
  if (status >= 200 && status < 300) {
    res.resume();
    res.once("error", () => undefined);
  }
  return {
    origin,
    verdict: corsVerdictOf(origin, status, headers, body),
    status,
  };
}

/** The rule the owner adds in the OSS console for these origins. */
export interface CorsRule {
  readonly origins: readonly string[];
  readonly methods: readonly string[];
  readonly headers: readonly string[];
}
export const corsRuleFor = (origins: readonly string[]): CorsRule => ({
  origins: [...origins],
  methods: [...CORS_RULE_METHODS],
  headers: [...CORS_UPLOAD_HEADERS],
});
