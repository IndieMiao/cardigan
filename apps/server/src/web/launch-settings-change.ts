import { HARNESSES } from "@cardigan/roles";
import { isAlias, isMap, isScalar } from "yaml";
import { z } from "zod";
import { HttpRejection } from "./http.js";
import {
  invalid,
  legacyEndpoints,
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

export function candidate(file: SettingsFile, change: Change) {
  const { doc, config, secrets } = file;
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
    case "edit_profile":
      for (const [k, v] of Object.entries(change.fields)) set([k], v);
      break;
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
        const isSet = Object.hasOwn(secrets, key) && !!secrets[key];
        const clearing = plan.clear.includes(key);
        if (
          !plain(key) ||
          !(referenced.has(key) || (clearing && previous.has(key))) ||
          (clearing && !isSet)
        )
          throw invalid("secrets");
        diff.push({
          field: `${SECRET_DIFF}${key}`,
          before: isSet ? "set" : "unset",
          after: plan.set.includes(key) ? "new" : "unset",
        });
      }
      break;
    }
  }
  const yaml = diff.some((d) => !d.field.startsWith(SECRET_DIFF));
  if (!diff.length) throw invalid();
  // Field paths contain protocol literals; only their dynamic components and
  // displayed values can contain private configuration data.
  for (const { before, after } of diff)
    for (const value of [before, after])
      if (
        JSON.stringify(value) !== JSON.stringify(publicFields(value, secrets))
      )
        throw invalid();
  return { diff, text: doc.toString(), raw: doc.toJS(), yaml, plan };
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
