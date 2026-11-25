import {
  attempt,
  CommandDraft,
  type CommandState,
  ensure,
} from "./commands/core.js";
import type { Actor } from "./entities.js";
import type { Result } from "./errors.js";
import type { AssignmentId, CardId, DeliveryId, WorkItemId } from "./ids.js";

/** C-611: a host-run macOS check of the current delivery; the host owns all IO. */
export const MACOS_CHECK_MAX_FILES = 16;
const FILE =
  /^(?:apps|packages)\/[a-z0-9-]+\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.test\.(?:ts|tsx|mts)$/u;
/** Repository-relative test files only: no options, globs, `..` or absolute paths. */
export function validMacosTestFiles(files: unknown): files is string[] {
  return (
    Array.isArray(files) &&
    files.length > 0 &&
    files.length <= MACOS_CHECK_MAX_FILES &&
    new Set(files).size === files.length &&
    files.every(
      (file) =>
        typeof file === "string" &&
        file.length <= 200 &&
        FILE.test(file) &&
        !file.split("/").some((part) => part === "." || part === ".."),
    )
  );
}
export interface MacosCheckTarget {
  readonly project_id: string;
  readonly card_id: CardId;
  /** The requesting author or verifier; only identity comes from the token. */
  readonly requester: {
    readonly assignment_id: AssignmentId;
    readonly work_item_id: WorkItemId;
    readonly role_id: string;
  };
  readonly producer_work_item_id: WorkItemId;
  readonly delivery_id: DeliveryId;
  /** Exact subject of the current delivery; the host merges it onto the baseline. */
  readonly head_sha: string;
}
/**
 * The active owner of the producer, or of a verify item targeting it, may
 * request a check of that producer's current Git delivery.
 */
export function authorizeMacosCheck(
  state: CommandState,
  actor: Actor,
): Result<MacosCheckTarget> {
  return attempt(() => {
    const d = new CommandDraft(state, actor, "request_macos_check");
    const a = d.assignment;
    ensure(
      actor.kind === "assignment" &&
        a?.scope === "work_item" &&
        a.status === "active",
      "unauthorized",
      "只有本卡当前作者或审核员可以请求 macOS 检查",
    );
    const own = d.ownWork(a.work_item_id);
    ensure(
      own.status !== "cancelled" &&
        (own.kind === "produce" ||
          (own.kind === "verify" && own.target_work_item_id !== undefined)),
      "unauthorized",
      "只有产出项负责人或以它为目标的审核项负责人可以请求",
    );
    const producer =
      own.kind === "produce"
        ? own
        : d.work(own.target_work_item_id as WorkItemId);
    const card = d.card(own.card_id);
    ensure(
      producer.kind === "produce" &&
        producer.card_id === card.id &&
        producer.status !== "cancelled",
      "unauthorized",
      "审核目标不是本卡的产出项",
    );
    ensure(!card.hold, "illegal_transition", "卡片已暂停，请先解除暂停");
    ensure(
      !["done", "cancelled"].includes(card.status),
      "illegal_transition",
      "已关闭的卡片不能请求 macOS 检查",
    );
    const delivery = d
      .list("deliveries")
      .find(
        (v) =>
          v.work_item_id === producer.id &&
          v.kind !== "card_completion" &&
          v.status !== "superseded",
      );
    ensure(
      delivery?.subject.kind === "git_head" &&
        /^[a-f0-9]{40}$/u.test(delivery.subject.value),
      "illegal_transition",
      "产出项还没有当前的 Git 交付",
    );
    return {
      project_id: state.project_id,
      card_id: card.id,
      requester: {
        assignment_id: a.id,
        work_item_id: own.id,
        role_id: a.role_id,
      },
      producer_work_item_id: producer.id,
      delivery_id: delivery.id,
      head_sha: delivery.subject.value,
    } satisfies MacosCheckTarget;
  });
}
