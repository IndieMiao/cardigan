import type { IncomingMessage, ServerResponse } from "node:http";
import { activeOwner, type Clock } from "@cardigan/domain";
import {
  CapabilityGuideError,
  deleteCapabilityGuide,
  listCapabilityGuides,
  readCapabilityGuides,
  type Store,
  setCapabilityGuide,
  type WebSession,
} from "@cardigan/store";
import {
  HttpRejection,
  methodNotAllowed,
  readJsonBody,
  sendJson,
} from "./http.js";

/**
 * C-725: `/api/projects/<p>/capability-guides`, usage notes of the machine
 * capability catalog. A signed-in human reads (`GET`, `?machine=` merges one
 * machine's supplements) and the owner writes (`PUT` sets, `DELETE` removes;
 * body names the entry). Any `Authorization` header — an Agent's MCP Token —
 * is refused with 403 before anything is read.
 */
interface Context {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly store: Store;
  readonly clock: Clock;
  readonly authorize: () => WebSession;
}

const STATUS: Record<string, number> = {
  unauthorized: 403,
  not_found: 404,
  validation_failed: 400,
};

export async function serveCapabilityGuides(c: Context, project: string) {
  if (c.req.headers.authorization !== undefined)
    throw new HttpRejection(403, "unauthorized", "仅限人类登录会话");
  c.authorize();
  if (c.req.method === "GET") {
    const machine = c.url.searchParams.get("machine");
    return sendJson(c.res, 200, {
      entries: listCapabilityGuides(c.store, project),
      merged: readCapabilityGuides(c.store, project, { machine_id: machine }),
    });
  }
  if (c.req.method !== "PUT" && c.req.method !== "DELETE")
    methodNotAllowed(["GET", "PUT", "DELETE"]);
  const body = await readJsonBody(c.req);
  const allowed =
    c.req.method === "PUT"
      ? ["scope", "key", "machine_id", "usage_note"]
      : ["scope", "key", "machine_id"];
  if (Object.keys(body).some((k) => !allowed.includes(k)))
    throw new HttpRejection(400, "validation_failed", "无效参数");
  const { usage_note, ...target } = body as Record<string, unknown>;
  const owner = c.authorize().member_id;
  if (
    !owner ||
    activeOwner(c.store.uow.read((tx) => tx.members.list()))?.id !== owner
  )
    throw new HttpRejection(403, "unauthorized", "需要有效的人成员身份");
  const human = { kind: "human", project_id: project } as const;
  try {
    if (c.req.method === "PUT")
      return sendJson(c.res, 200, {
        entry: setCapabilityGuide(
          c.store,
          human,
          project,
          target,
          usage_note,
          c.clock.now(),
        ),
      });
    if (!deleteCapabilityGuide(c.store, human, project, target))
      throw new HttpRejection(404, "not_found", "没有这条使用说明");
    return sendJson(c.res, 200, { deleted: true });
  } catch (error) {
    if (error instanceof CapabilityGuideError)
      throw new HttpRejection(
        STATUS[error.code] ?? 409,
        error.code,
        error.message,
      );
    throw error;
  }
}
