import { createHash } from "node:crypto";
import type {
  ProjectId,
  Role,
  RoleDefinition,
  RoleOverlayRules,
  ToolName,
} from "@cardigan/domain";
import type {
  ReadRepositories,
  StoreTransactionContext,
} from "@cardigan/store";
import { deploymentRolePolicyHash, policyHasher } from "./role-policy-hash.js";

/**
 * C-613 (shared with C-603): the one trusted record of default-pack contents a
 * project role may have been built on. Only the system appends it, in the
 * project's own stream and on no card. Each entry is one role's full policy
 * hash (`deploymentRolePolicyHash`) and, when known, a compact content
 * fingerprint (paragraph hashes, not text). It is written for every deployed
 * pack, for each `role upgrade --from-default`, and for an older default this
 * module proves; existing pre-C-613 publication receipts seed hash-only entries.
 */
export const DEFAULTS_EVENT = "host_role_defaults_recorded";

export interface KnownContent {
  readonly paragraphs: readonly string[];
  readonly allowed_tools: readonly ToolName[];
  readonly capabilities: readonly string[];
  readonly kind: string;
  readonly worktree: string;
  readonly required_capabilities: readonly string[];
}
export interface KnownDefault {
  readonly policy_hash: string;
  /** Missing on a seed: only the hash is known, content must be proven. */
  readonly content?: KnownContent;
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
    content: {
      paragraphs: paragraphs(role.instructions ?? role.core_prompt ?? "").map(
        paragraphHash,
      ),
      allowed_tools: [...role.allowed_tools],
      capabilities: [...role.capabilities],
      kind: role.kind,
      worktree: role.worktree,
      required_capabilities: [...(role.required_capabilities ?? [])],
    },
  };
}

const trusted = (
  e: { card_id?: string; actor: { kind: string; project_id?: string } },
  project: ProjectId,
) =>
  e.card_id === undefined &&
  e.actor.kind === "system" &&
  e.actor.project_id === project;

/**
 * Oldest first, per role id; one entry per hash. Read from this project's
 * stream only. Seeds come from the `matched` entries of publication receipts
 * written before the first record: those receipts covered plain default roles
 * only, so a matched hash was that release's default.
 */
export function knownDefaults(
  tx: ReadRepositories,
  project: ProjectId,
): Map<string, KnownDefault[]> {
  const known = new Map<string, KnownDefault[]>();
  const add = (role_id: string, value: KnownDefault) => {
    const list = known.get(role_id) ?? [];
    const at = list.findIndex((k) => k.policy_hash === value.policy_hash);
    if (at < 0) known.set(role_id, [...list, value]);
    else if (!list[at]?.content && value.content)
      known.set(role_id, list.with(at, value));
  };
  let recorded = false;
  const stream = [...tx.events.listAfter(project, undefined, 0)].sort(
    (a, b) => a.seq - b.seq,
  );
  for (const e of stream) {
    if (!trusted(e, project)) continue;
    if (e.type === DEFAULTS_EVENT) {
      recorded = true;
      const p = e.payload as { role_id?: unknown; known?: KnownDefault };
      if (
        typeof p.role_id === "string" &&
        typeof p.known?.policy_hash === "string"
      )
        add(p.role_id, p.known);
    } else if (e.type === "host_role_pack_published" && !recorded) {
      const roles = (e.payload as { roles?: Record<string, unknown> }).roles;
      for (const [role_id, entry] of Object.entries(roles ?? {})) {
        const r = entry as { policy_hash?: unknown; disposition?: unknown };
        if (r?.disposition === "matched" && typeof r.policy_hash === "string")
          add(role_id, { policy_hash: r.policy_hash });
      }
    }
  }
  return known;
}

