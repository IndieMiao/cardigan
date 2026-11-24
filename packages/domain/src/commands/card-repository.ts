import type { Card, WorkItem } from "../entities.js";
import { normalizeStartPoint, validBranchName } from "../start-point.js";
import { type CommandDraft, ensure, text } from "./core.js";

/** C-728: PM registration of a card's repository and start point. */
export interface CardRepositoryInput {
  readonly repo?: string;
  readonly base_branch?: string;
  /** Full commit SHA or branch; null clears. Only for merge_policy=none cards. */
  readonly start_point?: string | null;
}

type Registration = Pick<Card, "repo" | "base_branch" | "start_point">;

function parsedStartPoint(value: string | null | undefined) {
  if (value === undefined || value === null) return value;
  const normalized = normalizeStartPoint(value);
  ensure(
    normalized !== undefined,
    "validation_failed",
    "起点（start_point）只接受完整提交 SHA（40 或 64 位）或分支名",
  );
  return normalized;
}

/** A worktree is placed once; its repository and start point no longer move. */
function requireNoWorktree(
  d: CommandDraft,
  items: readonly WorkItem[],
  what: string,
) {
  const ids = new Set(items.map((w) => w.id));
  const placed = d
    .list("assignments")
    .filter(
      (a) =>
        a.status === "active" &&
        a.scope === "work_item" &&
        ids.has(a.work_item_id) &&
        a.worktree_path,
    )
    .map((a) => a.id);
  ensure(
    placed.length === 0,
    "illegal_transition",
    `${placed.join("、")} 已有 worktree，不能再改${what}；请先释放 Assignment 再修改并重新指派`,
    { assignments: placed },
  );
}

function requireNoMergeStartPoint(card: Card, repo: string | undefined) {
  ensure(
    card.merge_policy === "none",
    "validation_failed",
    "只有不合并的卡（merge_policy=none）能指定起点；合并卡从基线分支开工",
  );
  ensure(repo !== undefined, "validation_failed", "起点需要仓库（repo）");
}

/**
 * The card's new repository fields, or undefined when the request names none.
 * An omitted repo falls back to the card's, then to the project's only
 * registered repository; an omitted base branch to the card's, then to that
 * registration's.
 */
export function cardRepositoryUpdate(
  d: CommandDraft,
  card: Card,
  p: CardRepositoryInput,
): Registration | undefined {
  if (
    p.repo === undefined &&
    p.base_branch === undefined &&
    p.start_point === undefined
  )
    return undefined;
  if (p.repo !== undefined) text(p.repo, "repo");
  const registry = d.ports?.project_repositories;
  const only = registry?.length === 1 ? registry[0] : undefined;
  const repo = p.repo?.trim() ?? card.repo ?? only?.repo;
  const registration = registry?.find((r) => r.repo === repo);
  const base_branch =
    p.base_branch ??
    (repo === card.repo ? card.base_branch : registration?.base_branch) ??
    card.base_branch ??
    registration?.base_branch ??
    undefined;
  if (repo !== undefined)
    ensure(
      validBranchName(base_branch),
      "validation_failed",
      "基线分支（base_branch）缺失或不是合法分支名",
    );
  else
    ensure(
      base_branch === undefined,
      "validation_failed",
      "基线分支需要仓库（repo）",
    );
  const requested = parsedStartPoint(p.start_point);
  const start_point =
    requested === undefined ? card.start_point : (requested ?? undefined);
  if (requested) requireNoMergeStartPoint(card, repo);
  const next: Registration = {
    ...(repo === undefined ? {} : { repo }),
    ...(base_branch === undefined ? {} : { base_branch }),
    ...(start_point === undefined ? {} : { start_point }),
  };
  const items = d.list("work_items").filter((w) => w.card_id === card.id);
  if (next.repo !== card.repo || next.base_branch !== card.base_branch) {
    const ids = new Set(items.map((w) => w.id));
    // A delivered card's merge target and evidence stay bound to its repository.
    ensure(
      !d.list("deliveries").some((x) => ids.has(x.work_item_id)),
      "illegal_transition",
      "本卡已有交付，不能再改仓库或基线分支",
    );
  }
  if (
    next.repo !== card.repo ||
    next.base_branch !== card.base_branch ||
    next.start_point !== card.start_point
  )
    requireNoWorktree(d, items, "仓库或起点");
  return next;
}

/** The work item's new start point (undefined clears), validated against its card. */
export function workItemStartPoint(
  d: CommandDraft,
  card: Card,
  item: WorkItem,
  value: string | null,
): string | undefined {
  const start_point = parsedStartPoint(value) ?? undefined;
  ensure(
    item.kind === "produce",
    "validation_failed",
    "只有产出工作项能指定起点",
  );
  if (start_point !== undefined) requireNoMergeStartPoint(card, card.repo);
  if (start_point !== item.start_point) requireNoWorktree(d, [item], "起点");
  return start_point;
}

export function repositoryChangeNotes(
  before: Registration,
  after: Registration,
): string[] {
  const notes: string[] = [];
  if (after.repo !== before.repo || after.base_branch !== before.base_branch)
    notes.push(
      `仓库：${after.repo ?? "无"}${after.base_branch ? `（基线 ${after.base_branch}）` : ""}`,
    );
  if (after.start_point !== before.start_point)
    notes.push(`起点：${after.start_point ?? "无"}`);
  return notes;
}
