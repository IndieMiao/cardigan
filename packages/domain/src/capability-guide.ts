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

/**
 * Default upper bound of one note, in characters (code points). The longest
 * section of the sensen-godot tool guide (C-724) is about 4400 characters.
 */
export const USAGE_NOTE_MAX_LENGTH = 8000;
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

/**
 * Values separated by `/`, `_`, `-`, `.` are identifiers and paths, not
 * secrets; pure hex runs are digests (certificate fingerprints, commit SHAs).
 * A hex secret written as `TOKEN=…` is still caught by the name rule.
 */
function opaqueRun(text: string): boolean {
  for (const [run] of text.matchAll(/[A-Za-z0-9+=]{24,}/g)) {
    if (/^(?:[0-9a-f]+|[0-9A-F]+)$/.test(run)) continue;
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

const DEVICE_DIFFERENCES = [
  "真机与模拟器的差异：",
  "- 快照：真机没有快照，不能加载或保存快照，也没有冷启动；回到干净状态只能卸载重装或清应用数据（adb shell pm clear <包名>）。",
  "- 系统：真机可能是厂商系统（例如 HarmonyOS 的安卓兼容层），系统界面、权限弹窗和后台策略与原生安卓模拟器不同；系统版本和 API 以 adb shell getprop 为准。",
  "- 架构：真机一般只有 arm64-v8a，只打 x86 或 x86_64 的包装不上。",
  "- 分辨率与密度：以 adb shell wm size、adb shell wm density 为准；平板截图和手机分辨率截图不能互相替代。",
  "- 启动与网络：模拟器由 Run 自己用 -port $CARDIGAN_EMULATOR_PORT 启动，Run 结束时系统关闭；真机一直开着，不要重启、关机，不要改系统设置、锁屏、开发者选项和 USB 授权。模拟器里的 10.0.2.2 指向主机，真机上没有这个地址。",
  "- 证据：真机和模拟器的结果分开写，写明序列号和型号。",
  "",
  "目前接入的真机：mac-mini 上的华为 MRR-W39 平板，HarmonyOS 4.2（兼容 Android 12，API 31），arm64-v8a，1600x2560，400dpi，没有快照，插电不熄屏。",
].join("\n");

/**
 * C-815: notes the host ships for capabilities whose use differs from what a
 * session would assume. A project's own main note replaces them; machine
 * supplements are added as usual. `android.emulator` deliberately has none,
 * so emulator-only work items see exactly what they saw before.
 */
export const BUILTIN_CAPABILITY_NOTES: Readonly<Record<string, string>> =
  Object.freeze({
    "android.any": [
      "本工作项要求“安卓设备任一”：系统把本机空闲的安卓模拟器或安卓真机分给本 Run，两类都忙时排队。看 ANDROID_SERIAL：emulator- 开头是模拟器，否则是真机（序列号也在 CARDIGAN_DEVICE_SERIAL）。真机不能替代模拟器的情况：要快照、冷启动、擦数据重来、指定手机分辨率或机型、x86 镜像；分到真机又需要这些时，如实写未覆盖，并请 PM 把要求改成 android.emulator。",
      "",
      DEVICE_DIFFERENCES,
    ].join("\n"),
    "android.device": [
      "本工作项要求安卓真机：分到的真机序列号在 CARDIGAN_DEVICE_SERIAL（同一 Run 没有模拟器时也是 ANDROID_SERIAL）。真机没有快照、冷启动和手机分辨率，需要这些的测试不能用真机结果替代，如实写未覆盖。",
      "",
      DEVICE_DIFFERENCES,
    ].join("\n"),
  });

export function builtinCapabilityNote(key: string): string | undefined {
  return Object.hasOwn(BUILTIN_CAPABILITY_NOTES, key)
    ? BUILTIN_CAPABILITY_NOTES[key]
    : undefined;
}

/**
 * Merge capability × machine × project: each capability's main note with
 * the supplement for `machine_id`, plus every project-level note. With
 * `capabilities` given, exactly those keys are returned (null where nothing
 * is written, or the built-in note of C-815); otherwise every key that has a
 * main note or a supplement for this machine.
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
  // C-815: a key asked for by name falls back to its built-in note.
  const builtin = (key: string) =>
    options.capabilities ? builtinCapabilityNote(key) : undefined;
  return {
    machine_id: machine,
    capabilities: keys.sort().map((key) => ({
      key,
      usage_note: main.get(key) ?? builtin(key) ?? null,
      machine_note: supplement.get(key) ?? null,
    })),
    project_notes: project.sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    ),
  };
}
