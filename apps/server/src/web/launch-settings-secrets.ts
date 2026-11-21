import { createHash, randomUUID } from "node:crypto";
import {
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  assertLaunchFence,
  type LaunchFence,
  launchFilesStamp,
} from "@cardigan/host";
import { parseSecretsText } from "@cardigan/roles";
import type { Store } from "@cardigan/store";
import { z } from "zod";
import { invalid, readPrivateText, stale } from "./launch-settings-file.js";

/**
 * C-549: secrets.env is write-only from the Web. A preview names the keys it
 * will set or clear; only the confirmation carries values, and nothing here
 * ever returns, logs or journals a value.
 */
export const secretKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u);
export const secretPlan = z
  .strictObject({
    set: z.array(secretKey).max(32).optional(),
    clear: z.array(secretKey).max(32).optional(),
  })
  .refine(
    ({ set = [], clear = [] }) =>
      new Set([...set, ...clear]).size === set.length + clear.length,
  );
export type SecretPlan = z.infer<typeof secretPlan>;
/** A value is one line of `KEY=VALUE`; it must read back exactly. */
export const secretValues = z.record(
  secretKey,
  z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[^\p{Cc}]+$/u),
);

export const planKeys = (plan: SecretPlan | undefined) => ({
  set: plan?.set ?? [],
  clear: plan?.clear ?? [],
});

/** The secrets the host would see after the plan (placeholders before confirm). */
export function plannedSecrets(
  secrets: Readonly<Record<string, string>>,
  plan: SecretPlan | undefined,
  values?: Readonly<Record<string, string>>,
) {
  const { set, clear } = planKeys(plan);
  const next: Record<string, string> = { ...secrets };
  for (const key of clear) delete next[key];
  for (const key of set) next[key] = values?.[key] ?? "planned";
  return next;
}

export function secretsPath(dir: string) {
  return join(realpathSync(dir), "secrets.env");
}

/** The current file text, `null` when there is no secrets.env yet. */
export function readSecretsText(dir: string) {
  try {
    return readPrivateText(secretsPath(dir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw invalid();
  }
}

/**
 * Remove every line of a changed key (comments and other keys stay as they
 * are), then append the new values. The result must parse back to exactly the
 * intended map, otherwise nothing is written.
 */
export function updateSecretsText(
  original: string | null,
  values: Readonly<Record<string, string>>,
  clear: readonly string[],
) {
  const before = original === null ? {} : parseSecretsText(original);
  const touched = new Set([...Object.keys(values), ...clear]);
  const lines = (original ?? "").split(/\r?\n/u).filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return true;
    const key = trimmed.slice(0, trimmed.indexOf("=")).trim();
    return !touched.has(key);
  });
  while (lines.length && lines.at(-1) === "") lines.pop();
  for (const [key, value] of Object.entries(values))
    lines.push(`${key}=${value}`);
  const text = lines.length ? `${lines.join("\n")}\n` : "";
  const expected = plannedSecrets(before, { clear: [...clear] }, {});
  Object.assign(expected, values);
  const parsed = parseSecretsText(text);
  if (
    Object.keys(parsed).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([k, v]) => parsed[k] !== v)
  )
    throw invalid("secrets");
  return text;
}

const fileId = (path: string) => {
  const s = statSync(path, { bigint: true, throwIfNoEntry: false });
  return s ? `${s.dev}:${s.ino}` : "absent";
};
/** Changes on any write to the file, in place or by rename. */
const fileStamp = (path: string) => {
  const s = statSync(path, { bigint: true, throwIfNoEntry: false });
  return s ? `${s.dev}:${s.ino}:${s.size}:${s.ctimeNs}:${s.mtimeNs}` : "absent";
};
const textDigest = (path: string) => {
  try {
    return createHash("sha256")
      .update(readFileSync(path, "utf8"))
      .digest("hex");
  } catch {
    return null;
  }
};

export interface SecretsWrite {
  readonly operation: string;
  readonly original: string | null;
  readonly text: string;
  /** The launch.yaml this write belongs to; `null` for a secrets-only change. */
  readonly yaml: { readonly path: string; readonly after: string } | null;
  /** Rows committed with the intent, before any rename (audit, receipt). */
  readonly reserve: () => void;
}

/**
 * V-2708: atomically replace secrets.env (0600, the old file kept next to it
 * as a backup) with a durable intent recorded *before* the rename. The intent
 * names files by inode and hashes only launch.yaml text, never secrets.env
 * content. `settleSecretIntents` decides from the files alone whether the
 * operation took effect, so an audit or commit failure after the rename, or a
 * crash between the secrets and YAML renames, always ends either fully
 * applied (with its audit rows) or fully undone (without them).
 *
 * Returns the launch files stamp right after the rename, taken under the same
 * write lock: the YAML step must match it exactly, so any other writer's
 * change between the two steps makes that step stale.
 */
