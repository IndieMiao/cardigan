import { splitQualifiedId } from "@cardigan/domain";

/** C-204: shared by number tags, prose references and the help page. */
export const ID_TYPES = [
  { prefix: "C", label: "卡片", token: "card" },
  { prefix: "W", label: "工作项", token: "work-item" },
  { prefix: "Q", label: "拍板", token: "decision" },
  { prefix: "A", label: "责任上下文", token: "assignment" },
  { prefix: "R", label: "执行", token: "run" },
  { prefix: "D", label: "交付", token: "delivery" },
  { prefix: "V", label: "审核", token: "review" },
  { prefix: "H", label: "人工待办", token: "human-action" },
  { prefix: "E", label: "员工", token: "employee" },
  { prefix: "M", label: "成员", token: "member" },
  { prefix: "MB", label: "合并批次", token: "merge-batch" },
] as const;

export const UNKNOWN_ID_TYPE = {
  prefix: "",
  label: "未知类型",
  token: "unknown",
} as const;

/** Presentation only: this must never resolve an entity or grant a link. */
export function idType(id: string) {
  // C-674: a full number (`SEN-C-34`) has the type of its project-scoped part.
  const local = splitQualifiedId(id)?.id ?? id;
  const match = /^([A-Z]+)-[1-9][0-9]*(#[1-9][0-9]*)?$/u.exec(local);
  if (!match || (match[2] && match[1] !== "C")) return undefined;
  const type = ID_TYPES.find((type) => type.prefix === match[1]);
  return match[2]
    ? { prefix: "C", label: "时间线条目", token: "card" }
    : (type ?? UNKNOWN_ID_TYPE);
}

export function idBadgeClass(id: string) {
  const type = idType(id);
  return type ? `id-badge id-type-${type.token}` : "id-plain";
}
