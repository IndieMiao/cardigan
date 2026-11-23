import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * HTTP plumbing for the Workbench listener: one place that decides response
 * headers, the JSON error envelope and the request checks of M5 plan §3.2.
 *
 * There is no framework on purpose: the surface is a dozen routes, and every
 * check below (Host, Origin, Content-Type, cookie flags) has to be visible in
 * one file to be reviewable.
 */

/**
 * Headers on every response, including static files (M5 plan §3.2).
 *
 * `default-src 'self'` with `script-src 'self'` forbids inline scripts, so a
 * Markdown body written by an Agent can never become executable code.
 * `style-src` allows inline styles: React style attributes and Vite's injected
 * CSS are not a script surface, and disallowing them would break the UI for no
 * security gain.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; "),
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
};

/** Largest JSON body the Workbench accepts; login is a few hundred bytes. */
export const MAX_JSON_BODY_BYTES = 64 * 1024;

/** Session cookie name (§3.2). */
export const SESSION_COOKIE = "cardigan_session";

/** Fixed templates only: neither identifiers nor query strings reach logs. */
export function requestRoute(path: string): string {
  if (/^\/api\/(login|logout|session|me|projects|offsite)$/.test(path))
    return path;
  if (/^\/api\/avatars\/[^/]+$/.test(path)) return "/api/avatars/:sha256";
  const project = /^\/api\/projects\/[^/]+(\/.*)$/.exec(path);
  const rest = project?.[1];
  if (rest) {
    const prefix = "/api/projects/:project_id";
    if (rest === "/machines") return prefix + rest;
    const machine =
      /^\/machines\/[^/]+(?:\/(check|drain|resume|checks\/[^/]+))?$/.exec(rest);
    if (machine)
      return `${prefix}/machines/:id${machine[1] ? `/${machine[1].startsWith("checks/") ? "checks/:check_id" : machine[1]}` : ""}`;
    if (/^\/employees(?:\/options)?$/.test(rest)) return prefix + rest;
    if (
      /^\/(cards|needs-you|notices|snapshot|execution|activity|stream|preferences)$/.test(
        rest,
      )
    )
      return prefix + rest;
    if (/^\/work-items\/[^/]+\/manual-assign$/.test(rest))
      return `${prefix}/work-items/:id/manual-assign`;
    if (
      rest === "/execution/capacity" ||
      rest === "/needs-you/version" ||
      rest === "/cards/version"
    )
      return prefix + rest;
    if (/^\/cards\/[^/]+\/mentions$/.test(rest))
      return `${prefix}/cards/:id/mentions`;
    if (/^\/attachments\/[^/]+\/thumbnail$/.test(rest))
      return `${prefix}/attachments/:id/thumbnail`;
    if (/^\/attachments\/[^/]+\/preview$/.test(rest))
      return `${prefix}/attachments/:id/preview`;
    const entity = /^\/(cards|attachments)\/[^/]+$/.exec(rest);
    if (entity) return `${prefix}/${entity[1]}/:id`;
    const write =
      /^\/(cards|decisions|human-actions)\/[^/]+\/(comments|instructions|attachments|resolve|complete|update|cancel|supersede|source-unrelated)$/.exec(
        rest,
      );
    if (write) return `${prefix}/${write[1]}/:id/${write[2]}`;
  }
  return path.startsWith("/api") ? "unmatched" : "/static/*";
}

export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

/**
 * A rejection that ends the request with a status and the shared JSON envelope.
 * Thrown from route handlers and caught by the listener.
 */
export class HttpRejection extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
  }
}

export const reject = (
  status: number,
  code: string,
  message: string,
  options: {
    readonly details?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): never => {
  throw new HttpRejection(
    status,
    code,
    message,
    options.details,
    options.headers ?? {},
  );
};

const UNAUTHORIZED_HINT: Readonly<Record<string, string>> = {
  "WWW-Authenticate": 'Session realm="cardigan-workbench"',
};

/** 401 for an absent, expired or revoked session (§3.2 credential separation). */
export function unauthorized(message = "login required"): never {
  return reject(401, "unauthorized", message, {
    headers: UNAUTHORIZED_HINT,
  });
}

/**
 * C-614: `imageOrigin` is the private OSS bucket origin that signed thumbnail
 * and preview redirects point to; only images may load from it.
 */
export function applySecurityHeaders(
  res: ServerResponse,
  imageOrigin?: string,
): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(
      name,
      imageOrigin && name === "Content-Security-Policy"
        ? value.replace(
            "img-src 'self' data: blob:",
            `img-src 'self' data: blob: ${imageOrigin}`,
          )
        : value,
    );
  }
}

