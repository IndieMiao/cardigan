import { parseCachedLaunchConfig } from "@cardigan/host";
import { HARNESSES, validateLaunchSecrets } from "@cardigan/roles";
import { isAlias, isMap, isScalar } from "yaml";
import { z } from "zod";
import {
  invalid,
  legacyEndpoint,
  type SettingsFile,
} from "./launch-settings-file.js";

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
export const changeSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("create_profile"), name, fields: params }),
  z.strictObject({ op: z.literal("copy_profile"), name, source: name }),
  z.strictObject({ op: z.literal("edit_profile"), name, fields: params }),
  z.strictObject({ op: z.literal("delete_profile"), name }),
  z.strictObject({ op: z.literal("set_model"), name, id: text }),
  z.strictObject({
    op: z.literal("edit_provider"),
    name,
    fields: z.strictObject({
      name: text.optional(),
      base_url: text.optional(),
      secret_env: z
        .record(
          z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/u),
          z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/u),
        )
        .optional(),
    }),
  }),
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

export function candidate(file: SettingsFile, change: Change, dataDir: string) {
  const { doc, config, secrets } = file;
  const group =
    change.op === "set_model"
      ? "models"
      : change.op === "edit_provider"
        ? "providers"
        : "profiles";
  const path = [group, change.name];
  independent(file, path);
  const exists = doc.hasIn(path);
  const create = change.op === "create_profile" || change.op === "copy_profile";
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
    case "edit_provider": {
      const provider = config.providers[change.name];
      if (!provider) throw invalid("name");
      for (const [k, v] of Object.entries(change.fields)) {
        if (k === "secret_env") {
          for (const [env, key] of Object.entries(
            change.fields.secret_env ?? {},
          )) {
            if (
              !Object.hasOwn(
                config.providers[change.name]?.secret_env ?? {},
                env,
              ) ||
              !Object.hasOwn(secrets, key)
            )
              throw invalid("secret_env");
            set(["secret_env", env], key);
          }
        } else if (k === "base_url") {
          const legacy = legacyEndpoint(provider);
          if (legacy) {
            // Unsafe historical URLs may contain an embedded key; edit these on the host.
            if (!legacy.value) throw invalid("base_url");
            set(["env", legacy.key], v);
          }
          set(["base_url"], v);
        } else set([k], v);
      }
      break;
    }
  }
  if (!diff.length) throw invalid();
  try {
    const next = parseCachedLaunchConfig(doc.toJS(), dataDir);
    validateLaunchSecrets(next, secrets);
    return { diff, text: doc.toString() };
  } catch {
    throw invalid();
  }
}
