import type { ErrorCode, RuntimeErrorCode } from "@cardigan/domain";
import {
  attachmentTooLargeMessage,
  formatAttachmentLimit,
  MAX_ATTACHMENT_BYTES,
} from "@cardigan/mcp-server";

interface CodedError {
  readonly code: string;
  readonly message: string;
}

const REASONS = {
  not_found: "对象在当前项目中不存在",
  illegal_transition: "当前状态不允许执行此操作",
  invariant_violation: "操作不符合业务约束",
  validation_failed: "参数未通过校验，请检查输入",
  unauthorized: "当前身份无权执行此操作",
  forbidden_tool: "当前角色不允许使用此工具",
  idempotency_conflict: "同一幂等键已用于不同的请求，请使用新的幂等键",
  stale_target: "目标版本已过期，请读取最新版本后重试",
  runtime_not_found: "运行终端不存在或已结束",
  runtime_unavailable: "运行时不可用，请检查运行服务",
  version_mismatch: "运行时版本不兼容，请检查安装的版本",
  runtime_timeout: "运行时响应超时，请稍后重试",
  runtime_queue_timeout: "运行时调用排队超时，命令尚未执行",
  runtime_conflict: "运行时存在冲突，请检查已有终端",
  invalid_launch: "启动配置不合法，请检查配置",
} satisfies Record<ErrorCode | RuntimeErrorCode, string>;

const SPECIFIC_REASONS: Partial<Record<ErrorCode, Record<string, string>>> = {
  invariant_violation: {
    "A work item has one persistent assignment":
      "这个工作项已经有负责的 Assignment，不能再指派新的",
    "Assignment or worktree already has an unfinished Run":
      "这个 Assignment 或工作区已有尚未结束的 Run，不能重复启动",
    "No accepted Git delivery to merge": "没有已通过审核的 Git 交付可供合并",
  },
  illegal_transition: {
    "Assignment role upgrade is pending":
      "角色升级尚未结束，请等待主机完成升级后再启动。",
    "A host operation is pending":
      "主机运维操作尚未结束，请在 Needs You 核对处理进度后再启动。",
    "Assignment or worktree has a pending host operation":
      "这个身份或工作区正在由主机运维处理，请等待操作结束后再启动。",
    "Worktree has a pending role upgrade":
      "工作区有待完成的角色升级，请等待升级结束后再启动。",
    "Assignment must be active":
      "身份已暂停或释放；暂停的常驻 PM 用 cardigan pm start 恢复，已释放身份不能重新启动，请交 PM 核对。",
    "Cannot apply run_started to runtime:unknown":
      "旧终端状态未知，尚未证明退出；请交主机运维核对旧终端，确认退出后恢复。",
    "Cannot apply run_started to runtime:lost":
      "旧终端失联，尚未证明退出；请交主机运维核对旧终端，确认退出后恢复。",
    "Cannot apply run_started to runtime:released":
      "运行身份已释放，不能重新启动；请交 PM 核对当前负责人。",
    "Launch stop is in progress":
      "旧启动代次正在停止，请等待可信退出确认后再启动。",
    "Only done or cancelled cards can be superseded":
      "只有已完成或已取消的卡片才能标记为被取代",
    "Cannot apply cancel to card:done":
      "已完成卡片不能取消；请建新卡（例如回滚卡），再用 --superseded-by <C-m> 标记旧卡",
    "Card is closed": "卡片已关闭，不能执行此操作",
    "Card is not awaiting merge": "卡片尚未进入待合并状态",
    "Merge confirmation has not been granted for this completion":
      "本次完成申请尚未获得合并确认",
  },
  validation_failed: {
    "title is required": "标题不能为空",
    "goal is required": "目标不能为空",
    "Acceptance criteria are required": "至少需要一条非空的验收标准",
    "Invalid priority": "优先级必须是无、低、中、高或紧急",
    "A card cannot supersede itself": "卡片不能被自身取代",
    "Assignment role must match the work item":
      "指派的角色必须与工作项要求一致",
    "M1 assignments run on local only": "当前只支持指派到 local 机器",
    "repo_path must be absolute": "仓库路径必须是绝对路径",
    "base_branch is not a valid branch name": "基线分支名称不合法",
    "Only a standing Assignment has a standing_mode":
      "只有常驻 Assignment 才能设置模式",
    "Only the pm role has a standing_mode": "只有 pm 角色才能设置常驻模式",
    "standing_mode must be office or ops": "常驻模式必须为 office 或 ops",
    "A standing Assignment cannot change its mode":
      "常驻 Assignment 不能更改模式",
    [attachmentTooLargeMessage()]: `附件超过 ${formatAttachmentLimit(MAX_ATTACHMENT_BYTES)}`,
    "File must be canonical padded base64": "附件编码不合法",
    "Attachment sha256 does not match content": "附件 SHA-256 校验失败",
    "Attachment storage failed":
      "附件存储失败，请检查数据目录权限和已存文件的完整性",
    "Artifacts require a decision basis":
      "artifact 附件必须提供 --basis 拍板编号",
    "Attachment target belongs to another card": "附件挂载条目属于另一张卡片",
    "original_filename must be at most 200 characters":
      "附件文件名不能超过 200 字符",
    "note must be at most 200 characters": "附件说明不能超过 200 字符",
    "original_filename must not contain control characters":
      "附件文件名不能包含控制字符",
    "note must not contain control characters": "附件说明不能包含控制字符",
  },
  not_found: {
    "Role version was not found": "角色版本不存在，请先添加角色",
    "Card was not found in this project": "卡片在当前项目中不存在",
    "Attachment basis was not found": "附件依据的拍板在当前项目中不存在",
    "Attachment target was not found": "附件挂载条目在当前项目中不存在",
  },
};

