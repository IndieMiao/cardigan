import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

/**
 * Static files for the SPA (M5 plan §3.1: one listener serves `/api/*` and the
 * `apps/web` build).
 *
 * Every path is resolved against the build directory and rejected if it escapes
 * it, so `GET /../../etc/passwd` cannot leave the tree. Unknown extension-less
 * paths fall back to `index.html`, which is what a client-side route needs.
 *
 * C-795: the web build writes a `.gz` sibling next to every JS and CSS file.
 * A client that accepts gzip gets those bytes with `Content-Encoding: gzip`;
 * anyone else gets the original file. Both answers carry
 * `Vary: Accept-Encoding` so a shared cache keeps them apart.
 */

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  // C-705: the device pairing script, fetched with curl on a new device.
  ".py": "text/x-python; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** Extensions whose build output has a precompressed `.gz` sibling. */
const PRECOMPRESSED = new Set([".js", ".mjs", ".css"]);

export interface StaticResult {
  readonly served: boolean;
}

/**
 * Serve one request from `staticDir`. Returns `{served: false}` when no file
 * matches, so the caller can answer 404 itself.
 */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  staticDir: string,
  pathname: string,
): Promise<StaticResult> {
  const requested = decodePath(pathname);
  if (requested === undefined) {
    // Malformed percent-encoding: treat it as "no such file".
    return { served: false };
  }
  const root = resolve(staticDir);
  const candidate = resolve(root, `.${requested}`);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return { served: false };
  }

  const file = await existingFile(candidate);
  if (file !== undefined) {
    await sendFile(req, res, file, true);
    return { served: true };
  }

  // Client-side routing: only extension-less paths fall back to the SPA shell,
  // so a missing `/assets/app.js` stays a visible 404 instead of an HTML body.
  if (extname(requested) === "") {
    const index = join(root, "index.html");
    const shell = await existingFile(index);
    if (shell !== undefined) {
      await sendFile(req, res, shell, false);
      return { served: true };
    }
  }
  return { served: false };
}

/** Decoded request path, or `undefined` when it contains junk. */
function decodePath(pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) {
    return undefined;
  }
  return decoded.endsWith("/") ? `${decoded}index.html` : decoded;
}

async function existingFile(candidate: string): Promise<string | undefined> {
  try {
    const info = await stat(candidate);
    if (info.isFile()) {
      return candidate;
    }
    if (info.isDirectory()) {
      const index = join(candidate, "index.html");
      const indexInfo = await stat(index);
      return indexInfo.isFile() ? index : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function regularFile(candidate: string): Promise<string | undefined> {
  try {
    return (await stat(candidate)).isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  immutable: boolean,
): Promise<void> {
  const ext = extname(file).toLowerCase();
  const type = CONTENT_TYPES[ext] ?? "application/octet-stream";
  const isShell = file.endsWith(`${sep}index.html`);
  const negotiated = PRECOMPRESSED.has(ext);
  const gzip =
    negotiated && acceptsGzip(req.headers["accept-encoding"])
      ? await regularFile(`${file}.gz`)
      : undefined;
  const body = gzip ?? file;
  const info = await stat(body);
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": info.size,
    ...(gzip === undefined ? {} : { "Content-Encoding": "gzip" }),
    ...(negotiated ? { Vary: "Accept-Encoding" } : {}),
    // Vite fingerprints everything under /assets; the shell must revalidate so
    // a new build is picked up without a hard refresh.
    "Cache-Control":
      immutable && !isShell
        ? "public, max-age=31536000, immutable"
        : "no-cache",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  await new Promise<void>((done, fail) => {
    const stream = createReadStream(body);
    stream.on("error", fail);
    stream.on("end", () => done());
    stream.pipe(res);
  });
}

/**
 * Whether an `Accept-Encoding` header admits gzip (RFC 9110 §12.5.3): `gzip`
 * or `x-gzip` with a non-zero weight, or `*` with a non-zero weight when gzip
 * is not listed on its own. A missing header means "no preference", which we
 * answer with the plain file.
 */
export function acceptsGzip(header: string | string[] | undefined): boolean {
  if (header === undefined) {
    return false;
  }
  let gzip: number | undefined;
  let wildcard: number | undefined;
  for (const part of (Array.isArray(header) ? header.join(",") : header).split(
    ",",
  )) {
    const [rawName = "", ...params] = part.split(";");
    const name = rawName.trim().toLowerCase();
    let weight = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param);
      if (match) {
        weight = Number(match[1]);
      }
    }
    if (Number.isNaN(weight)) {
      weight = 0;
    }
    if (name === "gzip" || name === "x-gzip") {
      gzip = Math.max(gzip ?? 0, weight);
    } else if (name === "*") {
      wildcard = weight;
    }
  }
  return (gzip ?? wildcard ?? 0) > 0;
}
