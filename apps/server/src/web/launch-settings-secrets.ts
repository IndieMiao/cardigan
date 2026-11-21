import { randomUUID } from "node:crypto";
import { realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

const MARKER = "# cardigan-write ";
const markerOf = (operation: string) => `${MARKER}${operation}`;
/** Whether secrets.env currently carries this operation's marker line. */
const marked = (text: string | null, operation: string) =>
  (text ?? "").split(/\r?\n/u).some((l) => l.trim() === markerOf(operation));

/**
 * Remove every line of a changed key (comments and other keys stay as they
 * are), then append the new values. The result must parse back to exactly the
 * intended map, otherwise nothing is written.
 *
 * V-2713: a write also carries one comment line naming its operation. Marker
 * lines of operations no longer pending (`keep`) are dropped.
 */
export function updateSecretsText(
  original: string | null,
  values: Readonly<Record<string, string>>,
  clear: readonly string[],
  /** `operation` adds its marker; markers not in `keep` are dropped. */
  marker?: { operation?: string; keep: ReadonlySet<string> },
) {
  const before = original === null ? {} : parseSecretsText(original);
  const touched = new Set([...Object.keys(values), ...clear]);
  const lines = (original ?? "").split(/\r?\n/u).filter((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith(MARKER))
      return !!marker?.keep.has(trimmed.slice(MARKER.length));
    if (!trimmed || trimmed.startsWith("#")) return true;
    const key = trimmed.slice(0, trimmed.indexOf("=")).trim();
    return !touched.has(key);
  });
  while (lines.length && lines.at(-1) === "") lines.pop();
  if (marker?.operation) lines.push(markerOf(marker.operation));
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

const pendingOperations = (store: Store) =>
  new Set(
    store.database
      .prepare("SELECT operation FROM launch_secret_intents")
      .all()
      .map((r) => String(r.operation)),
  );

function replaceFile(path: string, text: string) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

export interface SecretsWrite {
  readonly operation: string;
  readonly original: string | null;
  readonly values: Readonly<Record<string, string>>;
  readonly clear: readonly string[];
  /** A launch.yaml step follows (only brand-new keys, see `candidate`). */
  readonly yaml: boolean;
  /** Rows committed with the intent, before the rename (audit, receipt). */
  readonly reserve: () => void;
}

/**
 * V-2713: atomically replace secrets.env (0600, the old file kept next to it
 * as a backup). The new file carries a marker line naming this operation, and
 * an intent row (operation and path only; nothing derived from a value) is
 * committed with the audit rows before the rename. Whether the write took
 * effect is then read from the file itself: marker present ⇔ in effect.
 * Settling only fixes bookkeeping (audit rows, receipt); it never edits
 * secrets.env, so it cannot overwrite anyone else's change.
 *
 * Returns the launch files stamp right after the rename, taken under the same
 * write lock: the YAML step must match it exactly.
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
    const text = updateSecretsText(write.original, write.values, write.clear, {
      operation: write.operation,
      keep: pendingOperations(store),
    });
    if (backup !== null) writeFileSync(backup, write.original ?? "", opts);
    writeFileSync(temp, text, opts);
    store.uow.run(() => {
      current();
      store.database
        .prepare(
          "INSERT INTO launch_secret_intents(operation,path,temp_path,yaml,created_at) VALUES(?,?,?,?,?)",
        )
        .run(
          write.operation,
          path,
          temp,
          write.yaml ? 1 : 0,
          new Date().toISOString(),
        );
      write.reserve();
    });
    reserved = true;
    return store.uow.run(() => {
      current();
      // Another process may have settled this intent meanwhile.
      if (
        !store.database
          .prepare("SELECT 1 FROM launch_secret_intents WHERE operation=?")
          .get(write.operation)
      )
        throw stale();
      renameSync(temp, path);
      const files = launchFilesStamp(dir);
      if (!write.yaml) settleIntent(store, write.operation);
      return files;
    });
  } catch (error) {
    let outcome: Outcome | undefined;
    if (reserved)
      try {
        outcome = settleSecrets(store, write.operation);
      } catch {
        throw new SecretsUnsettled();
      }
    if (outcome === "applied") {
      // Renamed (the marker is in the file) but the commit failed.
      if (!write.yaml) return launchFilesStamp(dir);
      throw new SecretsUnsettled();
    }
    throw error;
  } finally {
    rmSync(temp, { force: true });
    if (!reserved && backup !== null) rmSync(backup, { force: true });
  }
}

type Outcome = "applied" | "undone" | "none";
/**
 * Settle one intent from the marker (under the store's write lock): present,
 * the write is in effect and its audit rows stay (a secrets-only write also
 * gets its receipt); absent, it never took effect (or was taken back) and its
 * audit rows and pending receipt go. The file is never touched here.
 */
function settleIntent(store: Store, operation: string): Outcome {
  const row = store.database
    .prepare("SELECT * FROM launch_secret_intents WHERE operation=?")
    .get(operation);
  if (!row) return "none";
  let text: string | null = null;
  try {
    text = readPrivateText(String(row.path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const applied = marked(text, operation);
  if (applied) {
    if (!row.yaml)
      store.database
        .prepare("UPDATE launch_web_changes SET installed=1 WHERE operation=?")
        .run(operation);
  } else {
    store.database
      .prepare("DELETE FROM launch_secret_changes WHERE operation=?")
      .run(operation);
    if (!row.yaml)
      store.database
        .prepare(
          "DELETE FROM launch_web_changes WHERE operation=? AND installed=0",
        )
        .run(operation);
  }
  rmSync(String(row.temp_path), { force: true });
  store.database
    .prepare("DELETE FROM launch_secret_intents WHERE operation=?")
    .run(operation);
  return applied ? "applied" : "undone";
}

/** Settle one operation now. */
export function settleSecrets(store: Store, operation: string): Outcome {
  return store.uow.run(() => settleIntent(store, operation));
}

/**
 * The YAML step of a write that added brand-new keys failed: take back exactly
 * those keys, and only while they still hold the values this operation wrote.
 * Everything else in secrets.env (another writer's keys, edits) stays. The
 * marker goes too, so a later settle drops the audit rows of what was removed.
 */
export function withdrawSecrets(
  store: Store,
  dir: string,
  operation: string,
  values: Readonly<Record<string, string>>,
) {
  store.uow.run(() => {
    const original = readSecretsText(dir);
    if (!marked(original, operation)) {
      settleIntent(store, operation);
      return;
    }
    const before = original === null ? {} : parseSecretsText(original);
    const ours = Object.keys(values).filter((k) => before[k] === values[k]);
    const keep = pendingOperations(store);
    keep.delete(operation);
    replaceFile(
      secretsPath(dir),
      updateSecretsText(original, {}, ours, { keep }),
    );
    const audit = store.database.prepare(
      "DELETE FROM launch_secret_changes WHERE operation=? AND key=?",
    );
    for (const key of ours) audit.run(operation, key);
    store.database
      .prepare("DELETE FROM launch_secret_intents WHERE operation=?")
      .run(operation);
  });
}

/** The intent could not be settled now; the next read settles it. */
export class SecretsUnsettled extends Error {}

/** Settle whatever an interrupted confirmation left behind (reads, start-up). */
export function settleSecretIntents(store: Store) {
  for (const operation of pendingOperations(store))
    settleSecrets(store, operation);
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
