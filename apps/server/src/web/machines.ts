import type { IncomingMessage, ServerResponse } from "node:http";
import { activeOwner, type Clock, saveMachine } from "@cardigan/domain";
import { persistEffect } from "@cardigan/mcp-server";
import type {
  Store,
  StoreTransactionContext,
  WebSession,
} from "@cardigan/store";
import {
  HttpRejection,
  methodNotAllowed,
  readJsonBody,
  sendJson,
} from "./http.js";
import { type MachineChecks, machineAudit } from "./machine-checks.js";
import { type MachineViewOptions, machineView } from "./machine-view.js";
import { emptyState } from "./sql-state.js";

interface Context extends MachineViewOptions {
  req: IncomingMessage;
  res: ServerResponse;
  store: Store;
  clock: Clock;
  checks: MachineChecks;
  authorize: () => WebSession;
}
const missing = () =>
  new HttpRejection(404, "not_found", "机器或检查记录不存在");
export async function serveMachines(c: Context, project: string, rest: string) {
  if (c.req.headers.authorization !== undefined)
    throw new HttpRejection(403, "unauthorized", "仅限人类登录会话");
  const match =
    /^\/machines(?:\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:\/(drain|resume|check|checks\/([^/]+)))?)?$/.exec(
      rest,
    );
  if (!match) throw missing();
  const [, machine, action, id] = match;
  if (!action || id) {
    if (c.req.method !== "GET") methodNotAllowed(["GET"]);
    if (machine && id) {
      const check = c.checks.read(machine, id);
      if (!check) throw missing();
      return sendJson(c.res, 200, { check });
    }
    const machines = machineView(c.store, project, c, c.clock.now(), machine);
    if (machine && !machines.length) throw missing();
    return sendJson(
      c.res,
      200,
      machine ? { machine: machines[0] } : { machines },
    );
  }
  if (!machine) throw missing();
  if (c.req.method !== "POST") methodNotAllowed(["POST"]);
  const body = await readJsonBody(c.req);
  if (
    Object.keys(body).some((k) => action !== "check" || k !== "kind") ||
    ("kind" in body && body.kind !== "machine" && body.kind !== "worker")
  )
    throw new HttpRejection(400, "validation_failed", "无效操作参数");
  const authorize = (tx: StoreTransactionContext) => {
    const member = c.authorize().member_id;
    if (!member || activeOwner(tx.members.list())?.id !== member)
      throw new HttpRejection(403, "unauthorized", "需要有效的人成员身份");
    return member;
  };
  if (action === "check") {
    if (body.kind === "worker" && machine === "local")
      throw new HttpRejection(
        400,
        "validation_failed",
        "本机不使用 worker 接入检查",
      );
    return sendJson(c.res, 202, {
      check: c.checks.start(
        project,
        machine,
        body.kind === "worker" ? "worker" : "machine",
        authorize,
      ),
    });
  }
  const status = action === "drain" ? "draining" : "online";
  c.store.uow.run((tx) => {
    const member = authorize(tx);
    let found = false;
    for (const p of c.store.listProjects()) {
      const m = tx.machines.get(p.id, machine);
      if (!m) continue;
      found = true;
      if (m.status === status) continue;
      // Never revive an offline/degraded binding merely because a peer was drained.
      if (m.status !== "draining" && m.status !== "online")
        throw new HttpRejection(
          409,
          "illegal_transition",
          "机器不处于在线或排空状态",
        );
      const effect = saveMachine(
        { ...emptyState(tx, p.id), machines: [m] },
        { kind: "human", project_id: p.id },
        {
          machine: { ...m, status },
          operation: action === "drain" ? "drain" : "update",
        },
        { clock: c.clock, ids: tx.ids },
      );
      if (!effect.ok)
        throw new HttpRejection(409, effect.error.code, effect.error.message);
      persistEffect(tx, p.id, effect.value);
    }
    if (!found) throw missing();
    machineAudit(
      tx,
      c.clock,
      action === "drain"
        ? "machine_drain_requested"
        : "machine_resume_requested",
      { machine_id: machine, project_id: project, member_id: member },
    );
  });
  sendJson(c.res, 200, { machine_id: machine, status });
}
