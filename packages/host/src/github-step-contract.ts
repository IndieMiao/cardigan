import { validPushBranch } from "./merge-push-config.js";

/**
 * C-592: the expected step shape of a GitHub merge-check job.
 *
 * The six check steps are always mandatory and unique. Everything else is an
 * infrastructure step: either an exact display name or a trusted
 * GitHub-generated name for an unnamed `uses:` step (`Run owner/repo@ref`,
 * cleanup `Post Run owner/repo@ref` with the same ref). Executors without a
 * configured contract keep Cardigan's own workflow shape.
 *
 * C-661: one executor may serve several baselines whose workflows differ.
 * `branches` overrides the shape per baseline branch (the run's verified
 * `head_branch`), and an infrastructure main step may be declared optional.
 */
export interface GithubStepMatcherName {
  readonly name: string;
  /** C-661: may be absent; when present it must be at its declared place. */
  readonly optional?: true;
}
export interface GithubStepMatcherUses {
  /** `owner/repo` or `owner/repo/path` of the action, without `@ref`. */
  readonly uses: string;
  readonly optional?: true;
}
export type GithubStepMatcher = GithubStepMatcherName | GithubStepMatcherUses;
export interface GithubStepShape {
  /** Main steps after `Set up job`, matched exactly and in order. */
  readonly steps: readonly GithubStepMatcher[];
  /** Cleanup steps before `Complete job`; ordered, each may be absent. */
  readonly postSteps: readonly GithubStepMatcher[];
}
export interface GithubStepContract extends GithubStepShape {
  /** C-661: baseline branch -> its own complete shape, replacing the default. */
  readonly branches?: ReadonlyMap<string, GithubStepShape>;
}

export const GITHUB_CHECK_NAMES = [
  "install",
  "build",
  "test",
  "lint",
  "deps",
  "e2e",
] as const;
export const GITHUB_SETUP_STEP = "Set up job";
export const GITHUB_COMPLETE_STEP = "Complete job";
export const MAX_CONTRACT_STEPS = 64;
export const MAX_CONTRACT_POST_STEPS = 32;
export const MAX_CONTRACT_BRANCHES = 16;
const MAX_NAME_LENGTH = 200;
const USES = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u;
/** Tag, branch or commit; GitHub prints it verbatim after `@`. */
const REF = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u;
const MAX_REF_LENGTH = 100;

const fail = (message: string): never => {
  throw new Error(message);
};
const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_NAME_LENGTH &&
  value.trim() === value &&
  !/[\p{Cc}\p{Cf}]/u.test(value);
const validUses = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= MAX_NAME_LENGTH &&
  USES.test(value) &&
  !value.split("/").some((part) => part === "." || part === "..");

function parseMatcher(
  raw: unknown,
  field: string,
  allowOptional: boolean,
): GithubStepMatcher {
  const nameError = () =>
    fail(
      `${field} 的步骤名须为 1-${MAX_NAME_LENGTH} 个字符，不能含控制字符或首尾空白`,
    );
  if (typeof raw === "string") {
    if (!validName(raw)) nameError();
    return { name: raw };
  }
  const keys = plainObject(raw) ? Object.keys(raw) : [];
  const kind = keys.filter((key) => key === "name" || key === "uses");
  if (
    !plainObject(raw) ||
    kind.length !== 1 ||
    keys.some((key) => !["name", "uses", "optional"].includes(key))
  )
    return fail(
      `${field} 的条目须为步骤名，或只含 name 或 uses: owner/repo（可加 optional: true）的对象`,
    );
  if ("optional" in raw && (!allowOptional || raw.optional !== true))
    fail(
      allowOptional
        ? `${field} 的 optional 只能写 true`
        : `${field} 本身每项可缺省，不支持 optional`,
    );
  const optional = raw.optional === true ? ({ optional: true } as const) : {};
  if (kind[0] === "name") {
    if (!validName(raw.name)) nameError();
    return { name: raw.name as string, ...optional };
  }
  if (!validUses(raw.uses))
    fail(`${field} 的 uses 须为 owner/repo 或 owner/repo/path，不带 @ref`);
  return { uses: raw.uses as string, ...optional };
}

/**
 * Parse `executors.<name>.step_contract` of merge-gate.yaml. Throws a
 * message that never echoes configured values.
 */
