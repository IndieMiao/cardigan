import { HARNESSES, PERMISSION_MODES } from "@cardigan/roles";
import { isAlias, isMap, isScalar } from "yaml";
import { z } from "zod";
import { HttpRejection } from "./http.js";
import {
  invalid,
  legacyEndpoints,
  privateEnv,
  publicFields,
  type SettingsFile,
} from "./launch-settings-file.js";
import { planKeys, secretKey, secretPlan } from "./launch-settings-secrets.js";

/** Provider protocols the host accepts (`packages/roles` provider schema). */
export const PROVIDER_APIS = [
  "anthropic-messages",
  "openai-responses",
  "openai-completions",
] as const;

const name = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u);
const text = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\p{Cc}]+$/u);
const params = z.strictObject({
  harness: z.enum(HARNESSES).optional(),
  provider: name.nullable().optional(),
  model: text.nullable().optional(),
  effort: name.nullable().optional(),
  permission_mode: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/u)
    .nullable()
    .optional(),
  provider_flag: name.nullable().optional(),
  auto_update: z.boolean().nullable().optional(),
});
const envName = z
  .string()
  .max(128)
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/u);
const providerFields = z.strictObject({
  name: text.optional(),
  harness: z.enum(HARNESSES).nullable().optional(),
  api: z.enum(PROVIDER_APIS).nullable().optional(),
  base_url: text.nullable().optional(),
  // Plain values only; credentials belong in secrets.env (see `secrets`).
  env: z
    .record(
      envName,
      z
        .string()
        .max(4096)
        .regex(/^[^\p{Cc}]*$/u)
        .nullable(),
    )
    .optional(),
  secret_env: z.record(envName, secretKey.nullable()).optional(),
});
export const changeSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("create_profile"), name, fields: params }),
  z.strictObject({ op: z.literal("copy_profile"), name, source: name }),
  z.strictObject({ op: z.literal("edit_profile"), name, fields: params }),
  z.strictObject({ op: z.literal("delete_profile"), name }),
  z.strictObject({
    op: z.literal("set_model"),
    name,
    id: text.refine((id) => !!id.trim()),
  }),
  z.strictObject({
    op: z.literal("create_provider"),
    name,
    fields: providerFields,
    secrets: secretPlan.optional(),
  }),
  z.strictObject({
    op: z.literal("edit_provider"),
    name,
    fields: providerFields,
    secrets: secretPlan.optional(),
  }),
  z.strictObject({ op: z.literal("delete_provider"), name }),
]);
export type Change = z.infer<typeof changeSchema>;

// Never edit through an alias, or change an anchored node used elsewhere.
function independent(file: SettingsFile, path: string[]) {
  for (let n = 0; n <= path.length; n++) {
    const node = file.doc.getIn(path.slice(0, n), true);
    if (isAlias(node) || ((isMap(node) || isScalar(node)) && node.anchor))
      throw invalid();
  }
}

const SECRET_DIFF = "secrets.";
/** A diff value that exists but is not shown (see `privateEnv`). */
export const HIDDEN = Object.freeze({ hidden: true });