/** JSON response; API bodies are never cached. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

/** C-644: a JSON body a read worker already serialized. */
export function sendJsonText(
  res: ServerResponse,
  status: number,
  payload: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  options: {
    readonly details?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): void {
  const body: ErrorBody = {
    error: {
      code,
      message,
      ...(options.details === undefined ? {} : { details: options.details }),
    },
  };
  sendJson(res, status, body, options.headers ?? {});
}

/**
 * The `Host` header must name this listener (§3.2, DNS rebinding).
 *
 * A page on `evil.example` that resolves to 127.0.0.1 still sends its own Host,
 * so this check stops the rebinding attack before any credential is read.
 */
export function requireHost(
  req: IncomingMessage,
  allowed: readonly string[],
): string {
  const header = req.headers.host;
  if (header === undefined || !allowed.includes(header)) {
    throw new HttpRejection(
      421,
      "misdirected_request",
      "unexpected Host header",
      { allowed },
    );
  }
  return header;
}

/**
 * Every state-changing request must come from the page we serve (§3.2, CSRF).
 *
 * `SameSite=Strict` already keeps the cookie off cross-site requests; checking
 * Origin as well means a request from anywhere else is refused explicitly
 * instead of merely arriving without credentials.
 */
export function requireOrigin(
  req: IncomingMessage,
  host: string,
  publicOrigins: readonly string[] = [],
): string {
  const expected = publicOrigins.includes(`https://${host}`)
    ? `https://${host}`
    : `http://${host}`;
  if (req.method === "GET" || req.method === "HEAD") {
    return expected;
  }
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin.length === 0) {
    throw new HttpRejection(
      403,
      "origin_required",
      "Origin header is required for this request",
    );
  }
  if (origin !== expected && !publicOrigins.includes(origin)) {
    throw new HttpRejection(403, "origin_rejected", "unexpected Origin", {
      expected,
    });
  }
  return origin;
}

/** JSON bodies only, and bounded (§3.2). */
export async function readJsonBody(
  req: IncomingMessage,
  limit = MAX_JSON_BODY_BYTES,
  tooLarge = "request body is too large",
): Promise<Record<string, unknown>> {
  const contentType = req.headers["content-type"];
  const type = Array.isArray(contentType) ? contentType[0] : contentType;
  if (type === undefined || !/^application\/json\b/i.test(type.trim())) {
    throw new HttpRejection(
      415,
      "unsupported_media_type",
      "this endpoint requires application/json",
    );
  }
  const declared = Number(req.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpRejection(413, "payload_too_large", tooLarge);
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as string);
    size += buffer.byteLength;
    if (size > limit) {
      throw new HttpRejection(413, "payload_too_large", tooLarge);
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim().length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpRejection(400, "invalid_json", "body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpRejection(400, "invalid_json", "body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** `Cookie: a=1; b=2` → map. Later duplicates win, which browsers do not send. */
export function parseCookies(
  header: string | string[] | undefined,
): Map<string, string> {
  const cookies = new Map<string, string>();
  const values = Array.isArray(header)
    ? header
    : header === undefined
      ? []
      : [header];
  for (const value of values) {
    for (const part of value.split(";")) {
      const index = part.indexOf("=");
      if (index <= 0) continue;
      const name = part.slice(0, index).trim();
      const raw = part.slice(index + 1).trim();
      if (name.length === 0) continue;
      try {
        cookies.set(name, decodeURIComponent(raw));
      } catch {
        // A malformed escape is just an unusable cookie.
        cookies.set(name, raw);
      }
    }
  }
  return cookies;
}

export function sessionCookie(
  token: string,
  maxAgeSeconds: number,
  secure = false,
): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** Logout: the same attributes, an empty value and no lifetime. */
export function clearedSessionCookie(secure = false): string {
  return sessionCookie("", 0, secure);
}

export function methodNotAllowed(allowed: readonly string[]): never {
  return reject(405, "method_not_allowed", "method not allowed", {
    headers: { Allow: allowed.join(", ") },
  });
}
