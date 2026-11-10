/** §6.3, one entry per rule; each becomes a bullet in every Core Prompt. */
export const AGENT_PROTOCOL = [
  "每次 Run 开始时调用 `get_updates`，结束前再调用一次。",
  "读完后调用 `ack_events`，把游标推进到你读到的最后一个 seq。",
  "产出必须通过 `submit_delivery` 或 `submit_review` 提交，不能只在终端里说“做完了”。",
  "需要拍板时调用 `request_decision`，然后调用 `finish_run(outcome=blocked)` 结束本次 Run。",
  "本次 Run 结束必须调用 `finish_run`，写清 outcome 和 summary。",
  "空闲时即使没有收到门铃，也可以低频调用 `get_updates` 自查，防止漏铃。",
] as const;

export const SHARED_BOUNDARIES = [
  "身份只来自 Token：不要在参数里自称别的 Assignment、角色或作者。",
  "不要 push，不要修改 Git 凭据，不要在仓库里写 Token、密钥或运行目录里的文件。",
  "不新建任务计划文件（例如 `docs/plans/` 下的计划）；任务计划由人或 PM 维护，设计改动只更新卡片要求的正文文档。",
  "只运行卡片或工作项写明范围的测试；未写明范围时只运行改动所在包的测试。全量测试和端到端测试由合并前的主机检查负责。",
  "拿不准时在时间线里提问或请求拍板，不要自行扩大范围。",
];

/** The system owns these sections; new roles store only their instructions. */
export function composeRolePrompt(instructions: string): string {
  return [
    instructions,
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

export interface ConvertedRoleInstructions {
  readonly instructions: string;
  readonly warnings: readonly string[];
}

/** Explicit conversion only: old prompts are never rewritten during reads or launches. */
export function convertLegacyRole(role: {
  readonly core_prompt: string;
  readonly instructions?: string;
}): ConvertedRoleInstructions {
  if (role.instructions !== undefined)
    return { instructions: role.instructions, warnings: [] };
  // Recognize the pack's structure, including older versions of its bullet text.
  const match =
    /\n## 协作规则\n\n(?:- [^\n]+\n)+\n## 协议（每个 Run 都要遵守）\n\n(?:- [^\n]+(?:\n|$))+\s*$/u.exec(
      role.core_prompt,
    );
  if (match !== null)
    return {
      instructions: role.core_prompt.slice(0, match.index).trimEnd(),
      warnings: [],
    };
  return {
    instructions: role.core_prompt,
    warnings: [
      "无法按默认角色包结构拆出角色说明；已保留整段 core_prompt，可能与系统协作规则和协议重复。",
    ],
  };
}
