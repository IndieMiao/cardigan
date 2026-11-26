import type { Assignment, ProjectId, Runtime } from "@cardigan/domain";
import { queueRun, stoppedByHuman } from "@cardigan/domain";
import type { WorktreeDiff } from "@cardigan/git-service";
import {
  AssignmentStopError,
  settleTestReviewLimits,
  stopWorkItemSession,
  type WorkItemStopResult,
} from "@cardigan/host";
import { z } from "zod";
import type { LaunchSnapshot } from "../dispatch.js";
import {
  HttpRejection,
  methodNotAllowed,
  readJsonBody,
  sendJson,
} from "./http.js";
import { keyedHumanWrite, type WriteContext } from "./write.js";

/**
 * C-703: what the Workbench needs from the host to start, stop and inspect an
 * Assignment the way `cardigan assignment start|stop` and `worktree diff` do.
 */
export interface AssignmentOps {
  readonly runtime: Runtime;
  /** The Dispatcher's model/CLI snapshot for a new Run. */
  readonly snapshot: (
    assignment: Assignment,
    project: ProjectId,
  ) => Promise<LaunchSnapshot>;
  readonly diff: (
    project: ProjectId,
    assignment: Assignment,
  ) => Promise<WorktreeDiff>;
}

/** The patch the diff view carries at most; the rest is cut off. */
export const MAX_DIFF_PATCH_BYTES = 512 * 1024;
const STOP_REASON = "由人在 Workbench 停止";
const ROUTE = /^\/execution\/assignments\/(A-[1-9][0-9]*)\/(start|stop|diff)$/u;
/** The full API path, for refusing an Agent's Bearer before the login check. */
export const ASSIGNMENT_OPS_ROUTE =
  /^\/api\/projects\/[^/]+\/execution\/assignments\/[^/]+\/(?:start|stop|diff)$/u;
const key = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => s.trim().length > 0);
const startBody = z.object({ restart: z.boolean().optional() }).strict();

/** One in-flight start or stop per Assignment; the same key waits for it. */
const inFlight = new Map<
  string,
  { readonly key: string; readonly done: Promise<unknown> }
>();

export interface AssignmentOpsContext extends WriteContext {
  readonly ops: AssignmentOps | undefined;
}

/**
 * `POST …/execution/assignments/A-n/start` (`{restart?}`), `…/stop` and
 * `GET …/diff`. Only a logged-in human session: an Agent's Bearer is refused
 * with 403 before anything is read.
 */