/** Append a default unless the record already holds it with content. */
export function rememberDefault(
  tx: StoreTransactionContext,
  project: ProjectId,
  known: Map<string, KnownDefault[]>,
  role_id: string,
  value: KnownDefault,
  source: "pack" | "proof" | "cli",
  at: string,
) {
  const list = known.get(role_id) ?? [];
  const index = list.findIndex((k) => k.policy_hash === value.policy_hash);
  const existing = list[index];
  if (existing && (existing.content || !value.content)) return;
  known.set(role_id, existing ? list.with(index, value) : [...list, value]);
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

/**
 * Read the version as `known + appended paragraphs + tool changes`, all
 * proven against that known default's own content. Undefined when a known
 * paragraph is missing or a policy field differs: neither can be expressed.
 */
export function rulesAgainstKnown(
  role: Role,
  known: KnownContent,
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

export interface OlderReading {
  readonly rules: RoleOverlayRules;
  /** The record the reading is based on. */
  readonly known: KnownDefault;
  /**
   * Every older default proven here from a hash-only record, chosen or not,
   * to be remembered with its content.
   */
  readonly proven: readonly RoleDefinition[];
}

/**
 * Step 3 of the C-613 provenance order: read the version as an older
 * recorded default plus project rules. `older` excludes this release's own
 * default. Every hash-only record is proven first (V-3073:2), so its content
 * counts like a content record. Content the current pack has anyway is no
 * project rule. Any other extra tool or paragraph must appear in no recorded
 * or proven default of the role, or it may be what a later pack withdrew.
 * Among all candidates the one with the fewest extra, appended and removed
 * items wins; a tie goes to the newer record, so a rerun of one release
 * reaches the same reading.
 */
export function readOnOlderDefault(
  role: Role,
  current: RoleDefinition,
  older: readonly KnownDefault[],
): OlderReading | undefined {
  const readings = older.map((known) => {
    if (known.content)
      return { known, content: known.content, rules: undefined };
    const proof = provePreviousDefault(role, current, known.policy_hash);
    return {
      known,
      content: proof && knownDefault(proof.previous).content,
      rules: proof?.rules,
      previous: proof?.previous,
    };
  });
  const proven = readings.flatMap((r) => (r.previous ? [r.previous] : []));
  const currentTools = new Set(current.allowed_tools);
  const currentParagraphs = new Set(
    paragraphs(current.instructions ?? "").map(paragraphHash),
  );
  const recordedTools = new Set(
    readings.flatMap((r) => r.content?.allowed_tools ?? []),
  );
  const recordedParagraphs = new Set(
    readings.flatMap((r) => r.content?.paragraphs ?? []),
  );
  const tidy = (rules: RoleOverlayRules): RoleOverlayRules | undefined => {
    const extra_tools = rules.extra_tools.filter((t) => !currentTools.has(t));
    const appended = paragraphs(rules.append_instructions).filter(
      (p) => !currentParagraphs.has(paragraphHash(p)),
    );
    if (
      extra_tools.some((t) => recordedTools.has(t)) ||
      appended.some((p) => recordedParagraphs.has(paragraphHash(p)))
    )
      return undefined;
    return {
      ...rules,
      append_instructions: appended.join("\n\n"),
      extra_tools,
    };
  };
  const score = (r: RoleOverlayRules) =>
    r.extra_tools.length +
    paragraphs(r.append_instructions).length +
    r.removed_tools.length;
  return readings
    .flatMap(({ known, content, rules }) => {
      const read = rules ?? (content && rulesAgainstKnown(role, content));
      const tidied = read && tidy(read);
      return tidied ? [{ rules: tidied, known, proven }] : [];
    })
    .reduce<OlderReading | undefined>(
      (chosen, next) =>
        chosen && score(chosen.rules) < score(next.rules) ? chosen : next,
      undefined,
    );
}

/** Upper bound of tool variants tried per text cut. */
const MAX_VARIANTS = 30_000;
/** Project text is appended; only the last boundaries are cut. */
const MAX_CUTS = 12;

/**
 * Find a recorded older default inside the version by its full policy hash: a text prefix plus the version's tools minus a few
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
  for (const cut of cuts) {
    const hash = policyHasher(text.slice(0, cut));
    for (const extra of extras) {
      const previous = {
        ...role,
        allowed_tools: role.allowed_tools.filter((t) => !extra.includes(t)),
      };
      if (hash(previous, true) !== previousHash) continue;
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

/** Record one default role as the trusted record holds it (CLI upgrades). */
export function recordDefault(
  tx: StoreTransactionContext,
  project: ProjectId,
  role_id: string,
  value: RoleDefinition,
  source: "pack" | "cli",
  at: string,
) {
  rememberDefault(
    tx,
    project,
    knownDefaults(tx, project),
    role_id,
    knownDefault(value),
    source,
    at,
  );
}