export function parseGithubStepContract(raw: unknown): GithubStepContract {
  if (!plainObject(raw)) return fail("step_contract 必须是对象");
  if (
    Object.keys(raw).some(
      (key) => !["steps", "post_steps", "branches"].includes(key),
    )
  )
    fail("step_contract 只支持 steps、post_steps 和 branches");
  const shape = parseShape(raw, "step_contract");
  if (raw.branches === undefined) return shape;
  const entries = plainObject(raw.branches) ? Object.entries(raw.branches) : [];
  if (
    !plainObject(raw.branches) ||
    entries.length === 0 ||
    entries.length > MAX_CONTRACT_BRANCHES
  )
    fail(
      `step_contract.branches 须为 1-${MAX_CONTRACT_BRANCHES} 个基线分支到步骤合同的映射`,
    );
  const branches = new Map<string, GithubStepShape>();
  for (const [branch, entry] of entries) {
    if (!validPushBranch(branch) || branch.startsWith("ci/"))
      fail("step_contract.branches 的键须为有效的基线分支名");
    if (!plainObject(entry)) fail("step_contract.branches 的每一项必须是对象");
    if (
      Object.keys(entry as object).some(
        (key) => !["steps", "post_steps"].includes(key),
      )
    )
      fail("step_contract.branches 的每一项只支持 steps 和 post_steps");
    branches.set(
      branch,
      parseShape(entry as Record<string, unknown>, "step_contract.branches"),
    );
  }
  return { ...shape, branches };
}

/** C-661: the shape that applies to a run on `branch` (its verified baseline). */
export function githubStepShape(
  contract: GithubStepContract,
  branch: string | undefined,
): GithubStepShape {
  return (
    (branch === undefined ? undefined : contract.branches?.get(branch)) ??
    contract
  );
}

function parseShape(
  raw: Record<string, unknown>,
  field: string,
): GithubStepShape {
  const checkNames: readonly string[] = GITHUB_CHECK_NAMES;
  if (
    !Array.isArray(raw.steps) ||
    raw.steps.length === 0 ||
    raw.steps.length > MAX_CONTRACT_STEPS
  )
    fail(`${field}.steps 须为 1-${MAX_CONTRACT_STEPS} 项的列表`);
  // Only an omitted list defaults to empty; an explicit null is a typo.
  const postRaw = raw.post_steps === undefined ? [] : raw.post_steps;
  if (!Array.isArray(postRaw) || postRaw.length > MAX_CONTRACT_POST_STEPS)
    fail(`${field}.post_steps 须为不超过 ${MAX_CONTRACT_POST_STEPS} 项的列表`);
  const steps = (raw.steps as unknown[]).map((entry) =>
    parseMatcher(entry, `${field}.steps`, true),
  );
  const postSteps = (postRaw as unknown[]).map((entry) =>
    parseMatcher(entry, `${field}.post_steps`, false),
  );
  const reserved = [GITHUB_SETUP_STEP, GITHUB_COMPLETE_STEP];
  const names = new Set<string>();
  const uses = new Set<string>();
  for (const step of steps) {
    if ("name" in step) {
      if (reserved.includes(step.name) || step.name.startsWith("Post "))
        fail(
          `${field}.steps 不能声明 Set up job、Complete job 或 Post 开头的步骤`,
        );
      if (names.has(step.name)) fail(`${field}.steps 的步骤名不能重复`);
      names.add(step.name);
    } else {
      if (uses.has(step.uses)) fail(`${field}.steps 的同一 uses 只能出现一次`);
      uses.add(step.uses);
    }
  }
  for (const check of checkNames)
    if (!names.has(check))
      fail(`${field}.steps 必须各含一次检查步骤 ${checkNames.join("/")}`);
  // The six checks stay mandatory; only infrastructure steps may be optional.
  if (
    steps.some(
      (step) =>
        step.optional && "name" in step && checkNames.includes(step.name),
    )
  )
    fail(`${field}.steps 的检查步骤不能设为 optional`);
  // An exact name must never denote the same display name as a declared
  // `uses` step or its cleanup, otherwise one step could be declared twice.
  const generated = (name: string) =>
    [...uses].some(
      (action) =>
        name.startsWith(`Run ${action}@`) ||
        name.startsWith(`Post Run ${action}@`),
    );
  if ([...names].some(generated))
    fail(`${field}.steps 的步骤名不能与 uses 步骤的生成名重复`);
  const postNames = new Set<string>();
  const postUses = new Set<string>();
  for (const step of postSteps) {
    if ("name" in step) {
      if (
        reserved.includes(step.name) ||
        checkNames.includes(step.name) ||
        names.has(step.name)
      )
        fail(
          `${field}.post_steps 不能声明检查步骤、主步骤或 Set up job/Complete job`,
        );
      if (generated(step.name))
        fail(`${field}.post_steps 的步骤名不能与 uses 步骤的生成名重复`);
      if (postNames.has(step.name))
        fail(`${field}.post_steps 的步骤名不能重复`);
      postNames.add(step.name);
    } else {
      if (!uses.has(step.uses))
        fail(`${field}.post_steps 的 uses 必须对应 steps 中的 uses`);
      if (postUses.has(step.uses))
        fail(`${field}.post_steps 的同一 uses 只能出现一次`);
      postUses.add(step.uses);
    }
  }
  return { steps, postSteps };
}

