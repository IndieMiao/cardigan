import type { Decision, PlainSummary } from "../entities.js";
import { ensure } from "./core.js";

/**
 * C-202: the "人话概述" of a decision handed to the human. Three short,
 * plain-language fields, each with a code-point limit.
 */
export const PLAIN_SUMMARY_LIMITS = {
  changed: 150,
  impact: 150,
  risk: 100,
} as const satisfies Record<keyof PlainSummary, number>;

const LABELS: Record<keyof PlainSummary, string> = {
  changed: "改了什么",
  impact: "对你的影响",
  risk: "风险",
};

/**
 * Simple jargon rules (C-202 acceptance): internal record numbers (work items,
 * assignments, runs, deliveries, reviews, decisions, human actions, including
 * the legacy `q(n)` / `h(n)` spelling), commit hashes, backticks, and
 * interface-style identifiers (snake_case, camelCase, `key=value`).
 * Card numbers (C-n) stay allowed: the human reads cards by number.
 */
const JARGON: readonly { readonly what: string; readonly re: RegExp }[] = [
  {
    what: "交付号、审核号、拍板号等内部编号",
    re: /(?<![0-9A-Za-z])[WARDVQH]-\d+(?![0-9])/u,
  },
  { what: "拍板号、待办号等内部编号", re: /(?<![0-9A-Za-z])[qh]\(\d+\)/u },
  {
    what: "提交号",
    re: /(?<![0-9A-Za-z])(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}(?![0-9A-Za-z])/iu,
  },
  { what: "反引号包住的接口名", re: /`/u },
  {
    what: "接口名或英文枚举",
    re: /(?<![0-9A-Za-z])[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*[A-Za-z0-9]/u,
  },
  { what: "接口名", re: /(?<![A-Za-z])[a-z]+[A-Z][a-z][A-Za-z0-9]*/u },
  { what: "参数写法", re: /[A-Za-z_][A-Za-z0-9_]*=/u },
];

/** The first jargon match in `value`, with a plain description. */
export function plainSummaryJargon(
  value: string,
): { readonly what: string; readonly match: string } | undefined {
  for (const rule of JARGON) {
    const m = rule.re.exec(value);
    if (m) return { what: rule.what, match: m[0] };
  }
  return undefined;
}

/**
 * Validate and normalize a plain summary. `owner` names the parameter in the
 * error ("plain_summary" or the completion's "人话改动说明").
 */
export function buildPlainSummary(
  input: unknown,
  owner = "人话概述（plain_summary）",
): PlainSummary {
  ensure(
    typeof input === "object" && input !== null && !Array.isArray(input),
    "validation_failed",
    `缺少${owner}：请用白话写清“改了什么”“对你的影响”“风险”三项（没有风险就写“无”）`,
  );
  const raw = input as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of Object.keys(LABELS) as (keyof PlainSummary)[]) {
    const label = LABELS[key];
    const value = raw[key];
    ensure(
      typeof value === "string" && value.trim().length > 0,
      "validation_failed",
      `${owner}缺少“${label}”（${key}）：请用一两句白话填写${key === "risk" ? "，没有风险就写“无”" : ""}`,
    );
    const trimmed = value.trim();
    const limit = PLAIN_SUMMARY_LIMITS[key];
    ensure(
      [...trimmed].length <= limit,
      "validation_failed",
      `${owner}的“${label}”太长了：最多 ${limit} 个字，现在 ${[...trimmed].length} 个字，请压缩成一两句`,
    );
    const jargon = plainSummaryJargon(trimmed);
    ensure(
      !jargon,
      "validation_failed",
      `${owner}的“${label}”里不能出现${jargon?.what}（发现“${jargon?.match}”），请改用人能看懂的白话`,
    );
    out[key] = trimmed;
  }
  const extra = Object.keys(raw).filter((k) => !(k in LABELS));
  ensure(
    extra.length === 0,
    "validation_failed",
    `${owner}只有 changed、impact、risk 三项，不认识：${extra.join("、")}`,
  );
  return out as unknown as PlainSummary;
}

/** True when `risk` says there is none ("无"), so the UI need not flag it. */
export function plainSummaryNoRisk(summary: PlainSummary): boolean {
  return /^无[。.！!]?$/u.test(summary.risk.trim());
}

export const samePlainSummary = (a?: PlainSummary, b?: PlainSummary) =>
  a?.changed === b?.changed && a?.impact === b?.impact && a?.risk === b?.risk;

const CATEGORY_RISK: Readonly<Record<string, string>> = {
  spending: "涉及花钱，请看详细信息",
  account: "涉及账号，请看详细信息",
  permission: "涉及权限，请看详细信息",
  data_deletion: "涉及删除数据，请看详细信息",
  scope_change: "涉及需求范围变化，请看详细信息",
};

/**
 * C-202: written by the system when it hands a decision without a plain
 * summary to the human by itself (PM Ops paused or released, delegation
 * revoked, card marked sensitive). Merge confirmations are left alone: theirs
 * comes from the completion request, and older ones show `context` as before.
 */
export function systemHandoffPlainSummary(q: Decision): PlainSummary {
  return {
    changed:
      "这条拍板原本由项目经理处理，现在项目经理处理不了，系统把它转交给你；具体问题见标题和详细信息",
    impact: q.blocking
      ? "你拍板之前，相关工作会一直等着"
      : "这条拍板不挡工作，可以稍后处理",
    risk:
      CATEGORY_RISK[q.category ?? "general"] ??
      "系统没有评估风险，请看详细信息",
  };
}

/** C-202: the plain summary of the system's review-limit decision. */
export const REVIEW_LIMIT_PLAIN_SUMMARY: PlainSummary = {
  changed: "审核员的审核轮数用完了，需要决定是再给一轮审核，还是先暂停",
  impact: "拍板之前，这项审核会一直停着",
  risk: "无",
};

/** C-202: the plain summary of the system's worktree cleanup decision. */
export const WORKTREE_CLEANUP_PLAIN_SUMMARY: PlainSummary = {
  changed: "一名员工的工作已经结束，问你是保留还是清理留下的本地工作区",
  impact: "保留就什么都不变；清理会先把改动存成补丁，再删掉工作区文件",
  risk: "选清理会删除本地文件（会先存补丁备份）",
};
