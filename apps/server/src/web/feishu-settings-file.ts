import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { EXT_MESSAGE_DEFAULTS } from "@cardigan/domain";
import {
  defaultMaxPerMinute,
  loadExtMessageConfig,
  parseAppCredential,
  parseFeishuCredential,
} from "@cardigan/host";
import { parseDocument } from "yaml";
import { z } from "zod";
import { HttpRejection } from "./http.js";
import { digest } from "./launch-settings-file.js";
import { writeNewPrivateFile } from "./launch-settings-secrets.js";

export const invalid = () =>
  new HttpRejection(400, "invalid_settings", "飞书配置或凭据无效");
export const stale = () =>
  new HttpRejection(409, "stale_snapshot", "飞书配置已变化，请重新预览");
const bool = z.boolean(),
  number = z.number().int().min(1).max(2147483647);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u);
const timezone = z
  .string()
  .min(1)
  .max(128)
  .refine((v) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: v });
      return true;
    } catch {
      return false;
    }
  });
const url = z
  .string()
  .max(2048)
  .refine((v) => {
    if (!v) return true;
    const u = URL.parse(v);
    return (
      !!u &&
      ["https:", "http:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      !u.pathname.includes("/bot/v2/hook/")
    );
  });
// Only these paths can ever reach a diff, an audit row, or setIn(). Never serialize raw YAML.
const fields = {
  enabled: bool,
  workbench_url: url,
  "quiet_hours.enabled": bool,
  "quiet_hours.timezone": timezone,
  "quiet_hours.start": clock,
  "quiet_hours.end": clock,
  "policy.max_per_minute": number,
  "policy.timeout_ms": number,
  "policy.max_attempts": number,
  "policy.retry_delays_ms": z.array(number),
  "policy.title_limit": number,
  "policy.digest_limit": number,
  "channels.lark.enabled": bool,
  "channels.lark_app.enabled": bool,
  "channels.lark.max_per_minute": number,
  "channels.lark_app.max_per_minute": number,
  "channels.lark_app.binding_ttl_ms": number,
  "channels.lark_app.action_ttl_ms": number,
  "channels.lark_app.binding_attempts_per_minute": number,
  "channels.lark_app.pending_limit": number,
};
const defaults = {
  enabled: false,
  workbench_url: "",
  "quiet_hours.enabled": false,
  "quiet_hours.timezone": "UTC",
  "quiet_hours.start": "22:00",
  "quiet_hours.end": "08:00",
  ...Object.fromEntries(
    Object.entries(EXT_MESSAGE_DEFAULTS).map(([k, v]) => [`policy.${k}`, v]),
  ),
  "policy.max_per_minute": defaultMaxPerMinute,
  "channels.lark.enabled": false,
  "channels.lark_app.enabled": false,
  "channels.lark_app.binding_ttl_ms": 300000,
  "channels.lark_app.action_ttl_ms": 86400000,
  "channels.lark_app.binding_attempts_per_minute": 30,
  "channels.lark_app.pending_limit": 32,
} as Record<string, unknown>;
export const channelNames = ["lark", "lark_app"] as const;
export type Channel = (typeof channelNames)[number];
const files = { lark: "ext-message.secrets", lark_app: "feishu-app.secrets" };
const keyMap = {
  lark_webhook: ["lark", "webhook"],
  lark_sign_secret: ["lark", "secret"],
  app_id: ["lark_app", "app_id"],
  app_secret: ["lark_app", "app_secret"],
  tenant_key: ["lark_app", "tenant_key"],
} as const;
const keySchema = z.enum(keyMapKeys());
function keyMapKeys() {
  return Object.keys(keyMap) as (keyof typeof keyMap)[];
}
export const changeSchema = z.strictObject({
  settings: z.strictObject(fields).partial().default({}),
  secrets: z
    .strictObject({
      set: z.array(keySchema).default([]),
      clear: z.array(keySchema).default([]),
    })
    .prefault({}),
});
export type Change = z.infer<typeof changeSchema>;
export const valuesSchema = z.partialRecord(
  keySchema,
  z
    .string()
    .min(1)
    .max(4096)
    .refine((v) => v.trim() === v),
);
type Values = z.infer<typeof valuesSchema>;
function readPrivate(path: string) {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw invalid();
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    if (
      !st.isFile() ||
      st.nlink !== 1n ||
      (st.mode & 0o7777n) !== 0o600n ||
      (process.getuid && Number(st.uid) !== process.getuid()) ||
      st.size > 1024n * 1024n
    )
      throw invalid();
    return {
      text: readFileSync(fd, "utf8"),
      identity: `${st.dev}:${st.ino}:${st.mtimeNs}`,
      stamp: `${st.dev}:${st.ino}:${st.ctimeNs}:${st.mtimeNs}`,
      at: new Date(Number(st.mtimeMs)).toISOString(),
    };
  } finally {
    closeSync(fd);
  }
}
function fileState(path: string, dir: string) {
  const root = lstatSync(dir);
  if (
    !root.isDirectory() ||
    root.mode & 0o022 ||
    (process.getuid && root.uid !== process.getuid())
  )
    throw invalid();
  const yaml = readPrivate(path),
    doc = parseDocument(yaml?.text ?? "{}", { prettyErrors: false });
  const raw = doc.toJS();
  if (
    doc.errors.length ||
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw)
  )
    throw invalid();
  const read = (key: string): unknown =>
    key
      .split(".")
      .reduce(
        (obj, k) =>
          obj && typeof obj === "object" && Object.hasOwn(obj, k)
            ? (obj as Record<string, unknown>)[k]
            : undefined,
        raw as unknown,
      );
  const settings = z.strictObject(fields).parse(
    Object.fromEntries(
      Object.keys(fields).map((k) => {
        const value = read(k);
        return [
          k,
          value !== undefined
            ? value
            : (defaults[k] ??
              read("policy.max_per_minute") ??
              defaultMaxPerMinute),
        ];
      }),
    ),
  );
  const stamps = [yaml?.stamp ?? "missing"];
  const values: Values = {};
  const secrets = {} as Record<
    keyof Values,
    { set: boolean; updated_at: string | null }
  >;
  for (const name of channelNames) {
    const get = (key: string) => read(`channels.${name}.${key}`);
    const ref = get("credential_file"),
      inline = get("credential");
    let text = inline,
      at = yaml?.at;
    if (ref !== undefined) {
      if (typeof ref !== "string" || !ref || inline !== undefined)
        throw invalid();
      const f = readPrivate(resolve(dir, ref));
      text = f?.text;
      at = f?.at;
      stamps.push(f?.stamp ?? "missing");
    }
    const data =
      text === undefined
        ? {}
        : typeof text === "string"
          ? JSON.parse(text)
          : null;
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw invalid();
    for (const k of keyMapKeys()) {
      const [ch, field] = keyMap[k];
      if (ch !== name) continue;
      const value = data[field];
      if (value !== undefined && typeof value !== "string") throw invalid();
      if (value) values[k] = value;
      const saved = z.iso
        .datetime()
        .safeParse(doc.getIn(["settings_secret_times", k]));
      secrets[k] = {
        set: !!value,
        updated_at: saved.success ? saved.data : value ? (at ?? null) : null,
      };
    }
  }
  return {
    doc,
    path,
    yaml,
    version: digest(stamps.join("/")),
    settings,
    values,
    secrets,
  };
}
export const readSettings = (path: string, dir = dirname(path)) => {
  try {
    return fileState(path, dir);
  } catch {
    throw invalid();
  }
};
export type FileState = ReturnType<typeof readSettings>;
// A credential accidentally pasted into another editable string is not public either.
export function publicSettings(f: FileState, settings = f.settings) {
  const values = Object.values(f.values).filter(Boolean);
  return Object.fromEntries(
    Object.entries(settings).map(([k, v]) => [
      k,
      typeof v === "string" && values.some((s) => v.includes(s)) ? null : v,
    ]),
  );
}
export function plan(f: FileState, change: Change) {
  const keys = [...change.secrets.set, ...change.secrets.clear];
  if (
    new Set(keys).size !== keys.length ||
    !(keys.length + Object.keys(change.settings).length)
  )
    throw invalid();
  for (const [k, v] of Object.entries(change.settings))
    f.doc.setIn(k.split("."), v);
  const merged = z
    .strictObject(fields)
    .parse({ ...f.settings, ...change.settings });
  if (
    (merged.enabled && !merged.workbench_url) ||
    (merged["quiet_hours.enabled"] &&
      merged["quiet_hours.start"] === merged["quiet_hours.end"]) ||
    merged["policy.max_attempts"] !==
      merged["policy.retry_delays_ms"].length + 1
  )
    throw invalid();
  if (merged["quiet_hours.enabled"])
    for (const k of ["start", "end", "timezone"] as const) {
      if (!f.doc.hasIn(["quiet_hours", k]))
        f.doc.setIn(["quiet_hours", k], merged[`quiet_hours.${k}`]);
    }
  const before = publicSettings(f),
    after = publicSettings(f, merged);
  // Rotation must not unmask an unchanged field containing the old credential.
  if (Object.values(after).includes(null)) throw invalid();
  for (const name of channelNames) {
    if (!merged.enabled || !merged[`channels.${name}.enabled`]) continue;
    for (const k of keyMapKeys())
      if (
        keyMap[k][0] === name &&
        k !== "lark_sign_secret" &&
        (change.secrets.clear.includes(k) ||
          (!f.values[k] && !change.secrets.set.includes(k)))
      )
        throw invalid();
  }
  return [
    ...Object.keys(change.settings).map((key) => ({
      key,
      before: before[key],
      after: after[key],
    })),
    ...keys.map((key) => ({
      key: `secrets.${key}`,
      before: f.secrets[key].set ? "set" : "unset",
      after: change.secrets.set.includes(key) ? "new" : "unset",
    })),
  ];
}

