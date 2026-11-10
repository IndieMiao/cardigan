import type {
  RoleDefinitionView,
  RoleEditInput,
  RoleKind,
  RoleWorktree,
} from "./api.js";

export const ROLE_KIND_LABELS: Readonly<Record<RoleKind | "work", string>> = {
  produce: "产出",
  verify: "验证",
  standing: "常驻",
  work: "旧版（按工具推断）",
};

export const WORKTREE_LABELS: Readonly<Record<RoleWorktree, string>> = {
  none: "不建 worktree",
  readonly: "只读",
  write: "可写",
};

export const ROLE_FIELD_LABELS: Readonly<Record<string, string>> = {
  display_name: "显示名",
  kind: "类型",
  instructions: "角色说明（instructions）",
  core_prompt: "旧版 core_prompt",
  harness: "Harness",
  launch_profile_ref: "启动配置",
  allowed_tools: "可用工具",
  capabilities: "能承担的工作项种类（capabilities）",
  abilities: "能力标签（abilities）",
  worktree: "worktree 模式",
  required_machine_tags: "机器标签",
};

/** Shown on every detail and edit view (plan p2v-9-10 §2.1 版本). */
export const ROLE_VERSION_PIN_NOTICE =
  "已有 Assignment 固定在创建指派时的角色版本，继续使用旧版本执行；保存或回退只影响之后的新指派。";

type Comparable = Pick<
  RoleDefinitionView,
  | "display_name"
  | "kind"
  | "instructions"
  | "core_prompt"
  | "harness"
  | "launch_profile_ref"
  | "allowed_tools"
  | "capabilities"
  | "abilities"
  | "worktree"
  | "required_machine_tags"
>;

export type RoleFieldDiff =
  | {
      readonly field: string;
      readonly type: "list";
      readonly added: readonly string[];
      readonly removed: readonly string[];
    }
  | {
      readonly field: string;
      readonly type: "text";
      readonly lines: readonly LineDiff[];
    }
  | {
      readonly field: string;
      readonly type: "value";
      readonly before: string;
      readonly after: string;
    };

export interface LineDiff {
  readonly op: "same" | "add" | "remove";
  readonly text: string;
}

const LIST_FIELDS = [
  "allowed_tools",
  "capabilities",
  "abilities",
  "required_machine_tags",
] as const;
const TEXT_FIELDS = ["instructions", "core_prompt"] as const;
const VALUE_FIELDS = [
  "display_name",
  "kind",
  "harness",
  "launch_profile_ref",
  "worktree",
] as const;

/** Line-level LCS diff; role instructions are short enough for O(n·m). */
export function diffLines(before: string, after: string): LineDiff[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const table = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      (table[i] as number[])[j] =
        a[i] === b[j]
          ? ((table[i + 1] as number[])[j + 1] as number) + 1
          : Math.max(
              (table[i + 1] as number[])[j] as number,
              (table[i] as number[])[j + 1] as number,
            );
  const out: LineDiff[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: "same", text: a[i] as string });
      i++;
      j++;
    } else if (
      ((table[i + 1] as number[])[j] as number) >=
      ((table[i] as number[])[j + 1] as number)
    ) {
      out.push({ op: "remove", text: a[i++] as string });
    } else out.push({ op: "add", text: b[j++] as string });
  }
  while (i < a.length) out.push({ op: "remove", text: a[i++] as string });
  while (j < b.length) out.push({ op: "add", text: b[j++] as string });
  return out;
}

function valueLabel(field: string, value: string | undefined): string {
  if (value === undefined || value === "") return "（空）";
  if (field === "kind") return ROLE_KIND_LABELS[value as RoleKind] ?? value;
  if (field === "worktree")
    return WORKTREE_LABELS[value as RoleWorktree] ?? value;
  return value;
}

/** Field-by-field differences between two role versions. */
export function roleDiff(
  previous: Comparable,
  current: Comparable,
): RoleFieldDiff[] {
  const out: RoleFieldDiff[] = [];
  for (const field of VALUE_FIELDS) {
    if (previous[field] !== current[field])
      out.push({
        field,
        type: "value",
        before: valueLabel(field, previous[field]),
        after: valueLabel(field, current[field]),
      });
  }
  for (const field of TEXT_FIELDS) {
    const before = previous[field] ?? "";
    const after = current[field] ?? "";
    if (before !== after)
      out.push({ field, type: "text", lines: diffLines(before, after) });
  }
  for (const field of LIST_FIELDS) {
    const added = current[field].filter((v) => !previous[field].includes(v));
    const removed = previous[field].filter((v) => !current[field].includes(v));
    if (added.length || removed.length)
      out.push({ field, type: "list", added, removed });
  }
  return out;
}

const WORKTREE_RANK: Readonly<Record<RoleWorktree, number>> = {
  none: 0,
  readonly: 1,
  write: 2,
};

/**
 * Permission-related fields this edit widens (plan C-52 item 5). The save is
 * the human's confirmation (D12); this list only explains what changes.
 */
export function roleRelaxations(
  current: Comparable,
  draft: Required<Omit<RoleEditInput, "instructions">>,
): string[] {
  const out: string[] = [];
  const tools = draft.allowed_tools.filter(
    (tool) => !current.allowed_tools.includes(tool),
  );
  if (tools.length) out.push(`新增可用工具：${tools.join("、")}`);
  const capabilities = draft.capabilities.filter(
    (value) => !current.capabilities.includes(value),
  );
  if (capabilities.length)
    out.push(`新增可承担的工作项种类：${capabilities.join("、")}`);
  if (WORKTREE_RANK[draft.worktree] > WORKTREE_RANK[current.worktree])
    out.push(
      `worktree 权限从“${WORKTREE_LABELS[current.worktree]}”放宽到“${WORKTREE_LABELS[draft.worktree]}”`,
    );
  if (draft.kind !== current.kind)
    out.push(
      `角色类型从“${valueLabel("kind", current.kind)}”改为“${ROLE_KIND_LABELS[draft.kind]}”，可用工具白名单随之改变`,
    );
  const tags = current.required_machine_tags.filter(
    (tag) => !draft.required_machine_tags.includes(tag),
  );
  if (tags.length)
    out.push(`移除机器标签限制：${tags.join("、")}，可在更多机器上运行`);
  return out;
}

/** Comma, Chinese comma or newline separated list, trimmed and de-duplicated. */
export function parseList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,，\n]/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}
