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
