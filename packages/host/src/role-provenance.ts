import { createHash } from "node:crypto";
import type {
  ProjectId,
  Role,
  RoleDefinition,
  RoleOverlayRules,
  ToolName,
} from "@cardigan/domain";
import type { StoreTransactionContext } from "@cardigan/store";
import {
  deploymentRolePolicyHash,
  policyHasher,
  weakRolePolicyHash,
} from "./role-policy-hash.js";

/**
 * C-613: which default-pack contents a project role may have been built on.
 * Every deployed pack, and every older default proven by the supervisor's
 * exact fingerprint, is remembered compactly (paragraph hashes, not text), so
 * a later deployment, or a retry after a deferral, still tells project rules
 * from content an earlier pack had.
 */
export const DEFAULTS_EVENT = "host_role_defaults_recorded";

export interface KnownDefault {
  readonly policy_hash: string;
  readonly paragraphs: readonly string[];
  readonly allowed_tools: readonly ToolName[];
  readonly capabilities: readonly string[];
  readonly kind: string;
  readonly worktree: string;
  readonly required_capabilities: readonly string[];
}

export const paragraphs = (text: string) =>
  text
    .split(/\n[ \t]*\n/u)
    .map((p) => p.trim())
    .filter(Boolean);
export const paragraphHash = (p: string) =>
  createHash("sha256").update(p).digest("hex").slice(0, 24);

export function knownDefault(role: RoleDefinition): KnownDefault {
  return {
    policy_hash: deploymentRolePolicyHash(role),
    paragraphs: paragraphs(role.instructions ?? role.core_prompt ?? "").map(
      paragraphHash,
    ),
    allowed_tools: [...role.allowed_tools],
    capabilities: [...role.capabilities],
    kind: role.kind,
    worktree: role.worktree,
    required_capabilities: [...(role.required_capabilities ?? [])],
  };
}

/** Newest first, per role id. */
export function knownDefaults(
  tx: StoreTransactionContext,
  project: ProjectId,
): Map<string, KnownDefault[]> {
  const known = new Map<string, KnownDefault[]>();
  for (const e of tx.events.listAfter(project, undefined, 0)) {
    if (
      e.type !== DEFAULTS_EVENT ||
      e.card_id !== undefined ||
      e.actor.kind !== "system"
    )
      continue;
    const p = e.payload as { role_id?: string; known?: KnownDefault };
    if (!p.role_id || !p.known) continue;
    known.set(p.role_id, [p.known, ...(known.get(p.role_id) ?? [])]);
  }
  return known;
}

