import type { Actor } from "./entities.js";
import { type Result, validationFailed } from "./errors.js";

/**
 * C-725: plain-text / Markdown usage notes for the machine capability
 * catalog ("how to use it, which managed file, how to read it"). Three kinds
 * of entry, all scoped to one project:
 *
 * - `capability`: the main note of a capability key (`android.emulator`);
 * - `machine`: a supplement for the same key on one machine;
 * - `project`: project knowledge that belongs to no capability (where the
 *   managed test-account file lives, how managed signing is used), keyed by
 *   a topic.
 *
 * Notes name paths and usage, never values: anything that looks like a
 * credential is refused. Only the host (system) and humans write them;
 * Agent Tokens never do. Pure rules only (§20.2): no IO here.
 */

/** Default upper bound of one note, in characters (code points). */
export const USAGE_NOTE_MAX_LENGTH = 4000;
const KEY_MAX_LENGTH = 64;

export const CAPABILITY_GUIDE_SCOPES = [
  "capability",
  "machine",
  "project",
] as const;
export type CapabilityGuideScope = (typeof CAPABILITY_GUIDE_SCOPES)[number];

/** Which entry: capability key or project topic, plus a machine for supplements. */
export interface CapabilityGuideTarget {
  readonly scope: CapabilityGuideScope;
  /** Capability key for `capability`/`machine`; topic for `project`. */
  readonly key: string;
  /** Set exactly for `machine`. */
  readonly machine_id: string | null;
}

export interface CapabilityGuideEntry extends CapabilityGuideTarget {
  readonly usage_note: string;
  readonly updated_at: string;
  readonly updated_by: "human" | "system";
}

/** One capability's notes as an Agent on one machine would read them. */
export interface MergedCapabilityGuide {
  readonly key: string;
  readonly usage_note: string | null;
  readonly machine_note: string | null;
}

export interface MergedCapabilityGuides {
  readonly machine_id: string | null;
  readonly capabilities: readonly MergedCapabilityGuide[];
  readonly project_notes: readonly {
    readonly key: string;
    readonly usage_note: string;
  }[];
}

const KEY = /^[a-z0-9][a-z0-9._-]*$/;
const MACHINE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export function validateCapabilityGuideTarget(
  input: unknown,
): Result<CapabilityGuideTarget> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return validationFailed("使用说明条目必须是对象");
  const { scope, key, machine_id } = input as Record<string, unknown>;
  if (
    typeof scope !== "string" ||
    !(CAPABILITY_GUIDE_SCOPES as readonly string[]).includes(scope)
  )
    return validationFailed(
      "使用说明条目只能是 capability、machine 或 project",
    );
  if (typeof key !== "string" || key.length > KEY_MAX_LENGTH || !KEY.test(key))
    return validationFailed(
      scope === "project"
        ? "项目级说明的主题须为小写字母、数字、点、下划线或连字符，最长 64 个字符"
        : "能力键须为小写字母、数字、点、下划线或连字符，最长 64 个字符",
    );
  if (scope === "machine") {
    if (
      typeof machine_id !== "string" ||
      machine_id.length > KEY_MAX_LENGTH ||
      !MACHINE.test(machine_id)
    )
      return validationFailed("机器补充须指定合法的机器编号");
  } else if (machine_id !== undefined && machine_id !== null)
    return validationFailed("只有机器补充可以指定机器编号");
  return {
    ok: true,
    value: {
      scope: scope as CapabilityGuideScope,
      key,
      machine_id: scope === "machine" ? (machine_id as string) : null,
    },
  };
}

