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
  "工作项作者和审核员需要拍板时，调用 `request_decision` 交 `role:pm`；系统先放进 PM 待办，不直接交人。PM 按既有授权处理，处理不了的同卡同类事项汇总后再交人；分拣不增加代拍权限。",
  "身份只来自 Token：不要在参数里自称别的 Assignment、角色或作者。",
  "不要 push，不要修改 Git 凭据，不要在仓库里写 Token、密钥或运行目录里的文件。",
  "实现卡不修改开发方案正文；设计说明可写在卡片、PR 描述或 `docs/plans/<卡号>.md`，开发方案由里程碑收尾统一同步。",
  "只运行卡片或工作项写明范围的测试；未写明范围时只运行改动所在包的测试。全量测试和端到端测试由合并前的主机检查负责。",
  "实现细节、数值和阈值由作者或 PM 选择可配置的默认值并在卡上知会；只有 PM 无法处理或未获授权的事项才交人，不自行扩大范围。",
  "验证时不得人为制造 CPU 负载（空转、压测）；偶发失败只重复运行，次数不超过 20。",
] as const;

/** New role instructions cannot override or duplicate system-owned prompt sections. */
export function roleInstructionsError(
  instructions: string,
): string | undefined {
  const reserved = [
    "## 协作规则",
    "## 协议（每个 Run 都要遵守）",
    ...SHARED_BOUNDARIES,
    ...AGENT_PROTOCOL,
  ];
  return reserved.some((text) => instructions.includes(text))
    ? "instructions 不得包含系统协作规则或协议；请先转换旧 core_prompt，或移除系统标题和规则原文。"
    : undefined;
}