/** Ref of a GitHub-generated `Run owner/repo@ref` name, if it matches. */
function generatedRef(name: string, prefix: string): string | undefined {
  if (!name.startsWith(prefix)) return undefined;
  const ref = name.slice(prefix.length);
  return ref.length <= MAX_REF_LENGTH && REF.test(ref) ? ref : undefined;
}

/** Displayable name of a matcher, for diagnostics only. */
export function describeGithubStepMatcher(matcher: GithubStepMatcher): string {
  const base = "name" in matcher ? matcher.name : `Run ${matcher.uses}@<ref>`;
  return matcher.optional ? `${base}（可选）` : base;
}

/** C-661: why `names` does not match, at the first differing position. */
export type GithubStepComparison =
  | { readonly ok: true; readonly mainSteps: number }
  | {
      readonly ok: false;
      /** 0-based position in `names`. */
      readonly index: number;
      readonly expected: string;
      readonly actual: string | undefined;
    };

/**
 * Compare `names` (already stripped of `Set up job`/`Complete job`) with the
 * shape: its main steps in order (optional ones may be absent) followed by an
 * ordered subset of its post steps. A `uses` post step must carry the same
 * ref as its main step. Every display name may occur only once, whatever
 * matched it. Each display name matches at most one matcher of a validated
 * shape, so greedy matching is exact.
 */
export function compareGithubStepContract(
  names: readonly string[],
  contract: GithubStepShape,
): GithubStepComparison {
  const seen = new Set<string>();
  for (const [index, name] of names.entries()) {
    if (seen.has(name))
      return { ok: false, index, expected: "不重复的步骤名", actual: name };
    seen.add(name);
  }
  const refs = new Map<string, string>();
  let index = 0;
  for (const matcher of contract.steps) {
    const name = names[index];
    if ("name" in matcher) {
      if (name === matcher.name) {
        index++;
        continue;
      }
    } else {
      const ref =
        name === undefined
          ? undefined
          : generatedRef(name, `Run ${matcher.uses}@`);
      if (ref !== undefined) {
        refs.set(matcher.uses, ref);
        index++;
        continue;
      }
    }
    if (matcher.optional) continue;
    return {
      ok: false,
      index,
      expected: describeGithubStepMatcher(matcher),
      actual: name,
    };
  }
  const mainSteps = index;
  let next = 0;
  for (; index < names.length; index++) {
    const name = names[index];
    const remaining = contract.postSteps.slice(next);
    let found = false;
    while (next < contract.postSteps.length && !found) {
      const matcher = contract.postSteps[next++];
      if (!matcher) break;
      if ("name" in matcher) found = name === matcher.name;
      else {
        // An absent optional main step has no ref and no cleanup step.
        const ref = refs.get(matcher.uses);
        found = ref !== undefined && name === `Post Run ${matcher.uses}@${ref}`;
      }
    }
    if (!found)
      return {
        ok: false,
        index,
        expected: remaining.length
          ? `收尾步骤（按序，可缺省）${remaining
              .map((matcher) =>
                "name" in matcher
                  ? matcher.name
                  : `Post Run ${matcher.uses}@${refs.get(matcher.uses) ?? "<ref>"}`,
              )
              .join("、")}`
          : "没有更多步骤",
        actual: name,
      };
  }
  return { ok: true, mainSteps };
}

/** True when `names` matches the shape; see `compareGithubStepContract`. */
export function matchesGithubStepContract(
  names: readonly string[],
  contract: GithubStepShape,
): boolean {
  return compareGithubStepContract(names, contract).ok;
}
