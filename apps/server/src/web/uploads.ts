import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProjectId } from "@cardigan/domain";
import {
  ToolError,
  type UploadSessions,
  uploadSessionsFor,
} from "@cardigan/mcp-server";
import type { WebSession } from "@cardigan/store";
import { z } from "zod";
import {
  HttpRejection,
  methodNotAllowed,
  readJsonBody,
  sendJson,
} from "./http.js";

/**
 * C-683: the Workbench's resumable video upload (the browser cannot hold a
 * large file as base64 JSON). `POST /uploads` opens an upload,
 * `PUT /uploads/<id>?offset=<n>` sends one raw chunk, `GET /uploads/<id>`
 * reports the offset to continue from. A complete upload is attached with
 * `POST /cards/<card>/attachments` and `{ upload_id }` instead of `file`.
 * Uploads belong to the signed-in member of this project only.
 */
export interface UploadRouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly project_id: ProjectId;
  readonly dataDir: string;
  readonly authorize: () => WebSession;
  readonly sessions?: UploadSessions;
}

/** Owner of a member's uploads in one project. */
export const uploadOwner = (project: ProjectId, session: WebSession) =>
  `web:${project}/${session.member_id ?? "owner"}`;

const UPLOAD_ROUTE = /^\/uploads(?:\/([^/]+))?$/u;

export function uploadError(error: unknown): never {
  if (!(error instanceof ToolError)) throw error;
  const status =
    error.code === "not_found"
      ? 404
      : error.code === "stale_target" || error.code === "idempotency_conflict"
        ? 409
        : error.message.startsWith("Video exceeds")
          ? 413
          : 400;
  throw new HttpRejection(status, error.code, error.message, error.details);
}

export async function serveUploads(
  c: UploadRouteContext,
  rest: string,
): Promise<boolean> {
  const match = UPLOAD_ROUTE.exec(rest);
  if (!match) return false;
  const sessions = c.sessions ?? uploadSessionsFor(c.dataDir);
  const id = match[1] === undefined ? undefined : decodeURIComponent(match[1]);
  const owner = () => uploadOwner(c.project_id, c.authorize());
  try {
    if (id === undefined) {
      if (c.req.method !== "POST") methodNotAllowed(["POST"]);
      const who = owner();
      const body = await readJsonBody(c.req);
      const input = z
        .object({
          size: z.number().int().positive(),
          mime: z.string().min(1).max(255),
        })
        .strict()
        .safeParse(body);
      if (!input.success)
        throw new HttpRejection(
          400,
          "validation_failed",
          "Invalid upload parameters",
        );
      sendJson(c.res, 201, await sessions.create(who, input.data));
      return true;
    }
    if (c.req.method === "GET") {
      sendJson(c.res, 200, await sessions.status(owner(), id));
      return true;
    }
    if (c.req.method !== "PUT") methodNotAllowed(["GET", "PUT"]);
    const who = owner();
    const type = c.req.headers["content-type"];
    if (type !== "application/octet-stream")
      throw new HttpRejection(
        415,
        "unsupported_media_type",
        "send chunks as application/octet-stream",
      );
    const offset = c.url.searchParams.get("offset") ?? "";
    if (!/^\d{1,12}$/u.test(offset))
      throw new HttpRejection(400, "validation_failed", "offset is required");
    sendJson(c.res, 200, await sessions.append(who, id, Number(offset), c.req));
    return true;
  } catch (error) {
    uploadError(error);
  }
}
