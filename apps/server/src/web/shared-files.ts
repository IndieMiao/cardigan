import type { IncomingMessage, ServerResponse } from "node:http";
import { type SharedFileActor, SharedFilesError } from "@cardigan/domain";
import {
  offsiteFor,
  SHARED_FILES_NOTICE,
  SharedFileLibrary,
} from "@cardigan/mcp-server";
import { SharedFileStore, type Store } from "@cardigan/store";
import { z } from "zod";
import {
  HttpRejection,
  methodNotAllowed,
  readJsonBody,
  sendJson,
} from "./http.js";

/**
 * C-685: Workbench routes of the shared file library (`/api/shared-files…`).
 * A signed-in human browses, creates directories, uploads straight to OSS
 * with a signed PUT, downloads through a redirect to a signed GET, and is the
 * only one who may delete. Every answer is JSON or a redirect: no file bytes
 * pass through the host.
 */
export interface SharedFilesRouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly store: Store;
  readonly dataDir: string;
  readonly human: SharedFileActor;
}

const libraries = new WeakMap<Store, Map<string, SharedFileLibrary>>();
export function sharedFileLibrary(store: Store, dataDir: string) {
  let byDir = libraries.get(store);
  if (!byDir) {
    byDir = new Map();
    libraries.set(store, byDir);
  }
  let library = byDir.get(dataDir);
  if (!library) {
    library = new SharedFileLibrary({
      repository: new SharedFileStore(store),
      offsite: () => offsiteFor(dataDir),
    });
    byDir.set(dataDir, library);
  }
  return library;
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success)
    throw new HttpRejection(400, "validation_failed", "请求参数无效");
  return result.data;
}

const STATUS: Readonly<Record<SharedFilesError["code"], number>> = {
  invalid: 400,
  not_found: 404,
  conflict: 409,
  forbidden: 403,
  unavailable: 503,
};

async function mapped<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SharedFilesError)
      throw new HttpRejection(STATUS[error.code], error.code, error.message);
    throw error;
  }
}

export async function serveSharedFiles(
  context: SharedFilesRouteContext,
): Promise<void> {
  const { req, res, url } = context;
  const rest = url.pathname.slice("/api/shared-files".length);
  const library = sharedFileLibrary(context.store, context.dataDir);
  const path = url.searchParams.get("path") ?? "";

  if (rest === "") {
    if (req.method !== "GET") methodNotAllowed(["GET"]);
    const listing = await mapped(() => library.list(path));
    sendJson(res, 200, {
      availability: library.availability(),
      notice: SHARED_FILES_NOTICE,
      ...listing,
    });
    return;
  }
  if (rest === "/versions") {
    if (req.method !== "GET") methodNotAllowed(["GET"]);
    sendJson(res, 200, await mapped(() => library.history(path)));
    return;
  }
  if (rest === "/download") {
    if (req.method !== "GET") methodNotAllowed(["GET"]);
    const version = url.searchParams.get("version") ?? undefined;
    const download = await mapped(() => library.download(path, version));
    // The browser fetches the bytes from OSS itself.
    res.writeHead(302, {
      Location: download.url,
      "Cache-Control": "no-store",
      "Content-Length": 0,
    });
    res.end();
    return;
  }
  if (req.method !== "POST") methodNotAllowed(["POST"]);
  const body = await readJsonBody(req);
  if (rest === "/dirs") {
    const input = parse(
      z.object({ path: z.string().min(1).max(1024) }).strict(),
      body,
    );
    sendJson(
      res,
      200,
      await mapped(() => library.mkdir(context.human, input.path)),
    );
    return;
  }
  if (rest === "/uploads") {
    const input = parse(
      z
        .object({
          path: z.string().min(1).max(1024),
          size: z.number().int().min(0),
          content_type: z.string().max(200).optional(),
        })
        .strict(),
      body,
    );
    sendJson(
      res,
      200,
      await mapped(() => library.beginUpload(context.human, input)),
    );
    return;
  }
  if (rest === "/uploads/commit") {
    const input = parse(
      z.object({ upload_id: z.string().min(1).max(64) }).strict(),
      body,
    );
    sendJson(
      res,
      200,
      await mapped(() => library.commitUpload(context.human, input.upload_id)),
    );
    return;
  }
  if (rest === "/delete") {
    const input = parse(
      z
        .object({
          path: z.string().min(1).max(1024),
          kind: z.enum(["file", "dir"]),
        })
        .strict(),
      body,
    );
    await mapped(() => library.remove(context.human, input.path, input.kind));
    sendJson(res, 200, { ok: true });
    return;
  }
  throw new HttpRejection(404, "not_found", "not found");
}
