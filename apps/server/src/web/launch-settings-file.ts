import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { launchFilesStamp, parseCachedLaunchConfig } from "@cardigan/host";
import {
  getHarnessAdapter,
  type Harness,
  type LaunchConfig,
  parseSecretsText,
} from "@cardigan/roles";
import {
  listRoleVersions,
  type ReadRepositories,
  type Store,
} from "@cardigan/store";
import { parseDocument } from "yaml";
import { HttpRejection } from "./http.js";

export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const stale = () =>
  new HttpRejection(409, "stale_snapshot", "启动配置已变化，请刷新后重新预览");
export const invalid = (field?: string) =>
  new HttpRejection(
    400,
    "validation_failed",
    "启动配置或密钥引用未通过校验",
    field ? { field } : undefined,
  );
export const snapshot = (dir: string, revision: number) =>
  digest(`${launchFilesStamp(dir)}:${revision}`);

function readFile(path: string, privateFile: boolean) {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (privateFile && (st.mode & 0o777) !== 0o600))
      throw invalid();
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
/** A 0600 regular file, not followed through a symlink (secrets.env). */
export const readPrivateText = (path: string) => readFile(path, true);
export function readLaunchSettings(
  dir: string,
  dataDir: string,
  revision: number,
) {
  const version = snapshot(dir, revision);
  try {
    const path = join(dir, "launch.yaml");
    const original = readFile(path, false);
    const doc = parseDocument(original, { prettyErrors: false });
    if (doc.errors.length) throw invalid();
    const raw = doc.toJS();
    const config = parseCachedLaunchConfig(raw, dataDir);
    const secrets = readSettingsSecrets(dir);
    if (version !== snapshot(dir, revision)) throw stale();
    return { path, original, doc, raw, config, secrets, version };
  } catch (error) {
    if (error instanceof HttpRejection) throw error;
    throw invalid(); // parser diagnostics and OS errors are not public DTOs
  }
}
export type SettingsFile = ReturnType<typeof readLaunchSettings>;
function readSettingsSecrets(dir: string): Record<string, string> {
  try {
    return parseSecretsText(readFile(join(dir, "secrets.env"), true));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw invalid();
  }
}

/** Free form env, CLI output, args/config and raw YAML are not public fields. Guard
 * the selected fields too (e.g. an operator pasted a secret into a label). */
export function publicFields(
  value: unknown,
  secrets: Record<string, string>,
  dictionaryKeys = false,
): unknown {
  const privateValues = Object.values(secrets).filter(Boolean);
  const text = (s: string) =>
    privateValues.some((v) => s.includes(v)) ? "***" : s;
  const project = (v: unknown, dynamicKeys = false): unknown =>
    typeof v === "string"
      ? text(v)
      : Array.isArray(v)
        ? v.map((item) => project(item))
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v).map(([k, x]) => [
                dynamicKeys ? text(k) : k,
                project(x),
              ]),
            )
          : v;
  return project(value, dictionaryKeys);
}
export function references(
  store: Store,
  tx: Pick<ReadRepositories, "roles" | "employees">,
) {
  const rows = new Map<
    string,
    (
      | { role_id: string; project_id: string; version: number; name: string }
      | { employee_id: string; name: string }
    )[]
  >();
  function add(
    profile: string,
    ref: NonNullable<ReturnType<typeof rows.get>>[number],
  ) {
    const list = rows.get(profile) ?? [];
    list.push(ref);
    rows.set(profile, list);
  }
  for (const p of store.listProjects())
    for (const r of listRoleVersions(tx, p.id))
      add(r.launch_profile_ref, {
        project_id: p.id,
        role_id: r.role_id,
        version: r.version,
        name: r.display_name,
      });
  for (const e of tx.employees.list())
    if (e.launch_profile_ref)
      add(e.launch_profile_ref, { employee_id: e.id, name: e.name });
  return rows;
}

/** Imported Claude settings predate base_url. Never display a legacy env URL with credentials. */
export function legacyEndpoints(config: LaunchConfig, id: string) {
  const provider = config.providers[id];
  if (!provider) return [];
  const harnesses = new Set<Harness>();
  if (provider.harness) harnesses.add(provider.harness);
  if (provider.base_url_env) harnesses.add("pi");
  for (const profile of Object.values(config.profiles))
    if (profile.provider === id) harnesses.add(profile.harness);
  const keys = new Set(
    Array.from(harnesses, (h) =>
      getHarnessAdapter(h).endpointEnvKey?.(provider),
    ),
  );
  return Array.from(keys).flatMap((key) => {
    if (!key || !Object.hasOwn(provider.env, key)) return [];
    const value = provider.env[key];
    const url = value && URL.parse(value);
    return [
      {
        key,
        value:
          url &&
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
            ? value
            : null,
      },
    ];
  });
}

/** Env names that usually hold a credential: their values are never shown. */
const CREDENTIAL_NAME =
  /KEY|TOKEN|SECRET|PASSW|AUTH|CREDENTIAL|COOKIE|PRIVATE|SESSION/iu;
/**
 * V-2708: the one rule for a plain env value that is not public, used by the
 * read view and by every preview diff. A credential-like name, a value
 * containing a secrets.env value, or a URL with an account, query or fragment
 * (the same rule `legacyEndpoints` applies to endpoints) stays hidden.
 */
export function privateEnv(
  name: string,
  value: string,
  secrets: Record<string, string>,
) {
  const url = URL.parse(value);
  return (
    CREDENTIAL_NAME.test(name) ||
    publicFields(value, secrets) !== value ||
    !!url?.username ||
    !!url?.password ||
    !!url?.search ||
    !!url?.hash
  );
}

/** The endpoint the detail shows and a Provider probe uses: explicit, else a safe legacy env URL. */
export function providerEndpoint(config: LaunchConfig, id: string) {
  const provider = config.providers[id];
  if (!provider) return null;
  return provider.base_url ?? legacyEndpoints(config, id)[0]?.value ?? null;
}