/** Immutable replacement secrets; readers of the old YAML keep seeing its complete generation. */
export function publish(
  f: FileState,
  change: Change,
  input: Values,
  commit: (
    publication: string,
    config: ReturnType<typeof loadExtMessageConfig>,
    install: () => void,
  ) => void,
) {
  if (
    Object.keys(input).sort().join() !== [...change.secrets.set].sort().join()
  )
    throw invalid();
  const dir = dirname(f.path),
    id = randomUUID(),
    generation = join(dir, `.feishu-${id}`),
    temp = join(generation, "next.yaml");
  const values = { ...f.values, ...input };
  for (const k of change.secrets.clear) delete values[k];
  let installed = false;
  let hasSecrets = false;
  mkdirSync(generation, { mode: 0o700 });
  try {
    const now = new Date().toISOString();
    for (const name of channelNames) {
      const keys = keyMapKeys().filter((k) => keyMap[k][0] === name);
      // An unchanged inline credential takes its legacy timestamp from the old
      // YAML inode. Pin it before replacing that inode, even on a settings-only save.
      if (f.doc.hasIn(["channels", name, "credential"]))
        for (const k of keys) {
          const at = f.secrets[k].updated_at;
          if (at) f.doc.setIn(["settings_secret_times", k], at);
        }
      if (
        !keys.some(
          (k) =>
            change.secrets.set.includes(k) || change.secrets.clear.includes(k),
        )
      )
        continue;
      const obj = Object.fromEntries(
        keys.filter((k) => values[k]).map((k) => [keyMap[k][1], values[k]]),
      );
      if (name === "lark" && obj.webhook)
        parseFeishuCredential(JSON.stringify(obj));
      if (
        name === "lark_app" &&
        ((obj.app_id && !/^cli_[a-fA-F0-9]{16}$/u.test(obj.app_id)) ||
          Object.values(obj).some((v) => v !== undefined && v.length > 512))
      )
        throw invalid();
      if (name === "lark_app" && obj.app_id && obj.tenant_key && obj.app_secret)
        parseAppCredential(JSON.stringify(obj));
      const channel = ["channels", name];
      f.doc.deleteIn([...channel, "credential"]);
      f.doc.deleteIn([...channel, "credential_file"]);
      if (Object.keys(obj).length) {
        const ref = join(basename(generation), files[name]);
        writeNewPrivateFile(join(dir, ref), JSON.stringify(obj));
        hasSecrets = true;
        f.doc.setIn([...channel, "credential_file"], ref);
      }
      for (const k of keys)
        if (
          change.secrets.set.includes(k) ||
          change.secrets.clear.includes(k) ||
          f.secrets[k].updated_at
        )
          f.doc.setIn(
            ["settings_secret_times", k],
            change.secrets.set.includes(k) || change.secrets.clear.includes(k)
              ? now
              : f.secrets[k].updated_at,
          );
    }
    f.doc.set("settings_publication", id);
    writeNewPrivateFile(temp, String(f.doc));
    const next = readSettings(temp, dir),
      effective = loadExtMessageConfig(temp, dir);
    if (
      effective.status !== "loaded" ||
      (effective.config.enabled &&
        effective.config.channels.lark_app?.enabled &&
        !effective.config.channels.lark_app.credential) ||
      Object.values(publicSettings(next)).includes(null)
    )
      throw invalid();
    if (readSettings(f.path).version !== f.version) throw stale();
    if (f.yaml) {
      const backup = join(generation, "previous.yaml");
      writeNewPrivateFile(backup, f.yaml.text);
      renameSync(backup, `${f.path}.${id}.bak`);
    }
    commit(`${id}:${next.yaml!.identity}`, effective, () => {
      if (readSettings(f.path).version !== f.version) throw stale();
      renameSync(temp, f.path);
      installed = true;
    });
  } finally {
    if (!installed || !hasSecrets) {
      try {
        rmSync(generation, { recursive: true, force: true });
      } catch {
        // An unused private directory may remain. Cleanup must not replace the
        // committed receipt or mask the original error from a failed publish.
      }
    }
  }
}
