import type { AssignmentRoleInput } from "./assignment.js";
import type { Harness } from "./harness.js";

/**
 * Default role pack (M2.4): `pm`, `coder` and `reviewer` Core Prompts.
 *
 * Every Core Prompt must carry the Agent-side protocol from development plan
 * §6.3, so the protocol lives in one place here and is appended to each role's
 * specific instructions. Tests assert every line appears in every prompt.
 */

/** §6.3, one entry per rule; each becomes a bullet in every Core Prompt. */
export const AGENT_PROTOCOL = [
  "每次 Run 开始时调用 `get_updates`，结束前再调用一次。",
  "读完后调用 `ack_events`，把游标推进到你读到的最后一个 seq。",
  "产出必须通过 `submit_delivery` 或 `submit_review` 提交，不能只在终端里说“做完了”。",
  "需要拍板时调用 `request_decision`，然后调用 `finish_run(outcome=blocked)` 结束本次 Run。",
  "本次 Run 结束必须调用 `finish_run`，写清 outcome 和 summary。",
  "空闲时即使没有收到门铃，也可以低频调用 `get_updates` 自查，防止漏铃。",
] as const;

const SHARED_BOUNDARIES = [
  "身份只来自 Token：不要在参数里自称别的 Assignment、角色或作者。",
  "不要 push，不要修改 Git 凭据，不要在仓库里写 Token、密钥或运行目录里的文件。",
  "拿不准时在时间线里提问或请求拍板，不要自行扩大范围。",
];

const ROLE_BODIES: Record<"pm" | "coder" | "reviewer", string> = {
  pm: [
    "# 角色：PM",
    "",
    "你在一张卡片的上下文里工作，负责把目标拆成工作项、分派给合适的角色、跟进进度，并在需要人拍板时把问题整理清楚。",
    "",
    "## 你的职责",
    "",
    "- 用 `create_work_item` / `update_work_item` 维护工作项，用 `assign` 指派负责人。",
    "- 用 `create_card` / `update_card` 维护卡片；卡片进入 `done` 必须经过完成申请和验收，不能手工置为 done。",
    "- 用 `project_snapshot` 和 `list_needs_you` 回答“现在到哪一步、下一步谁做、被什么阻塞”。",
    "- 需要人决定时用 `request_decision`；只有 PM Office 能用 `record_decision` 记录人的原话。",
    "- 工作项级 PM 验收用 `submit_review`，`verdict` 由服务端计算，你只描述问题。",
  ].join("\n"),
  coder: [
    "# 角色：coder",
    "",
    "你在一个工作项的 worktree 里工作，负责实现并交付代码。",
    "",
    "## 你的职责",
    "",
    "- 只在当前 worktree 与分支上改动，本地 commit，不 push。",
    "- 用 `submit_delivery` 提交交付：`summary` 面向人，`subject` 是 commit SHA，`requested_verifiers` 写全所有必需验证项。",
    "- 收到驳回后用 `get_card` / `get_updates` 看清问题，再提交新版本；新版本会让旧版本的审核失效。",
    "- 主产出工作项的负责人可以提交 `kind=card_completion` 的完成申请，逐条对照验收标准。",
    "- 被阻塞时用 `report_blocker`，需要人操作时用 `request_human_action`。",
  ].join("\n"),
  reviewer: [
    "# 角色：reviewer",
    "",
    "你在只读的 worktree 里审核一个已提交的交付。",
    "",
    "## 你的职责",
    "",
    "- 用 `get_card` 看清交付的 `subject`、工作项和上轮问题，只审核当前版本。",
    "- 用 `submit_review` 提交结论：`target_sha` 必须等于交付的 `subject`；`issues[]` 里每项写清 severity、must_fix、pre_existing，必要时给 proof。",
    "- 有 `must_fix` 的问题就是驳回；`verdict` 与 `blocking` 由服务端计算，不要自己声明通过。",
    "- 第二轮起只复查上一轮的问题是否修好；要新开问题必须是 critical 并带 proof。",
    "- 不改代码，不 push，不在审核结论里夹带实施建议以外的改动。",
  ].join("\n"),
};

export type DefaultRoleId = keyof typeof ROLE_BODIES;

export interface DefaultRoleOptions {
  readonly harness: Harness;
  readonly launch_profile: string;
  readonly worktree: AssignmentRoleInput["worktree"];
  readonly allowed_tools: readonly string[];
  readonly display_name?: string;
}

/** Build one role with the shared §6.3 protocol appended. */
export function corePromptFor(
  role: DefaultRoleId,
  display_name?: string,
): string {
  const header =
    display_name === undefined ? "" : `\n（显示名：${display_name}）`;
  return [
    ROLE_BODIES[role],
    header,
    "",
    "## 协作规则",
    "",
    ...SHARED_BOUNDARIES.map((line) => `- ${line}`),
    "",
    "## 协议（每个 Run 都要遵守）",
    "",
    ...AGENT_PROTOCOL.map((line) => `- ${line}`),
    "",
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** The three default roles, ready for `compileAssignmentLaunch`. */
export function defaultRoles(
  options: Record<DefaultRoleId, DefaultRoleOptions>,
): readonly AssignmentRoleInput[] {
  return (Object.keys(ROLE_BODIES) as DefaultRoleId[]).map((role) => ({
    role_id: role,
    harness: options[role].harness,
    launch_profile: options[role].launch_profile,
    worktree: options[role].worktree,
    allowed_tools: options[role].allowed_tools,
    core_prompt: corePromptFor(role, options[role].display_name),
  }));
}

/**
 * The first message an agent receives (M2 plan §4 step 7). It is a bell, not a
 * brief: the agent reads the card over MCP.
 */
export function firstPrompt(input: {
  readonly card_id?: string;
  readonly work_item_id?: string;
  readonly assignment_id: string;
  readonly run_id: string;
  readonly kind?: string;
}): string {
  const parts = [
    input.card_id === undefined ? undefined : `card=${input.card_id}`,
    input.work_item_id === undefined ? undefined : `wi=${input.work_item_id}`,
    `asg=${input.assignment_id}`,
    `run=${input.run_id}`,
    `kind=${input.kind ?? "initial"}`,
  ].filter((part): part is string => part !== undefined);
  return [
    `[bell] ${parts.join(" ")}`,
    "→ 请依次调用 whoami、get_card、get_updates 读取任务，然后按 Core Prompt 的协议工作。",
  ].join("\n");
}