export function candidate(
  file: SettingsFile,
  change: Change,
  /**
   * Q-1094: the confirmation's operation names fresh keys deterministically
   * (preview and confirm agree); `pending` keys belong to writes not yet
   * known to be in effect and cannot be referenced.
   */
  opts: { operation?: string; pending?: ReadonlySet<string> } = {},
) {
  const { doc, config, secrets } = file;
  const pending = opts.pending ?? new Set<string>();
  const keyMap: Record<string, string> = {};
  const superseded: string[] = [];
  const providerOp =
    change.op === "edit_provider" ||
    change.op === "create_provider" ||
    change.op === "delete_provider";
  const group =
    change.op === "set_model"
      ? "models"
      : providerOp
        ? "providers"
        : "profiles";
  const path = [group, change.name];
  independent(file, path);
  const exists = doc.hasIn(path);
  const create =
    change.op === "create_profile" ||
    change.op === "copy_profile" ||
    change.op === "create_provider";
  if (create === exists) throw invalid("name");
  const diff: { field: string; before: unknown; after: unknown }[] = [];
  function set(field: string[], value: unknown) {
    independent(file, [...path, ...field]);
    const before = doc.getIn([...path, ...field]);
    if (before === value || (before === undefined && value === null)) return;
    diff.push({
      field: [...path, ...field].join("."),
      before: before ?? null,
      after: value,
    });
    if (value === null) doc.deleteIn([...path, ...field]);
    else doc.setIn([...path, ...field], doc.createNode(value));
  }
  const plain = (value: string) => publicFields(value, secrets) === value;
  if (!plain(change.name)) throw invalid("name");
  const plan = planKeys(
    change.op === "edit_provider" || change.op === "create_provider"
      ? change.secrets
      : undefined,
  );
  switch (change.op) {
    case "create_profile":
    case "edit_profile": {
      // C-564: a permission mode is set only to a value the profile's
      // harness offers. One left untouched is not sent, so it stays as is.
      const mode = change.fields.permission_mode;
      if (typeof mode === "string") {
        const harness =
          change.fields.harness ?? config.profiles[change.name]?.harness;
        if (!harness || !PERMISSION_MODES[harness].includes(mode))
          throw invalid("permission_mode");
      }
      for (const [k, v] of Object.entries(change.fields)) set([k], v);
      break;
    }
    case "copy_profile": {
      if (!Object.hasOwn(config.profiles, change.source))
        throw invalid("source");
      doc.setIn(path, doc.createNode(file.raw.profiles[change.source]));
      diff.push({
        field: path.join("."),
        before: null,
        after: { copy_of: change.source },
      });
      break;
    }
    case "delete_profile":
      doc.deleteIn(path);
      diff.push({ field: path.join("."), before: change.name, after: null });
      break;
    case "set_model":
      if (
        !isMap(doc.getIn(path, true)) ||
        !isScalar(doc.getIn([...path, "id"], true))
      )
        throw invalid("id");
      set(["id"], change.id);
      break;
    case "delete_provider": {
      if (!Object.hasOwn(config.providers, change.name)) throw invalid("name");
      const users = providerUsers(file, change.name);
      if (users.profiles.length || users.models.length)
        throw new HttpRejection(
          409,
          "provider_in_use",
          "仍有启动配置或模型别名使用该 Provider",
          publicFields(users, secrets),
        );
      doc.deleteIn(path);
      diff.push({ field: path.join("."), before: change.name, after: null });
      break;
    }
    case "create_provider":
    case "edit_provider": {
      const creating = change.op === "create_provider";
      if (!creating && !Object.hasOwn(config.providers, change.name))
        throw invalid("name");
      if (creating) doc.setIn(path, doc.createNode({}));
      const { fields } = change;
      for (const k of ["name", "harness", "api"] as const)
        if (fields[k] !== undefined) set([k], fields[k]);
      if (fields.base_url !== undefined) {
        if (!creating)
          for (const legacy of legacyEndpoints(config, change.name)) {
            // Unsafe historical URLs may contain an embedded key; edit these on the host.
            if (
              !legacy.value ||
              !plain(legacy.key) ||
              Object.hasOwn(fields.env ?? {}, legacy.key)
            )
              throw invalid("base_url");
            set(["env", legacy.key], fields.base_url);
          }
        set(["base_url"], fields.base_url);
      }
      for (const [env, value] of Object.entries(fields.env ?? {})) {
        if (!plain(env)) throw invalid("env");
        // A secrets.env value never goes into the YAML as plain text.
        if (value !== null && !plain(value)) throw invalid();
        set(["env", env], value);
      }
      for (const [env, key] of Object.entries(fields.secret_env ?? {})) {
        // A reference names a key secrets.env has, or one this change writes.
        if (
          !plain(env) ||
          (key !== null &&
            !(Object.hasOwn(secrets, key) || plan.set.includes(key)))
        )
          throw invalid("secret_env");
        // V-2719: a key another confirmation is still writing cannot be used.
        if (key !== null && pending.has(key) && !plan.set.includes(key))
          throw invalid("secret_pending");
        set(["secret_env", env], key);
      }
      // Only keys this Provider references after the change can be written
      // here; a key it stops referencing can also be cleared.
      const referenced = new Set<unknown>(
        Object.values(doc.toJS()?.providers?.[change.name]?.secret_env ?? {}),
      );
      const previous = new Set<unknown>(
        Object.values(config.providers[change.name]?.secret_env ?? {}),
      );
      for (const key of [...plan.set, ...plan.clear]) {
        // V-2708: secrets.env is one global map. Writing a key another
        // Provider also reads would change that Provider's credential from
        // this form without its users ever seeing it; use a separate key.
        const others = Object.entries(config.providers)
          .filter(
            ([id, p]) =>
              id !== change.name && Object.values(p.secret_env).includes(key),
          )
          .map(([id]) => id);
        if (others.length)
          throw new HttpRejection(
            409,
            "secret_shared",
            "其它 Provider 也在使用这个密钥",
            publicFields(
              {
                key,
                providers: others,
                profiles: Object.entries(config.profiles)
                  .filter(
                    ([, p]) => !!p.provider && others.includes(p.provider),
                  )
                  .map(([profile]) => profile),
              },
              secrets,
            ),
          );
        const isSet = Object.hasOwn(secrets, key) && !!secrets[key];
        const clearing = plan.clear.includes(key);
        if (
          !plain(key) ||
          !(referenced.has(key) || (clearing && previous.has(key))) ||
          (clearing && !isSet)
        )
          throw invalid("secrets");
        if (clearing)
          diff.push({
            field: `${SECRET_DIFF}${key}`,
            before: isSet ? "set" : "unset",
            after: "unset",
          });
      }
      // Q-1094: a value is only ever written to a brand-new key; a key that
      // exists, is referenced anywhere or is still pending gets a fresh name,
      // and this Provider's references move to it. The YAML rename is then
      // the single commit point, and the old launch.yaml never reads it.
      const inUse = (key: string) =>
        Object.hasOwn(secrets, key) ||
        pending.has(key) ||
        Object.values(config.providers).some((p) =>
          Object.values(p.secret_env).includes(key),
        );
      const suffix = (opts.operation ?? "")
        .replace(/[^0-9a-f]/giu, "")
        .slice(0, 8)
        .toUpperCase();
      // V-2727:1: fresh names are also unique within this change; a name
      // that cannot be made unique within 128 characters is refused here,
      // before anything is written.
      const allocated = new Set<string>();
      const taken = (k: string) =>
        inUse(k) || allocated.has(k) || plan.set.includes(k);
      for (const key of plan.set) {
        let final = key;
        if (inUse(key) || allocated.has(key)) {
          if (!suffix) throw invalid("secret_key_conflict");
          final = "";
          for (let n = 0; n < 100 && !final; n++) {
            const tail = n ? `_${suffix}_${n}` : `_${suffix}`;
            const name = `${key.slice(0, 128 - tail.length)}${tail}`;
            if (!taken(name)) final = name;
          }
          if (!final) throw invalid("secret_key_conflict");
        }
        allocated.add(final);
        keyMap[key] = final;
        if (final !== key) {
          const refs = doc.toJS()?.providers?.[change.name]?.secret_env ?? {};
          for (const [env, ref] of Object.entries(refs))
            if (ref === key) set(["secret_env", env], final);
          if (previous.has(key)) superseded.push(key);
        }
        diff.push({
          field: `${SECRET_DIFF}${final}`,
          before: "unset",
          after: "new",
        });
      }
      break;
    }
  }
  // V-2708: a plain env value follows the read view's rule. A hidden value is
  // replaced or removed by status only; its text never comes back.
  const envPrefix = `${path.join(".")}.env.`;
  for (const line of diff) {
    if (!line.field.startsWith(envPrefix)) continue;
    const env = line.field.slice(envPrefix.length);
    for (const side of ["before", "after"] as const) {
      const value = line[side];
      if (typeof value === "string" && privateEnv(env, value, secrets))
        line[side] = HIDDEN;
    }
  }
  const yaml = diff.some((d) => !d.field.startsWith(SECRET_DIFF));
  // Clearing commits by the secrets.env rename; it is its own save.
  if (yaml && plan.clear.length > 0) throw invalid("secrets_mixed");
  if (!diff.length) throw invalid();
  // Field paths contain protocol literals; only their dynamic components and
  // displayed values can contain private configuration data.
  for (const { before, after } of diff)
    for (const value of [before, after])
      if (
        JSON.stringify(value) !== JSON.stringify(publicFields(value, secrets))
      )
        throw invalid();
  return {
    diff,
    text: doc.toString(),
    raw: doc.toJS(),
    yaml,
    plan,
    keyMap,
    superseded,
  };
}

/** Profiles and model aliases that name this Provider. */
export function providerUsers(file: Pick<SettingsFile, "config">, id: string) {
  const { config } = file;
  return {
    profiles: Object.entries(config.profiles)
      .filter(([, p]) => p.provider === id)
      .map(([name]) => name),
    models: Object.entries(config.models ?? {})
      .filter(([, m]) => m.provider === id)
      .map(([alias]) => alias),
  };
}