export function installSecrets(
  store: Store,
  dir: string,
  dataDir: string,
  fence: LaunchFence,
  write: SecretsWrite,
): string {
  const path = secretsPath(dir),
    suffix = randomUUID(),
    temp = `${path}.${suffix}.tmp`,
    backup = write.original === null ? null : `${path}.${suffix}.bak`,
    opts = { flag: "wx", mode: 0o600 } as const;
  const current = () => {
    try {
      assertLaunchFence(store, dir, dataDir, fence);
    } catch {
      throw stale();
    }
    if (readSecretsText(dir) !== write.original) throw stale();
  };
  let reserved = false;
  try {
    if (backup !== null) writeFileSync(backup, write.original ?? "", opts);
    writeFileSync(temp, write.text, opts);
    store.uow.run(() => {
      current();
      store.database
        .prepare(
          "INSERT INTO launch_secret_intents(operation,path,temp_path,after_id,backup_path,yaml_path,yaml_after,created_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          write.operation,
          path,
          temp,
          fileId(temp),
          backup,
          write.yaml?.path ?? null,
          write.yaml?.after ?? null,
          new Date().toISOString(),
        );
      write.reserve();
    });
    reserved = true;
    return store.uow.run(() => {
      current();
      // Another process may have settled (undone) this intent meanwhile.
      if (
        !store.database
          .prepare("SELECT 1 FROM launch_secret_intents WHERE operation=?")
          .get(write.operation)
      )
        throw stale();
      renameSync(temp, path);
      // A rename can touch ctime: record the installed file as it is now, so
      // a later in-place edit by someone else is never taken for ours.
      store.database
        .prepare(
          "UPDATE launch_secret_intents SET after_stamp=? WHERE operation=?",
        )
        .run(fileStamp(path), write.operation);
      const files = launchFilesStamp(dir);
      if (!write.yaml) settleIntent(store, write.operation);
      return files;
    });
  } catch (error) {
    // Decide from the files, before the temp file is removed.
    let outcome: Outcome | undefined;
    if (reserved)
      try {
        outcome = settleSecrets(store, write.operation);
      } catch {
        throw new SecretsUnsettled();
      }
    if (outcome === "applied" && !write.yaml) return launchFilesStamp(dir);
    throw error;
  } finally {
    rmSync(temp, { force: true });
    if (!reserved && backup !== null) rmSync(backup, { force: true });
  }
}

type Outcome = "applied" | "undone" | "none";
/**
 * Settle one intent from the files (call under the store's write lock).
 * A secrets-only write stands once renamed. A write with a YAML stands only
 * if that YAML is installed; otherwise secrets.env goes back to its backup,
 * but only while it is still the file this operation installed.
 */
function settleIntent(store: Store, operation: string): Outcome {
  const row = store.database
    .prepare("SELECT * FROM launch_secret_intents WHERE operation=?")
    .get(operation);
  if (!row) return "none";
  const path = String(row.path),
    temp = String(row.temp_path),
    ours =
      typeof row.after_stamp === "string"
        ? fileStamp(path) === row.after_stamp
        : fileId(path) === row.after_id;
  const renamed = ours || fileId(temp) !== row.after_id;
  const applied =
    renamed &&
    (row.yaml_path === null ||
      textDigest(String(row.yaml_path)) === row.yaml_after);
  if (applied) {
    if (row.yaml_path === null)
      store.database
        .prepare("UPDATE launch_web_changes SET installed=1 WHERE operation=?")
        .run(operation);
  } else {
    if (renamed && ours) {
      if (typeof row.backup_path === "string")
        renameSync(row.backup_path, path);
      else rmSync(path, { force: true });
    }
    rmSync(temp, { force: true });
    // Never renamed: the backup is just a copy of the file still in place.
    if (!renamed && typeof row.backup_path === "string")
      rmSync(row.backup_path, { force: true });
    store.database
      .prepare("DELETE FROM launch_secret_changes WHERE operation=?")
      .run(operation);
    if (row.yaml_path === null)
      store.database
        .prepare(
          "DELETE FROM launch_web_changes WHERE operation=? AND installed=0",
        )
        .run(operation);
  }
  store.database
    .prepare("DELETE FROM launch_secret_intents WHERE operation=?")
    .run(operation);
  return applied ? "applied" : "undone";
}

/** Settle one operation now (after its YAML step succeeded or failed). */
export function settleSecrets(store: Store, operation: string): Outcome {
  return store.uow.run(() => settleIntent(store, operation));
}

/** The intent could not be settled now; the next read settles it. */
export class SecretsUnsettled extends Error {}

/** Settle whatever an interrupted confirmation left behind; run before every read. */
export function settleSecretIntents(store: Store) {
  const rows = store.database
    .prepare("SELECT operation FROM launch_secret_intents")
    .all();
  for (const row of rows) settleSecrets(store, String(row.operation));
}

/** When each key was last written from the Web; keys set by hand have none. */
export function secretTimes(store: Store) {
  const rows = store.database
    .prepare(
      "SELECT key, MAX(created_at) AS at FROM launch_secret_changes GROUP BY key",
    )
    .all();
  return new Map(rows.map((r) => [String(r.key), String(r.at)]));
}
