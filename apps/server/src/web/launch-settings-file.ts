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
  type LaunchConfig,
  type ProviderDefinition,
  parseSecretsText,
  requiredSecretKeys,
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
export const snapshot = (dir: string) => digest(launchFilesStamp(dir));

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
export function readLaunchSettings(dir: string, dataDir: string) {
  const version = snapshot(dir);
  try {
    const path = join(dir, "launch.yaml");
    const original = readFile(path, false);
    const doc = parseDocument(original, { prettyErrors: false });
    if (doc.errors.length) throw invalid();
    const raw = doc.toJS();
    const config = parseCachedLaunchConfig(raw, dataDir);
    let secrets: Record<string, string> = {};
    try {
      secrets = parseSecretsText(readFile(join(dir, "secrets.env"), true));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (version !== snapshot(dir)) throw stale();
    return { path, original, doc, raw, config, secrets, version };
  } catch (error) {
    if (error instanceof HttpRejection) throw error;
    throw invalid(); // parser diagnostics and OS errors are not public DTOs
  }
}
export type SettingsFile = ReturnType<typeof readLaunchSettings>;
export function validSettings({ config, secrets }: SettingsFile): LaunchConfig {
  return {
    ...config,
    profiles: Object.fromEntries(
      Object.entries(config.profiles).filter(([n]) =>
        requiredSecretKeys(config, n).every(
          (k) => Object.hasOwn(secrets, k) && !!secrets[k],
        ),
      ),
    ),
  };
}

/** Free form env, CLI output, args/config and raw YAML are not public fields. Guard
 * the selected fields too (e.g. an operator pasted a secret into a label). */
export function publicFields(
  value: unknown,
  secrets: Record<string, string>,
): unknown {
  const privateValues = Object.values(secrets).filter(Boolean);
  const text = (s: string) =>
    privateValues.some((v) => s.includes(v)) ? "***" : s;
  const project = (v: unknown): unknown =>
    typeof v === "string"
      ? text(v)
      : Array.isArray(v)
        ? v.map(project)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v).map(([k, x]) => [text(k), project(x)]),
            )
          : v;
  return project(value);
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
export function legacyEndpoint(p: ProviderDefinition) {
  const key =
    p.harness === "claude-code" ? "ANTHROPIC_BASE_URL" : p.base_url_env;
  const value = key && p.env[key];
  if (!value || !key) return undefined;
  const url = URL.parse(value);
  return {
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
  };
}
