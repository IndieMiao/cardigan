import type {
  CheckFailureClass,
  CheckFailureLabel,
  Event,
  MergeCheckView,
} from "./entities.js";
import { eventsOfType, eventsOfTypes } from "./event-index.js";
import type { CardId, DeliveryId } from "./ids.js";
import { prechecks } from "./precheck.js";

/**
 * C-766: notification-only classification of a failed merge check. It never
 * changes whether a check passed; only `flaky` may queue the single automatic
 * rerun that each completion already shares with timeout/infrastructure retries.
 */
export const CHECK_FAILURE_LABELS = [
  "baseline_drift",
  "genuine",
  "flaky",
  "unknown",
] as const;
export const CHECK_FAILURE_LABEL_TEXT: Readonly<
  Record<CheckFailureLabel, string>
> = {
  baseline_drift: "基线漂移",
  genuine: "本卡改动",
  flaky: "偶发",
  unknown: "无法判定",
};
/** Host evidence: `flaky` is derived by the domain from structured history only. */
export type HostCheckFailureClass = Omit<CheckFailureClass, "rerun"> & {
  readonly label: Exclude<CheckFailureLabel, "flaky">;
};
export const FAILURE_BASIS_MAX = 600;
const MAX_REFS = 10;
const fullSha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Steps that run before any test command; a failure there is environmental first. */
export const PRE_TEST_STEPS: readonly string[] = [
  "checkout",
  "setup",
  "bootstrap",
  "install",
];