export function rememberDefault(
  tx: StoreTransactionContext,
  project: ProjectId,
  known: Map<string, KnownDefault[]>,
  role_id: string,
  value: KnownDefault,
  source: "pack" | "proof",
  at: string,
) {
  const list = known.get(role_id) ?? [];
  if (list.some((k) => k.policy_hash === value.policy_hash)) return;
  known.set(role_id, [value, ...list]);
  tx.events.append(project, {
    id: tx.ids.nextEventId(),
    seq: tx.ids.nextEventSequence(project),
    type: DEFAULTS_EVENT,
    actor: { kind: "system", project_id: project },
    created_at: at,
    payload: JSON.parse(JSON.stringify({ role_id, source, known: value })),
  });
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  [...new Set(a)].sort().join("\n") === [...new Set(b)].sort().join("\n");

/** Whether the version is exactly an older default (strongly or weakly proven). */
export function isOlderDefault(
  role: Role,
  current: RoleDefinition,
  older: readonly KnownDefault[],
  previousHash: string | undefined,
) {
  const hash = deploymentRolePolicyHash(role);
  if (older.some((k) => k.policy_hash === hash) || previousHash === hash)
    return true;
  // An older supervisor hashed without machine requirements; trust it only
  // when the requirements are the default's, so none can be lost.
  return (
    previousHash !== undefined &&
    previousHash === weakRolePolicyHash(role) &&
    sameSet(
      role.required_capabilities ?? [],
      current.required_capabilities ?? [],
    )
  );
}

/**
 * Read the version as `known + appended paragraphs + tool changes`, all
 * proven against that known default's own content. Undefined when a known
 * paragraph is missing or a policy field differs: neither can be expressed.
 */
export function rulesAgainstKnown(
  role: Role,
  known: KnownDefault,
): RoleOverlayRules | undefined {
  const text = role.instructions;
  if (
    text === undefined ||
    role.kind !== known.kind ||
    role.worktree !== known.worktree ||
    !sameSet(role.capabilities, known.capabilities) ||
    !sameSet(role.required_capabilities ?? [], known.required_capabilities)
  )
    return undefined;
  const unused = [...known.paragraphs];
  const extra: string[] = [];
  for (const part of paragraphs(text)) {
    const at = unused.indexOf(paragraphHash(part));
    if (at >= 0) unused.splice(at, 1);
    else extra.push(part);
  }
  if (unused.length) return undefined;
  const derived = new Set<ToolName>(
    role.allowed_tools.includes("submit_review") ? ["withdraw_review"] : [],
  );
  return {
    base_role_id: role.role_id,
    append_instructions: extra.join("\n\n"),
    extra_tools: [...new Set(role.allowed_tools)].filter(
      (t) => !known.allowed_tools.includes(t) && !derived.has(t),
    ),
    removed_tools: known.allowed_tools.filter(
      (t) => !role.allowed_tools.includes(t) && !derived.has(t),
    ),
  };
}

/** Upper bound of tool variants tried per text cut. */
const MAX_VARIANTS = 30_000;
/** Project text is appended; only the last boundaries are cut. */
const MAX_CUTS = 12;

/**
 * Find the previously deployed default inside the version by its exact
 * supervisor fingerprint: a text prefix plus the version's tools minus a few
 * project additions (any tool the new pack lacks, and up to two it has).
 */
export function provePreviousDefault(
  role: Role,
  current: RoleDefinition,
  previousHash: string,
):
  | { readonly rules: RoleOverlayRules; readonly previous: RoleDefinition }
  | undefined {
  const text = role.instructions;
  if (text === undefined) return undefined;
  const currentTools = new Set(current.allowed_tools);
  const tools = [...new Set(role.allowed_tools)];
  const outside = tools.filter(
    (t) => t === "withdraw_review" || !currentTools.has(t),
  );
  const inside = tools.filter(
    (t) => t !== "withdraw_review" && currentTools.has(t),
  );
  if (2 ** outside.length > MAX_VARIANTS) return undefined;
  const all = Array.from({ length: 2 ** outside.length }, (_, bits) =>
    outside.filter((_, i) => bits & (1 << i)),
  );
  // At most two pre-added tools that the new pack also has.
  const few: ToolName[][] = [[]];
  for (const [i, a] of inside.entries()) {
    few.push([a]);
    if (all.length * inside.length * inside.length <= MAX_VARIANTS)
      for (const b of inside.slice(i + 1)) few.push([a, b]);
  }
  const extras = all.flatMap((a) => few.map((b) => [...a, ...b]));
  extras.sort((a, b) => a.length - b.length);
  const boundaries = [...text.matchAll(/\n[ \t]*\n/gu)].map((m) => m.index);
  const cuts = [text.length, ...boundaries.reverse().slice(0, MAX_CUTS)];
  const weakOk = sameSet(
    role.required_capabilities ?? [],
    current.required_capabilities ?? [],
  );
  for (const cut of cuts) {
    const hash = policyHasher(text.slice(0, cut));
    for (const extra of extras) {
      const previous = {
        ...role,
        allowed_tools: role.allowed_tools.filter((t) => !extra.includes(t)),
      };
      if (
        hash(previous, true) !== previousHash &&
        !(weakOk && hash(previous, false) === previousHash)
      )
        continue;
      return {
        rules: {
          base_role_id: role.role_id,
          append_instructions: text.slice(cut).trim(),
          // withdraw_review is derived again from submit_review.
          extra_tools: extra.filter((t) => t !== "withdraw_review"),
          removed_tools: [],
        },
        previous: { ...previous, instructions: text.slice(0, cut) },
      };
    }
  }
  return undefined;
}
