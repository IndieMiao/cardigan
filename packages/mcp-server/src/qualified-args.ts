import {
  describeQualifiedInputError,
  type ProjectId,
  qualifiedInputProject,
  splitQualifiedInput,
} from "@cardigan/domain";

/**
 * C-675: argument keys that hold project-scoped numbers. Anything ending in
 * `id` / `ids` (`card_id`, `attach_to.id`, `numeric_decision_ids`) plus the
 * list fields named after what they hold. Text fields (`body`, `summary`,
 * `reason`, …) are never read, so a full number written there stays text.
 */
const ID_KEY = /(?:^|_)ids?$/u;
const ID_LISTS = new Set([
  "affected_cards",
  "affected_work_items",
  "attachments",
  "basis",
  "blocked_work_items",
  "depends_on",
  "depends_on_cards",
  "mentions",
  "related_cards",
  "reply_to",
  "requested_verifiers",
  "superseded_by",
  "supersedes",
]);

const isIdKey = (key: string) => ID_KEY.test(key) || ID_LISTS.has(key);

/** Every string value under an id key, in any nesting. */
function idValues(value: unknown, underIdKey: boolean, out: string[]): void {
  if (typeof value === "string") {
    if (underIdKey) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) idValues(item, underIdKey, out);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value))
      idValues(item, isIdKey(key), out);
  }
}

function rewrite(value: unknown, underIdKey: boolean): unknown {
  if (typeof value === "string")
    return underIdKey ? (splitQualifiedInput(value)?.id ?? value) : value;
  if (Array.isArray(value))
    return value.map((item) => rewrite(item, underIdKey));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        rewrite(item, isIdKey(key)),
      ]),
    );
  return value;
}

/**
 * Tool arguments with full numbers of the token's own project (`CDG-C-34`)
 * rewritten to short ones. A token only ever acts in its own project, so a
 * full number of any other code is refused rather than read elsewhere.
 * Short numbers already resolve in the token's project.
 */
export function resolveQualifiedToolArgs(
  args: Record<string, unknown>,
  project: {
    readonly id: ProjectId;
    /** Read only when an argument is a full number. */
    readonly code: () => string | null | undefined;
  },
):
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly error: { readonly code: "validation_failed"; message: string };
    } {
  const values: string[] = [];
  idValues(args, false, values);
  if (!values.some((value) => splitQualifiedInput(value) !== undefined))
    return { ok: true, value: args };
  const code = project.code();
  const resolved = qualifiedInputProject(
    values,
    // Only the own code is known here; another code is reported as not
    // being this project's, without looking up whose it is.
    (value) => (value === code ? project.id : undefined),
  );
  if (!resolved.ok) {
    const error = resolved.error;
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message:
          error.kind === "unknown_code"
            ? `完整编号 ${error.qualified} 不属于本会话的项目 ${project.id}${code ? `（${code}）` : ""}；只能操作本项目的编号`
            : describeQualifiedInputError(error),
      },
    };
  }
  return { ok: true, value: rewrite(args, false) as Record<string, unknown> };
}