/** The workspace package, else the top-level directory, of a repository path. */
export function failureModule(path: string): string {
  const clean = path.replace(/^\.\//u, "");
  const pkg = /^((?:packages|apps)\/[^/]+)\//u.exec(clean)?.[1];
  if (pkg) return pkg;
  const slash = clean.indexOf("/");
  return slash > 0 ? clean.slice(0, slash) : clean;
}

export interface MergedLink {
  readonly card_id: CardId;
  readonly merge_sha: string;
  readonly previous_sha: string;
}
/**
 * Merged cards reachable from `head` by following recorded merge results
 * backwards (`merge_sha` → `previous_sha`). Stops at an unrecorded commit.
 */
export function mergeChain(
  events: readonly Event[],
  head: string,
  limit = 20,
): MergedLink[] {
  const byMerge = new Map<string, MergedLink>();
  for (const e of eventsOfType(events, "card_merged")) {
    if (e.actor.kind !== "system" || !e.card_id) continue;
    const result = (
      e.payload as {
        result?: {
          merge_sha?: unknown;
          previous_sha?: unknown;
          noop?: unknown;
        };
      } | null
    )?.result;
    if (
      typeof result?.merge_sha !== "string" ||
      typeof result.previous_sha !== "string" ||
      result.noop === true ||
      result.merge_sha === result.previous_sha
    )
      continue;
    byMerge.set(result.merge_sha, {
      card_id: e.card_id,
      merge_sha: result.merge_sha,
      previous_sha: result.previous_sha,
    });
  }
  const chain: MergedLink[] = [];
  const seen = new Set<string>();
  for (let at = head; chain.length < limit && !seen.has(at); ) {
    seen.add(at);
    const link = byMerge.get(at);
    if (!link) break;
    chain.push(link);
    at = link.previous_sha;
  }
  return chain;
}

/**
 * The newest other baseline on which the same deliveries passed: an author
 * precheck of a delivered head, or an earlier check of this completion.
 */
export function passedOnOtherBase(
  events: readonly Event[],
  card_id: CardId,
  completion_id: DeliveryId,
  heads: readonly string[],
  base: string,
): string | undefined {
  const candidates: { seq: number; base: string }[] = [];
  for (const e of eventsOfTypes(events, ["merge_check_finished"])) {
    const p = e.payload as Partial<MergeCheckView> | null;
    if (
      e.card_id === card_id &&
      e.actor.kind === "system" &&
      p?.status === "passed" &&
      p.completion_id === completion_id &&
      p.base_sha &&
      p.base_sha !== base
    )
      candidates.push({ seq: e.seq, base: p.base_sha });
  }
  const newest = candidates.sort((a, b) => b.seq - a.seq)[0]?.base;
  if (newest) return newest;
  return prechecks(events, card_id).findLast(
    (c) =>
      c.status === "passed" &&
      heads.includes(c.head_sha) &&
      !!c.base_sha &&
      c.base_sha !== base,
  )?.base_sha;
}

/** Structured flaky evidence: a pre-test step failed, or this exact tree passed before. */
export function flakyEvidence(
  events: readonly Event[],
  card_id: CardId,
  check: Pick<MergeCheckView, "checks" | "tree_sha" | "status">,
): string | undefined {
  if (check.status !== "failed" && check.status !== "timed_out")
    return undefined;
  const failed = check.checks.filter((c) =>
    ["failed", "timed_out"].includes(c.status),
  );
  if (
    failed.length > 0 &&
    failed.every((c) => PRE_TEST_STEPS.includes(c.name)) &&
    check.checks.every(
      (c) =>
        PRE_TEST_STEPS.includes(c.name) ||
        c.status === "not_run" ||
        c.status === "skipped",
    )
  )
    return `测试开始前的步骤 ${failed.map((c) => c.name).join("、")} 失败`;
  const passedCheck = eventsOfTypes(events, ["merge_check_finished"]).some(
    (e) => {
      const p = e.payload as Partial<MergeCheckView> | null;
      return (
        e.card_id === card_id &&
        e.actor.kind === "system" &&
        p?.status === "passed" &&
        p.tree_sha === check.tree_sha
      );
    },
  );
  if (passedCheck) return "同一代码树此前的合并检查已通过";
  if (
    prechecks(events, card_id).some(
      (c) => c.status === "passed" && c.tree_sha === check.tree_sha,
    )
  )
    return "同一代码树此前的作者预检已通过";
  return undefined;
}

export interface FailureScope {
  /** Files located from the failure output (repository-relative). */
  readonly points: readonly string[];
  /** Files changed by this card's deliveries since their merge base. */
  readonly own: readonly string[];
  /** Cards merged between this card's merge base and the checked baseline. */
  readonly drift: readonly {
    readonly card_id: CardId;
    readonly merge_sha: string;
    readonly paths: readonly string[];
  }[];
  /** A baseline on which the same deliveries passed, when known. */
  readonly passed_base?: string;
  readonly base?: string;
}
const short = (sha: string) => sha.slice(0, 8);
function clipBasis(text: string) {
  return text.length <= FAILURE_BASIS_MAX
    ? text
    : `${text.slice(0, FAILURE_BASIS_MAX - 1)}…`;
}
const list = (values: readonly string[], max = 5) =>
  values.length > max
    ? `${values.slice(0, max).join("、")} 等 ${values.length} 项`
    : values.join("、");

/** Pure host-side classification; ties stay `unknown` rather than guess. */
export function classifyCheckFailure(
  scope: FailureScope,
): HostCheckFailureClass {
  const points = [...new Set(scope.points)];
  const modules = new Set(points.map(failureModule));
  const touches = (paths: readonly string[]) =>
    paths.some((path) => modules.has(failureModule(path)));
  const exact = (paths: readonly string[]) =>
    paths.some((path) => points.includes(path));
  const driftHits = scope.drift.filter((m) => touches(m.paths));
  const drift = (
    cards: typeof scope.drift,
    basis: string,
  ): HostCheckFailureClass => ({
    label: "baseline_drift",
    basis: clipBasis(basis),
    cards: [...new Set(cards.map((m) => m.card_id))].slice(0, MAX_REFS),
    commits: cards.map((m) => m.merge_sha).slice(0, MAX_REFS),
  });
  const driftText = (cards: typeof scope.drift) =>
    list(cards.map((m) => `${m.card_id}（${short(m.merge_sha)}）`));
  if (scope.passed_base && scope.drift.length) {
    const cards = driftHits.length ? driftHits : scope.drift;
    return drift(
      cards,
      `相同交付在基线 ${short(scope.passed_base)} 上通过，在 ${
        scope.base ? `基线 ${short(scope.base)}` : "当前基线"
      } 上失败；期间合入 ${driftText(cards)}${
        driftHits.length ? `，改动涉及失败模块 ${list([...modules])}` : ""
      }`,
    );
  }
  if (!points.length)
    return {
      label: "unknown",
      basis: "日志未定位到失败文件",
    };
  const ownHit = touches(scope.own);
  const where = `失败位置 ${list(points, 3)}`;
  if (driftHits.length && !ownHit)
    return drift(
      driftHits,
      `${where}；本卡未改动失败模块，期间合入的 ${driftText(driftHits)} 改过这些模块`,
    );
  if (ownHit && !driftHits.length)
    return {
      label: "genuine",
      basis: clipBasis(`${where}；失败模块在本卡改动范围内`),
    };
  if (ownHit) {
    const ownExact = exact(scope.own);
    const driftExact = driftHits.filter((m) => exact(m.paths));
    if (ownExact && !driftExact.length)
      return {
        label: "genuine",
        basis: clipBasis(`${where}；本卡改动了失败文件`),
      };
    if (driftExact.length && !ownExact)
      return drift(
        driftExact,
        `${where}；失败文件由期间合入的 ${driftText(driftExact)} 改动`,
      );
    return {
      label: "unknown",
      basis: clipBasis(
        `${where}；本卡和期间合入的 ${driftText(driftHits)} 都改动了失败模块`,
      ),
      cards: [...new Set(driftHits.map((m) => m.card_id))].slice(0, MAX_REFS),
      commits: driftHits.map((m) => m.merge_sha).slice(0, MAX_REFS),
    };
  }
  return {
    label: "unknown",
    basis: clipBasis(
      `${where}；失败模块不在本卡改动内，期间也没有合入改动它的卡`,
    ),
  };
}

/** Shape guard for host evidence; prose rules mirror the failure excerpt guard. */
export function validHostFailureClass(
  value: unknown,
  merged: (card: CardId, commit: string) => boolean,
): value is HostCheckFailureClass {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const v = value as Record<string, unknown>;
  if (
    !Object.keys(v).every((key) =>
      ["label", "basis", "cards", "commits"].includes(key),
    ) ||
    !["baseline_drift", "genuine", "unknown"].includes(v.label as string) ||
    typeof v.basis !== "string" ||
    !v.basis.trim() ||
    v.basis.length > FAILURE_BASIS_MAX ||
    /[\p{Cc}\p{Cf}]/u.test(v.basis)
  )
    return false;
  const cards = v.cards ?? [];
  const commits = v.commits ?? [];
  if (
    !Array.isArray(cards) ||
    !Array.isArray(commits) ||
    cards.length > MAX_REFS ||
    commits.length > MAX_REFS ||
    !cards.every((c) => typeof c === "string" && /^C-[1-9]\d*$/u.test(c)) ||
    !commits.every((c) => typeof c === "string" && fullSha.test(c))
  )
    return false;
  if (v.label === "genuine" && (cards.length || commits.length)) return false;
  if (v.label === "baseline_drift" && !cards.length) return false;
  // Every named commit must be a recorded merge of one of the named cards.
  return commits.every((commit) =>
    cards.some((card) => merged(card as CardId, commit as string)),
  );
}

/** The line written into the return reason and the fix Run prompt. */
export function failureClassLine(c: CheckFailureClass): string {
  return `失败分类：${c.label}（${CHECK_FAILURE_LABEL_TEXT[c.label]}）：${c.basis}`;
}
