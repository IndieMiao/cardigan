import type { Reference } from "./entities.js";
import type { Result } from "./errors.js";
import { parseId, parseTimelineEntryId } from "./ids.js";

/**
 * C-674: every project registers a 3–4 character code (uppercase letters and
 * digits, starting with a letter). Storage keeps project-scoped numbers; the
 * full number `SEN-C-34` is only a display and reference form. Global ids
 * (`E-n` employees, `M-n` members) never get a prefix.
 */
export const PROJECT_CODE_PATTERN = /^[A-Z][A-Z0-9]{2,3}$/u;

export function isProjectCode(value: unknown): value is string {
  return typeof value === "string" && PROJECT_CODE_PATTERN.test(value);
}

/** Format and global uniqueness; `taken` holds the codes already registered. */
export function validateProjectCode(
  value: unknown,
  taken: Iterable<string>,
): Result<string> {
  if (!isProjectCode(value))
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message:
          "项目代号须为 3–4 位大写字母或数字，首位是大写字母（^[A-Z][A-Z0-9]{2,3}$）",
        details: { code: value },
      },
    };
  if (new Set(taken).has(value))
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message: `项目代号 ${value} 已被其它项目使用`,
        details: { code: value },
      },
    };
  return { ok: true, value };
}

const DIGITS = "123456789";
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Suggested code for a new project: the first three letters/digits of its
 * name (or id); when that is taken, a four-character code that keeps the
 * same three-character stem. Always returns a free, valid code.
 */
export function suggestProjectCode(
  name: string,
  taken: Iterable<string>,
): string {
  const used = new Set(taken);
  const chars = Array.from(name.toUpperCase()).filter((c) =>
    /[A-Z0-9]/u.test(c),
  );
  while (chars.length && !/[A-Z]/u.test(chars[0] as string)) chars.shift();
  const source = chars.length ? chars : ["P", "R", "J"];
  while (source.length < 3) source.push("X");
  const stem = source.slice(0, 3).join("");
  if (!used.has(stem)) return stem;
  const fourth = [...new Set([...source.slice(3), ...DIGITS, ...LETTERS])];
  for (const c of fourth) if (!used.has(stem + c)) return stem + c;
  // Every stem+X is taken (36 projects with one stem): keep the first letter.
  for (const a of [...LETTERS, ...DIGITS])
    for (const b of [...LETTERS, ...DIGITS])
      for (const c of [...LETTERS, ...DIGITS]) {
        const code = `${stem[0]}${a}${b}${c}`;
        if (!used.has(code)) return code;
      }
  throw new Error("No free project code");
}

