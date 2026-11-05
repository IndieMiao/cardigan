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
  ".webmanifest": "application/manifest+json",
};

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

async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  immutable: boolean,
): Promise<void> {
  const info = await stat(file);
  const type =
    CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  const isShell = file.endsWith(`${sep}index.html`);
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": info.size,
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
    const stream = createReadStream(file);
    stream.on("error", fail);
    stream.on("end", () => done());
    stream.pipe(res);
  });
}
