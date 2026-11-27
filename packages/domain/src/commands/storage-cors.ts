import type { Actor, Event, HumanAction } from "../entities.js";
import type { HumanActionId } from "../ids.js";
import { transition } from "../transitions.js";
import type { CommandDraft, CommandPorts, CommandState } from "./core.js";
import { command, ensure, unwrap } from "./core.js";

/**
 * C-807: the owner's to-do for a private bucket that refuses browser uploads
 * from the Workbench. The host preflights the bucket and reports each settled
 * verdict here; this command keeps at most one open action:
 *
 * - refused: open one (account category: only the owner can change the
 *   bucket in the OSS console), or refresh the steps of the open one. A
 *   action the owner closed while the bucket still refuses is not reopened
 *   until a recheck has passed in between.
 * - allowed: the open action is closed by the system recheck.
 *
 * Origins and bucket names are not secrets; no URL, signature or credential
 * ever reaches this command.
 */
export const STORAGE_CORS_KEY = "storage-cors";
const SOURCE = "storage_rechecked";
/** A passing recheck with nothing open to close (after the owner closed it). */
const RECOVERED = "storage_cors_recovered";

export interface StorageCorsCheck {
  readonly bucket: string;
  readonly region: string;
  /** Workbench origins that were checked, in order. */
  readonly origins: readonly string[];
  /** Origins the bucket refused and why; empty once every origin passes. */
  readonly refused: readonly {
    readonly origin: string;
    readonly reason: "not_enabled" | "not_allowed";
  }[];
}

const ORIGIN = /^https?:\/\/[a-z0-9.[\]:-]+$/iu;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u;
const REGION = /^[a-z]{2}-[a-z0-9-]+$/u;

const ours = (d: CommandDraft, e: Event) =>
  e.actor.kind === "system" &&
  e.actor.project_id === d.state.project_id &&
  !e.card_id;

/**
 * Storage CORS actions of this project, oldest first, and whether a passing
 * recheck was recorded after the newest one was requested.
 */
function storageCorsActions(d: CommandDraft) {
  const actions = new Map(d.list("human_actions").map((h) => [h.id, h]));
  const out: HumanAction[] = [];
  let recovered = false;
  for (const e of d.state.events) {
    if (!ours(d, e)) continue;
    if (e.type === RECOVERED) {
      recovered = true;
      continue;
    }
    if (e.type !== "human_action_requested") continue;
    const p = e.payload as { human_action_id?: string; storage_cors?: string };
    if (p.storage_cors !== STORAGE_CORS_KEY) continue;
    const action = actions.get(p.human_action_id as HumanActionId);
    if (action?.requested_by !== "system" || action.card_id) continue;
    out.push(action);
    recovered = false;
  }
  return { actions: out, recovered };
}

export function storageCorsInstructions(check: StorageCorsCheck) {
  const reason = check.refused.some((r) => r.reason === "not_enabled")
    ? "存储桶没有开启跨域（CORS）"
    : `存储桶的跨域规则不允许 ${check.refused.map((r) => r.origin).join("、")} 上传`;
  return [
    `私有存储桶 ${check.bucket}（${check.region}）未允许本站跨域上传：${reason}。浏览器在共享文件页上传会失败；Agent 和主机不受影响。`,
    `请在阿里云 OSS 控制台：Bucket 列表 → ${check.bucket} → 数据安全 → 跨域设置 → 创建规则（已有规则时编辑该规则）：`,
    `来源：${check.origins.join("、")}（每行一个）`,
    "允许 Methods：PUT、GET、HEAD",
    "允许 Headers：content-type、x-oss-forbid-overwrite",
    "暴露 Headers 留空，缓存时间 600 秒，保存。",
    "保存后不用回到 Cardigan 操作：系统几分钟内复检，通过后自动结项。",
  ].join("\n");
}

/** Internal host check only; never called on behalf of an Agent. */
export function reconcileStorageCorsAction(
  state: CommandState,
  actor: Actor,
  check: StorageCorsCheck,
  ports: CommandPorts,
) {
  return command(state, actor, "record_storage_cors", ports, (d) => {
    ensure(
      BUCKET.test(check.bucket) &&
        REGION.test(check.region) &&
        check.origins.length > 0 &&
        check.origins.length <= 16 &&
        check.origins.every((o) => ORIGIN.test(o)) &&
        check.refused.every(
          (r) =>
            check.origins.includes(r.origin) &&
            (r.reason === "not_enabled" || r.reason === "not_allowed"),
        ),
      "validation_failed",
      "存储跨域复检结果无效",
    );
    const { actions, recovered } = storageCorsActions(d);
    const open = actions.filter((a) => a.status === "open");
    const last = actions.at(-1);
    if (!check.refused.length) {
      const reason = `系统复检通过：存储桶 ${check.bucket} 已允许 ${check.origins.join("、")} 跨域上传`;
      if (
        !open.length &&
        last &&
        last.cancellation?.source !== SOURCE &&
        !recovered
      )
        d.emit(RECOVERED, undefined, {
          bucket: check.bucket,
          origins: [...check.origins],
        });
      for (const action of open) {
        d.put("human_actions", {
          ...action,
          status: unwrap(transition("human_action", action.status, "cancel")),
          cancellation: { reason, by: d.author, at: d.now, source: SOURCE },
        });
        d.emit("human_action_cancelled", undefined, {
          human_action_id: action.id,
          reason,
          source: SOURCE,
        });
      }
      return;
    }
    const instructions = storageCorsInstructions(check);
    const [current, ...extra] = open;
    if (current) {
      // Only one open at a time; a duplicate left by an older host is folded.
      for (const action of extra) {
        const reason = `已并入 ${current.id}`;
        d.put("human_actions", {
          ...action,
          status: unwrap(transition("human_action", action.status, "cancel")),
          cancellation: { reason, by: d.author, at: d.now, source: SOURCE },
        });
        d.emit("human_action_cancelled", undefined, {
          human_action_id: action.id,
          reason,
          source: SOURCE,
        });
      }
      if (current.instructions !== instructions) {
        d.put("human_actions", { ...current, instructions });
        d.emit("storage_cors_action_updated", undefined, {
          human_action_id: current.id,
          bucket: check.bucket,
          origins: [...check.origins],
        });
      }
      return;
    }
    // Closed by the owner while still refused: not reopened until a recheck
    // has passed in between.
    if (last && last.cancellation?.source !== SOURCE && !recovered) return;
    const id = d.ids.next(d.state.project_id, "human_action");
    d.put("human_actions", {
      id,
      key: id,
      requested_by: "system",
      status: "open",
      category: "account",
      triage: "human",
      instructions,
      why_human:
        "修改存储桶跨域规则需要登录阿里云账号；Cardigan 只有读写对象的权限，不能也不会改桶配置。",
      expected_return: "规则保存后系统复检通过会自动结项，无需回填。",
      blocked_work_items: [],
    });
    d.emit("human_action_requested", undefined, {
      human_action_id: id,
      storage_cors: STORAGE_CORS_KEY,
      blocked_work_items: [],
      bucket: check.bucket,
      origins: [...check.origins],
    });
  });
}