/** Project-scoped numbers that get the code prefix in their full form. */
const LOCAL_ID =
  /^(?:C-[1-9][0-9]*(?:#[1-9][0-9]*)?|(?:MB|[QHAWDVR])-[1-9][0-9]*)$/u;

/** `CDG-C-34` for `C-34`; global or unrecognized ids and missing codes stay as they are. */
export function qualifyId(code: string | null | undefined, id: string): string {
  return code && isProjectCode(code) && LOCAL_ID.test(id)
    ? `${code}-${id}`
    : id;
}

/** `SEN-C-34` → `{ code: "SEN", id: "C-34" }`; anything else is undefined. */
export function splitQualifiedId(
  value: string,
): { readonly code: string; readonly id: string } | undefined {
  const match = /^([A-Z][A-Z0-9]{2,3})-(.+)$/u.exec(value);
  if (!match || !LOCAL_ID.test(match[2] as string)) return undefined;
  return { code: match[1] as string, id: match[2] as string };
}

const KINDS = {
  C: "card",
  W: "work_item",
  D: "delivery",
  A: "assignment",
  R: "run",
  V: "review",
  Q: "decision",
  H: "human_action",
} as const;

export type QualifiedReference = Exclude<Reference, { kind: "pr" }> & {
  /** The full number as written, e.g. `SEN-C-34#12`. */
  readonly qualified: string;
  readonly code: string;
};

/**
 * Full numbers mentioned in a body (`SEN-C-34`, `CDG-Q-12`, `SEN-C-34#5`).
 * Short numbers are left to `extractReferences`, which already refuses a
 * number glued to a preceding `-`, so `SEN-C-34` never resolves locally.
 */
export function extractQualifiedReferences(
  body: string,
): readonly QualifiedReference[] {
  const refs = new Map<string, QualifiedReference>();
  for (const [token, code, local] of body.matchAll(
    /(?<![A-Za-z0-9_-])([A-Z][A-Z0-9]{2,3})-(C-[1-9][0-9]*(?:#[1-9][0-9]*)?|[WDARVQH]-[1-9][0-9]*)(?![A-Za-z0-9_#])/gu,
  )) {
    if (!code || !local) continue;
    if (local.includes("#")) {
      const parsed = parseTimelineEntryId(local);
      if (parsed.ok)
        refs.set(token, {
          kind: "timeline_entry",
          id: parsed.value.id,
          qualified: token,
          code,
        });
      continue;
    }
    const kind = KINDS[local[0] as keyof typeof KINDS];
    const parsed = parseId(kind, local);
    if (parsed.ok)
      refs.set(token, {
        kind,
        id: parsed.value.id,
        qualified: token,
        code,
      } as QualifiedReference);
  }
  return [...refs.values()];
}

/**
 * C-675 input side: the project-scoped numbers a command or tool argument
 * may carry, attachments (`attachment-12`) included. Global ids (`E-n`,
 * `M-n`) are not here, so `CDG-E-5` is never taken for a full number.
 */
const INPUT_LOCAL_ID =
  /^(?:C-[1-9][0-9]*(?:#[1-9][0-9]*)?|(?:MB|[QHAWDVR])-[1-9][0-9]*|attachment-[1-9][0-9]*)$/u;

/** The kind of a project-scoped number as typed (`C-34`, `C-34#2`, `attachment-3`). */
export type LocalInputKind =
  | (typeof KINDS)[keyof typeof KINDS]
  | "timeline_entry"
  | "merge_batch"
  | "attachment";

/** `C-34` → `card`; anything that is not a project-scoped number is undefined. */
export function localInputKind(value: string): LocalInputKind | undefined {
  if (!INPUT_LOCAL_ID.test(value)) return undefined;
  if (value.startsWith("attachment-")) return "attachment";
  if (value.startsWith("MB-")) return "merge_batch";
  if (value.includes("#")) return "timeline_entry";
  return KINDS[value[0] as keyof typeof KINDS];
}

/**
 * `SEN-C-34` / `SEN-C-34#12` / `SEN-attachment-3` → `{ code, id }` for an
 * argument; anything else (short numbers, global ids, text) is undefined.
 */
export function splitQualifiedInput(
  value: string,
): { readonly code: string; readonly id: string } | undefined {
  const match = /^([A-Z][A-Z0-9]{2,3})-(.+)$/u.exec(value);
  if (!match || !INPUT_LOCAL_ID.test(match[2] as string)) return undefined;
  return { code: match[1] as string, id: match[2] as string };
}

/** Where a full number given as input belongs, as the caller can tell. */
export type QualifiedInputError =
  | {
      readonly kind: "unknown_code";
      readonly qualified: string;
      readonly code: string;
    }
  | {
      readonly kind: "mixed_projects";
      readonly qualified: readonly string[];
    }
  | {
      readonly kind: "project_mismatch";
      readonly qualified: string;
      readonly project_id: string;
      readonly requested: string;
    };

/**
 * Resolve the full numbers among `values` to one project. `projectOf` maps
 * a code to its project id (undefined for an unknown code); `requested` is
 * an explicit project the caller named, which must agree. Returns the
 * project the full numbers name, or undefined when there are none.
 */
export function qualifiedInputProject(
  values: readonly string[],
  projectOf: (code: string) => string | undefined,
  requested?: string,
):
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false; readonly error: QualifiedInputError } {
  let project: string | undefined;
  let first: string | undefined;
  for (const value of values) {
    const split = splitQualifiedInput(value);
    if (split === undefined) continue;
    const owner = projectOf(split.code);
    if (owner === undefined)
      return {
        ok: false,
        error: { kind: "unknown_code", qualified: value, code: split.code },
      };
    if (requested !== undefined && owner !== requested)
      return {
        ok: false,
        error: {
          kind: "project_mismatch",
          qualified: value,
          project_id: owner,
          requested,
        },
      };
    if (project !== undefined && owner !== project)
      return {
        ok: false,
        error: { kind: "mixed_projects", qualified: [first as string, value] },
      };
    project ??= owner;
    first ??= value;
  }
  return { ok: true, value: project };
}

/** One line for a `qualifiedInputProject` refusal; `requested` names the explicit project as the caller wrote it. */
export function describeQualifiedInputError(
  error: QualifiedInputError,
  requested = (project: string) => `指定的项目 ${project} `,
): string {
  switch (error.kind) {
    case "unknown_code":
      return `完整编号 ${error.qualified} 的代号 ${error.code} 没有登记给任何项目`;
    case "mixed_projects":
      return `完整编号 ${error.qualified.join("、")} 属于不同项目，一次只能操作一个项目`;
    case "project_mismatch":
      return `完整编号 ${error.qualified} 属于项目 ${error.project_id}，与${requested(error.requested)}不一致`;
  }
}
