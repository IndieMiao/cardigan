/**
 * C-592: the expected step shape of a GitHub merge-check job.
 *
 * The six check steps are always mandatory and unique. Everything else is an
 * infrastructure step: either an exact display name or a trusted
 * GitHub-generated name for an unnamed `uses:` step (`Run owner/repo@ref`,
 * cleanup `Post Run owner/repo@ref` with the same ref). Executors without a
 * configured contract keep Cardigan's own workflow shape.
 */
export interface GithubStepMatcherName {
  readonly name: string;
}
export interface GithubStepMatcherUses {
  /** `owner/repo` or `owner/repo/path` of the action, without `@ref`. */
  readonly uses: string;
}
export type GithubStepMatcher = GithubStepMatcherName | GithubStepMatcherUses;
export interface GithubStepContract {
  /** Main steps after `Set up job`, matched exactly and in order. */
  readonly steps: readonly GithubStepMatcher[];
  /** Cleanup steps before `Complete job`; ordered, each may be absent. */
  readonly postSteps: readonly GithubStepMatcher[];
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

function parseMatcher(raw: unknown, field: string): GithubStepMatcher {
  if (typeof raw === "string") {
    if (!validName(raw))
      fail(
        `${field} 的步骤名须为 1-${MAX_NAME_LENGTH} 个字符，不能含控制字符或首尾空白`,
      );
    return { name: raw };
  }
  if (
    !plainObject(raw) ||
    Object.keys(raw).length !== 1 ||
    !("uses" in raw) ||
    !validUses(raw.uses)
  )
    return fail(`${field} 的条目须为步骤名，或只含 uses: owner/repo 的对象`);
  return { uses: raw.uses as string };
}

/**
 * Parse `executors.<name>.step_contract` of merge-gate.yaml. Throws a
 * message that never echoes configured values.
 */
export function parseGithubStepContract(raw: unknown): GithubStepContract {
  const checkNames: readonly string[] = GITHUB_CHECK_NAMES;
  if (!plainObject(raw)) return fail("step_contract 必须是对象");
  if (Object.keys(raw).some((key) => !["steps", "post_steps"].includes(key)))
    fail("step_contract 只支持 steps 和 post_steps");
  if (
    !Array.isArray(raw.steps) ||
    raw.steps.length === 0 ||
    raw.steps.length > MAX_CONTRACT_STEPS
  )
    fail(`step_contract.steps 须为 1-${MAX_CONTRACT_STEPS} 项的列表`);
  // Only an omitted list defaults to empty; an explicit null is a typo.
  const postRaw = raw.post_steps === undefined ? [] : raw.post_steps;
  if (!Array.isArray(postRaw) || postRaw.length > MAX_CONTRACT_POST_STEPS)
    fail(
      `step_contract.post_steps 须为不超过 ${MAX_CONTRACT_POST_STEPS} 项的列表`,
    );
  const steps = (raw.steps as unknown[]).map((entry) =>
    parseMatcher(entry, "step_contract.steps"),
  );
  const postSteps = (postRaw as unknown[]).map((entry) =>
    parseMatcher(entry, "step_contract.post_steps"),
  );
  const reserved = [GITHUB_SETUP_STEP, GITHUB_COMPLETE_STEP];
  const names = new Set<string>();
  const uses = new Set<string>();
  for (const step of steps) {
    if ("name" in step) {
      if (reserved.includes(step.name) || step.name.startsWith("Post "))
        fail(
          "step_contract.steps 不能声明 Set up job、Complete job 或 Post 开头的步骤",
        );
      if (names.has(step.name)) fail("step_contract.steps 的步骤名不能重复");
      names.add(step.name);
    } else {
      if (uses.has(step.uses))
        fail("step_contract.steps 的同一 uses 只能出现一次");
      uses.add(step.uses);
    }
  }
  for (const check of checkNames)
    if (!names.has(check))
      fail(`step_contract.steps 必须各含一次检查步骤 ${checkNames.join("/")}`);
  // An exact name must never denote the same display name as a declared
  // `uses` step or its cleanup, otherwise one step could be declared twice.
  const generated = (name: string) =>
    [...uses].some(
      (action) =>
        name.startsWith(`Run ${action}@`) ||
        name.startsWith(`Post Run ${action}@`),
    );
  if ([...names].some(generated))
    fail("step_contract.steps 的步骤名不能与 uses 步骤的生成名重复");
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
          "step_contract.post_steps 不能声明检查步骤、主步骤或 Set up job/Complete job",
        );
      if (generated(step.name))
        fail("step_contract.post_steps 的步骤名不能与 uses 步骤的生成名重复");
      if (postNames.has(step.name))
        fail("step_contract.post_steps 的步骤名不能重复");
      postNames.add(step.name);
    } else {
      if (!uses.has(step.uses))
        fail("step_contract.post_steps 的 uses 必须对应 steps 中的 uses");
      if (postUses.has(step.uses))
        fail("step_contract.post_steps 的同一 uses 只能出现一次");
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

/**
 * True when `names` (already stripped of `Set up job`/`Complete job`) is
 * exactly the contract's main steps followed by an ordered subset of its
 * post steps. A `uses` post step must carry the same ref as its main step.
 * Every display name may occur only once, whatever matched it.
 */
export function matchesGithubStepContract(
  names: readonly string[],
  contract: GithubStepContract,
): boolean {
  if (
    names.length < contract.steps.length ||
    new Set(names).size !== names.length
  )
    return false;
  const refs = new Map<string, string>();
  for (const [index, matcher] of contract.steps.entries()) {
    const name = names[index] ?? "";
    if ("name" in matcher) {
      if (name !== matcher.name) return false;
      continue;
    }
    const ref = generatedRef(name, `Run ${matcher.uses}@`);
    if (ref === undefined) return false;
    refs.set(matcher.uses, ref);
  }
  let next = 0;
  for (const name of names.slice(contract.steps.length)) {
    let found = false;
    while (next < contract.postSteps.length && !found) {
      const matcher = contract.postSteps[next++];
      if (!matcher) break;
      found =
        "name" in matcher
          ? name === matcher.name
          : name === `Post Run ${matcher.uses}@${refs.get(matcher.uses)}`;
    }
    if (!found) return false;
  }
  return true;
}