/** Presentation only: callers retain their existing exit codes and transactions. */
export function formatCommandError(
  operation: string,
  target: string,
  error: CodedError,
): string {
  return `无法${operation} ${target}：${describeError(error)}（${error.code}）`;
}

/** The host launch adapter wraps domain/Runtime errors as plain Error messages. */
export function formatLaunchError(
  target: string,
  error: unknown,
): string | undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  for (const value of [error, cause]) {
    if (
      typeof value === "object" &&
      value !== null &&
      "code" in value &&
      typeof value.code === "string" &&
      "message" in value &&
      typeof value.message === "string"
    )
      return formatCommandError("启动 Assignment", target, {
        code: value.code,
        message: value.message,
      });
  }
  const message = error instanceof Error ? error.message : error;
  if (typeof message !== "string") return undefined;
  if (message === "Assignment delivery is in progress")
    return `无法启动 Assignment ${target}：已有启动或门铃派发正在处理，请等待完成后核对 Run，不要重复启动。`;
  if (message === "Review budget is waiting for a decision")
    return `无法启动 Assignment ${target}：审核正在等待拍板，请先完成当前处理事项。`;
  const match =
    /^(?:provision failed: )?([a-z]+(?:_[a-z]+)+)(?:: | )(.*)$/su.exec(message);
  if (!match) return undefined;
  return formatCommandError("启动 Assignment", target, {
    code: match[1] as string,
    message: match[2] as string,
  });
}

function describeError({ code, message }: CodedError): string {
  if (!Object.hasOwn(REASONS, code))
    return `操作被拒绝${message ? `：${message}` : ""}`;
  // Keep existing Chinese guidance, including recovery instructions.
  if (/\p{Script=Han}/u.test(message)) return message;
  const specifics = SPECIFIC_REASONS[code as ErrorCode];
  if (specifics && Object.hasOwn(specifics, message))
    return specifics[message] as string;
  if (code === "illegal_transition") {
    const transition =
      /^Cannot apply (cancel|set_backlog|set_todo) to card:(\w+)$/u.exec(
        message,
      );
    if (transition)
      return `不允许从 ${transition[2]} 转为 ${transition[1] === "cancel" ? "cancelled" : transition[1]?.slice(4)}`;
  }
  if (code === "not_found") {
    const role =
      /^role ([a-z0-9][a-z0-9._-]*)(?: v(\d+))? does not exist; use "role add" first$/u.exec(
        message,
      );
    if (role)
      return role[2]
        ? `角色版本 v${role[2]} 不存在，请用 cardigan role show ${role[1]} --history 查看版本历史`
        : "角色不存在，请先用 cardigan role add 创建";
  }
  if (
    code === "validation_failed" &&
    /^role [a-z0-9][a-z0-9._-]* already exists; use "role update" to add a new version$/u.test(
      message,
    )
  )
    return "角色已存在，请用 cardigan role update 添加新版本";
  if (code === "not_found") {
    const missingCard = /^cards:(C-[1-9]\d*) was not found$/u.exec(message);
    if (missingCard) return `卡片 ${missingCard[1]} 在当前项目中不存在`;
  }
  if (
    code === "validation_failed" &&
    /^project .* already exists$/u.test(message)
  )
    return "项目已存在，不能重复创建";
  return REASONS[code as keyof typeof REASONS];
}

/** Errors the CLI reports to the user, with a fixed process exit code. */
export class CliError extends Error {
  readonly exitCode: number;
  readonly details: readonly string[];

  constructor(
    message: string,
    exitCode: number,
    details: readonly string[] = [],
  ) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.details = details;
  }
}

export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  notInstalled: 127,
} as const;