export async function serveAssignmentOps(
  c: AssignmentOpsContext,
  rest: string,
): Promise<boolean> {
  const match = ROUTE.exec(rest);
  if (!match) return false;
  const [, id, action] = match as unknown as [string, Assignment["id"], string];
  if (c.req.headers.authorization !== undefined)
    throw new HttpRejection(403, "unauthorized", "仅限人类登录会话");
  if (action === "diff") {
    if (c.req.method !== "GET") methodNotAllowed(["GET"]);
  } else if (c.req.method !== "POST") methodNotAllowed(["POST"]);
  c.authorize();
  const ops = c.ops;
  if (!ops) throw new HttpRejection(503, "unavailable", "执行操作服务不可用");
  const project = c.project_id as ProjectId;
  if (action === "diff") {
    const assignment = workItemAssignment(c, id);
    if (!assignment.worktree_path)
      throw new HttpRejection(409, "illegal_transition", `${id} 没有工作目录`);
    const diff = await ops.diff(project, assignment).catch((error: unknown) => {
      throw new HttpRejection(
        409,
        "unavailable",
        `读取 ${id} 的改动失败：${error instanceof Error ? error.message : String(error)}`,
      );
    });
    c.authorize();
    sendJson(c.res, 200, cappedDiff(diff));
    return true;
  }
  const body = await readJsonBody(c.req);
  c.authorize();
  const header = key.safeParse(c.req.headers["idempotency-key"]);
  if (!header.success)
    throw new HttpRejection(
      400,
      "validation_failed",
      `${action === "stop" ? "停止执行" : "启动会话"}需要 Idempotency-Key`,
    );
  const input =
    action === "start"
      ? startBody.safeParse(body)
      : z.object({}).strict().safeParse(body);
  if (!input.success)
    throw new HttpRejection(400, "validation_failed", "无效操作参数");
  const restart = action === "start" && input.data.restart === true;
  const write = keyedHumanWrite(c, header.data, {
    method: "POST",
    assignment_id: id,
    action,
    body,
  });
  const cached = write.replay();
  if (cached) {
    sendJson(c.res, 200, cached.value);
    return true;
  }
  const slot = `${project}:${id}`;
  const running = inFlight.get(slot);
  if (running) {
    if (running.key !== header.data)
      throw new HttpRejection(
        409,
        "illegal_transition",
        `${id} 正在处理另一个启动或停止，没有改动；稍后重试`,
      );
    await running.done.catch(() => undefined);
    const settled = write.replay();
    if (!settled)
      throw new HttpRejection(
        409,
        "illegal_transition",
        "上一次请求没有完成，请重试",
      );
    sendJson(c.res, 200, settled.value);
    return true;
  }
  const work = (async () => {
    workItemAssignment(c, id);
    if (action === "stop") return write.record(await stop(c, ops, write, id));
    // The snapshot (the CLI version probe) first: a restart that cannot
    // start a new session leaves the old one alone.
    const snapshot = await ops
      .snapshot(workItemAssignment(c, id), project)
      .catch((error: unknown) => {
        throw new HttpRejection(
          409,
          "illegal_transition",
          `无法启动 ${id}：${error instanceof Error ? error.message : String(error)}`,
        );
      });
    c.authorize();
    if (restart && workItemAssignment(c, id).runtime_ref !== null) {
      const stopped = await stop(c, ops, write, id, true);
      if (stopped.stale)
        throw new HttpRejection(
          409,
          "stale_target",
          `${id} 的会话已变化，没有重启；请看最新状态后再操作`,
        );
    }
    const assignment = workItemAssignment(c, id);
    // A start lifts a stop. While the stopped session's terminal is still on
    // record its exit is unproven, so only 重启会话 (which proves it) may go on.
    if (
      assignment.runtime_ref !== null &&
      stoppedByHuman(
        c.store.uow.read((tx) =>
          tx.events.listAfter(
            project,
            assignment.work_item_id &&
              tx.work_items.get(project, assignment.work_item_id)?.card_id,
            0,
          ),
        ),
        id,
      )
    )
      throw new HttpRejection(
        409,
        "illegal_transition",
        `${id} 的停止还没有确认原会话已退出，不能直接启动；用“重启会话”核对退出后再启动`,
      );
    if (
      assignment.work_item_id &&
      c.store.uow.read((tx) =>
        tx.work_items.get(project, assignment.work_item_id as never),
      )?.kind === "verify"
    )
      settleTestReviewLimits(c.store, project);
    c.authorize();
    return write.run((s, a, p) => {
      const queued = queueRun(
        s,
        a,
        {
          assignment_id: id,
          reuse_queued: true,
          model: snapshot.model,
          agent_cli_version: snapshot.agent_cli_version,
          ...(snapshot.launch_profile_ref === undefined
            ? {}
            : { launch_profile_ref: snapshot.launch_profile_ref }),
          ...(snapshot.harness === undefined
            ? {}
            : { harness: snapshot.harness }),
          ...(snapshot.effort === undefined ? {} : { effort: snapshot.effort }),
        },
        p,
      );
      // The key records the answer, not the whole Run.
      return queued.ok
        ? {
            ok: true,
            value: { ...queued.value, data: { run_id: queued.value.data.id } },
          }
        : queued;
    });
  })();
  inFlight.set(slot, { key: header.data, done: work });
  try {
    sendJson(c.res, 200, await work);
  } finally {
    inFlight.delete(slot);
  }
  return true;
}

/** The same managed stop as `cardigan assignment stop`, as the human. */
async function stop(
  c: WriteContext,
  ops: AssignmentOps,
  write: ReturnType<typeof keyedHumanWrite>,
  id: Assignment["id"],
  /** A start follows: prove the exit even when the stop is a pause. */
  restarting = false,
): Promise<WorkItemStopResult> {
  try {
    return await stopWorkItemSession({
      store: c.store,
      project_id: c.project_id as ProjectId,
      assignment_id: id,
      runtime: ops.runtime,
      reason: STOP_REASON,
      require_exit_proof: restarting,
      apply: write.apply,
    });
  } catch (error) {
    if (!(error instanceof AssignmentStopError)) throw error;
    throw new HttpRejection(
      409,
      error.kind === "usage" ? "illegal_transition" : "stop_failed",
      error.runtime
        ? `无法释放 ${id} 的终端：${error.runtime.message}`
        : error.message,
    );
  }
}

/** Only an active work-item Assignment with a terminal of its own. */
function workItemAssignment(c: WriteContext, id: Assignment["id"]) {
  const assignment = c.store.uow.read((tx) =>
    tx.assignments.get(c.project_id as ProjectId, id),
  );
  if (!assignment)
    throw new HttpRejection(404, "not_found", `Assignment ${id} 不存在`);
  if (assignment.external)
    throw new HttpRejection(
      409,
      "illegal_transition",
      "外接身份由对接的 Agent 自行拉取，没有可以启动或停止的终端",
    );
  if (assignment.scope !== "work_item")
    throw new HttpRejection(
      409,
      "illegal_transition",
      "常驻身份请用 cardigan pm start / pm restart / assignment stop",
    );
  return assignment;
}

function cappedDiff(diff: WorktreeDiff) {
  const bytes = Buffer.from(diff.patch, "utf8");
  if (bytes.length <= MAX_DIFF_PATCH_BYTES)
    return { ...diff, truncated: false };
  // Cut at a line end so a multi-byte character is never split.
  const cut = bytes.subarray(0, MAX_DIFF_PATCH_BYTES).lastIndexOf(0x0a);
  return {
    ...diff,
    patch: bytes
      .subarray(0, cut > 0 ? cut + 1 : MAX_DIFF_PATCH_BYTES)
      .toString("utf8"),
    truncated: true,
  };
}