// Paths, environment references, placeholders and ports (`host:8443/path`)
// name where a value lives.
const REFERENCE =
  /^(?:[$<{%~/]|\.{1,2}\/|\*+$|x+$|\.\.\.$|…$|\d{1,5}(?:\/|$))/i;
const SECRET_NAME =
  /(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?key|credential|auth)/i;
const ASSIGNMENT =
  /(?:^|[^A-Za-z0-9_.-])([A-Za-z0-9_.-]+)[ \t]*[:=][ \t]*(["']?)([^\s"'`]+)/g;

const FORMATS: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, "私钥"],
  [
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/,
    "访问令牌",
  ],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, "JWT"],
  [/\b(?:Bearer|Basic)[ \t]+[A-Za-z0-9._~+/-]{16,}=*/i, "认证头"],
  [/[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, "带密码的地址"],
];

/** Values separated by `/`, `_`, `-`, `.` are identifiers and paths, not secrets. */
function opaqueRun(text: string): boolean {
  for (const [run] of text.matchAll(/[A-Za-z0-9+=]{24,}/g)) {
    const digits = run.replace(/[^0-9]/g, "").length;
    const letters = run.replace(/[^A-Za-z]/g, "").length;
    if (digits >= 3 && letters >= 3) return true;
  }
  return false;
}

/**
 * Why `text` looks like it holds a credential value, or null. Deliberately
 * conservative: obvious token formats, `NAME=value` where NAME names a secret
 * and value is not a path, variable or placeholder, and long opaque runs of
 * letters and digits.
 */
export function credentialLikeContent(text: string): string | null {
  for (const [pattern, label] of FORMATS) if (pattern.test(text)) return label;
  for (const match of text.matchAll(ASSIGNMENT)) {
    const [, name = "", , value = ""] = match;
    if (!SECRET_NAME.test(name) || REFERENCE.test(value)) continue;
    if (value.length >= 16 || (value.length >= 8 && /[0-9]/.test(value)))
      return `${name} 的取值`;
  }
  if (opaqueRun(text)) return "长串随机字符";
  return null;
}

/** Normalizes line endings and trims the ends; refuses empty, oversized and credential-like notes. */
export function validateUsageNote(input: unknown): Result<string> {
  if (typeof input !== "string") return validationFailed("使用说明必须是文本");
  const note = input.replace(/\r\n?/g, "\n").trim();
  if (note.length === 0) return validationFailed("使用说明不能为空");
  if ([...note].length > USAGE_NOTE_MAX_LENGTH)
    return validationFailed(
      `使用说明最长 ${USAGE_NOTE_MAX_LENGTH} 个字符，只写用法和受管文件路径`,
    );
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point.
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(note))
    return validationFailed("使用说明不能包含控制字符");
  const credential = credentialLikeContent(note);
  if (credential !== null)
    return validationFailed(
      `使用说明看起来包含凭据（${credential}）；只写受管文件路径和读取方法，不写值`,
    );
  return { ok: true, value: note };
}

/** Only the host and humans write usage notes; an Agent Token never does. */
export function authorizeCapabilityGuideWrite(
  actor: Actor,
  project_id: string,
): Result<"human" | "system"> {
  if (actor.kind === "assignment")
    return {
      ok: false,
      error: {
        code: "unauthorized",
        message: "能力使用说明只有人和主机可以修改，Agent Token 不可写",
      },
    };
  if (actor.project_id !== project_id)
    return {
      ok: false,
      error: { code: "unauthorized", message: "身份不属于该项目" },
    };
  return { ok: true, value: actor.kind };
}

/**
 * Merge capability × machine × project: each capability's main note with
 * the supplement for `machine_id`, plus every project-level note. With
 * `capabilities` given, exactly those keys are returned (null where nothing
 * is written); otherwise every key that has a main note or a supplement for
 * this machine.
 */
export function mergeCapabilityGuides(
  entries: readonly CapabilityGuideEntry[],
  options: {
    readonly machine_id?: string | null;
    readonly capabilities?: readonly string[];
  } = {},
): MergedCapabilityGuides {
  const machine = options.machine_id ?? null;
  const main = new Map<string, string>();
  const supplement = new Map<string, string>();
  const project: { key: string; usage_note: string }[] = [];
  for (const entry of entries) {
    if (entry.scope === "capability") main.set(entry.key, entry.usage_note);
    else if (entry.scope === "machine") {
      if (machine !== null && entry.machine_id === machine)
        supplement.set(entry.key, entry.usage_note);
    } else project.push({ key: entry.key, usage_note: entry.usage_note });
  }
  const keys = options.capabilities
    ? [...new Set(options.capabilities)]
    : [...new Set([...main.keys(), ...supplement.keys()])];
  return {
    machine_id: machine,
    capabilities: keys.sort().map((key) => ({
      key,
      usage_note: main.get(key) ?? null,
      machine_note: supplement.get(key) ?? null,
    })),
    project_notes: project.sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    ),
  };
}
