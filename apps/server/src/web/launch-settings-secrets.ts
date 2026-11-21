import { randomUUID } from "node:crypto";
import { realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertLaunchFence, type LaunchFence } from "@cardigan/host";
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

/**
 * Atomically replace secrets.env (0600, backup of the old file kept next to
 * it). The rename happens under the store's write lock and only while the
 * launch files are exactly those the confirmation validated.
 */
export function installSecrets(
  store: Store,
  dir: string,
  dataDir: string,
  fence: LaunchFence,
  original: string | null,
  text: string,
  journal: () => void,
) {
  const path = secretsPath(dir),
    suffix = randomUUID(),
    temp = `${path}.${suffix}.tmp`,
    opts = { flag: "wx", mode: 0o600 } as const;
  if (original !== null) writeFileSync(`${path}.${suffix}.bak`, original, opts);
  try {
    writeFileSync(temp, text, opts);
    store.uow.run(() => {
      try {
        assertLaunchFence(store, dir, dataDir, fence);
      } catch {
        throw stale();
      }
      if (readSecretsText(dir) !== original) throw stale();
      renameSync(temp, path);
      journal();
    });
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Put back the file this confirmation replaced, unless someone changed it since. */
export function restoreSecrets(
  store: Store,
  dir: string,
  written: string,
  original: string | null,
) {
  const path = secretsPath(dir),
    temp = `${path}.${randomUUID()}.tmp`;
  try {
    store.uow.run(() => {
      if (readSecretsText(dir) !== written) return;
      if (original === null) rmSync(path, { force: true });
      else {
        writeFileSync(temp, original, { flag: "wx", mode: 0o600 });
        renameSync(temp, path);
      }
    });
  } finally {
    rmSync(temp, { force: true });
  }
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
