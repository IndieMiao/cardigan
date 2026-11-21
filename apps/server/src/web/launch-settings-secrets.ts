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
import { parseDocument } from "yaml";
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

/*
 * Q-1094 / Q-1095: one commit point per confirmation.
 *
 * - Writing a value only ever adds a brand-new key to secrets.env; the
 *   Provider's reference moves to it in launch.yaml. The YAML rename is the
 *   commit point and only the host's publication receipt proves success.
 * - Clearing keys (no YAML change) commits by the secrets.env rename.
 *
 * Outcomes: applied (proved), failed (proved not to have happened), or
 * unconfirmed (anything else). Audit rows are never deleted; their status
 * follows the outcome. Keys are only ever removed when nothing in the
 * current launch.yaml references them, checked under the store's write lock.
 */
type Intent = {
  operation: string;
  kind: "write" | "clear";
  path: string;
  temp_path: string;
  keys: string[];
  old_keys: string[];
  yaml_before: string | null;
  resolved: Outcome | null;
};
export type Outcome = "applied" | "failed" | "unconfirmed" | "pending";

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const exists = (path: string) => statSync(path, { throwIfNoEntry: false });

function intents(store: Store, operation?: string): Intent[] {
  const rows = operation
    ? store.database
        .prepare("SELECT * FROM launch_secret_intents WHERE operation=?")
        .all(operation)
    : store.database.prepare("SELECT * FROM launch_secret_intents").all();
  return rows.map((r) => ({
    operation: String(r.operation),
    kind: r.kind === "clear" ? "clear" : "write",
    path: String(r.path),
    temp_path: String(r.temp_path),
    keys: JSON.parse(String(r.keys)) as string[],
    old_keys: JSON.parse(String(r.old_keys)) as string[],
    yaml_before: r.yaml_before === null ? null : String(r.yaml_before),
    resolved: r.resolved === null ? null : (String(r.resolved) as Outcome),
  }));
}

/** New keys of writes not yet known to be in effect: nobody may reference them. */
export function pendingKeys(store: Store) {
  return new Set(
    intents(store)
      .filter((i) => i.kind === "write" && i.resolved !== "applied")
      .flatMap((i) => i.keys),
  );
}

/** Every secrets.env key the current launch.yaml references; `null` if unreadable. */
function referencedKeys(dir: string): Set<string> | null {
  try {
    const doc = parseDocument(
      readFileSync(join(realpathSync(dir), "launch.yaml"), "utf8"),
      { prettyErrors: false },
    );
    if (doc.errors.length) return null;
    const providers = (doc.toJS() as { providers?: unknown })?.providers;
    const keys = new Set<string>();
    if (providers && typeof providers === "object")
      for (const p of Object.values(providers as Record<string, unknown>)) {
        const env = (p as { secret_env?: unknown } | null)?.secret_env;
        if (env && typeof env === "object")
          for (const v of Object.values(env as Record<string, unknown>))
            if (typeof v === "string") keys.add(v);
      }
    return keys;
  } catch {
    return null;
  }
}

const setAudit = (store: Store, operation: string, status: string) =>
  store.database
    .prepare("UPDATE launch_secret_changes SET status=? WHERE operation=?")
    .run(status, operation);

/**
 * Close one intent with its outcome (under the write lock). Keys this outcome
 * makes removable go only if nothing references them now; when that cannot be
 * read, the intent stays (resolved) and the next settle retries.
 */
function close(store: Store, dir: string, intent: Intent, outcome: Outcome) {
  if (outcome === "pending") return;
  setAudit(
    store,
    intent.operation,
    outcome === "applied"
      ? "applied"
      : outcome === "failed"
        ? "not_applied"
        : "unconfirmed",
  );
  if (intent.kind === "clear") {
    if (outcome === "applied")
      store.database
        .prepare("UPDATE launch_web_changes SET installed=1 WHERE operation=?")
        .run(intent.operation);
    else if (outcome === "failed")
      store.database
        .prepare(
          "DELETE FROM launch_web_changes WHERE operation=? AND installed=0",
        )
        .run(intent.operation);
    store.database
      .prepare("DELETE FROM launch_secret_intents WHERE operation=?")
      .run(intent.operation);
    return;
  }
  // A write: the superseded keys after success, its own new keys otherwise.
  const candidates = outcome === "applied" ? intent.old_keys : intent.keys;
  const referenced = referencedKeys(dir);
  if (candidates.length && referenced === null) {
    store.database
      .prepare("UPDATE launch_secret_intents SET resolved=? WHERE operation=?")
      .run(outcome, intent.operation);
    return;
  }
  store.database
    .prepare("DELETE FROM launch_secret_intents WHERE operation=?")
    .run(intent.operation);
  const reserved = pendingKeys(store);
  const original = readSecretsText(dir);
  const present = original === null ? {} : parseSecretsText(original);
  const removable = candidates.filter(
    (k) => Object.hasOwn(present, k) && !referenced?.has(k) && !reserved.has(k),
  );
  if (removable.length)
    replaceFile(secretsPath(dir), updateSecretsText(original, {}, removable));
}

/** What the files and receipts prove about one intent right now. */
function judge(store: Store, dir: string, intent: Intent): Outcome {
  if (intent.resolved) return intent.resolved;
  if (intent.kind === "clear") {
    // The rename moves the temp file away, and it is only ever deleted after
    // the outcome is recorded: still there, the rename never happened.
    if (exists(intent.temp_path)) return "failed";
    const text = readSecretsText(dir);
    const present = text === null ? {} : parseSecretsText(text);
    return intent.keys.every((k) => !Object.hasOwn(present, k))
      ? "applied"
      : "unconfirmed";
  }
  const receipt = store.database
    .prepare("SELECT installed FROM launch_web_changes WHERE operation=?")
    .get(intent.operation);
  if (receipt?.installed) return "applied";
  if (receipt) return "pending";
  // No receipt is not proof by itself; launch.yaml still being exactly the
  // text this write started from is.
  try {
    const yaml = readFileSync(join(realpathSync(dir), "launch.yaml"), "utf8");
    if (intent.yaml_before !== null && sha256(yaml) === intent.yaml_before)
      return "failed";
  } catch {
    /* unreadable: not proof either way */
  }
  return "unconfirmed";
}

/** Settle one operation now; returns its outcome. */
export function settleSecrets(
  store: Store,
  dir: string,
  operation: string,
): Outcome | "none" {
  return store.uow.run(() => {
    const [intent] = intents(store, operation);
    if (!intent) return "none";
    const outcome = judge(store, dir, intent);
    close(store, dir, intent, outcome);
    if (outcome !== "pending" && intent.kind === "write")
      rmSync(intent.temp_path, { force: true });
    if (outcome === "failed" && intent.kind === "clear")
      rmSync(intent.temp_path, { force: true });
    return outcome;
  });
}

/** Settle whatever earlier confirmations left (start-up, reads, confirmations). */
export function settleSecretIntents(store: Store, dir: string) {
  for (const { operation } of intents(store))
    settleSecrets(store, dir, operation);
}

function replaceFile(path: string, text: string) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** The outcome is not proved yet; the next settle decides (or keeps it). */
export class SecretsUnsettled extends Error {}

interface Step {
  readonly operation: string;
  readonly original: string | null;
  /** Rows committed with the intent, before any rename (audit, receipt). */
  readonly reserve: () => void;
}

/**
 * One atomic secrets.env replacement with its intent committed first. Before
 * the rename a failure is proved (recorded as failed, then the temp file
 * goes); after it, the caller decides. Returns the launch files stamp taken
 * right after the rename under the same lock.
 */
function replaceSecrets(
  store: Store,
  dir: string,
  dataDir: string,
  fence: LaunchFence,
  step: Step,
  intent: Omit<Intent, "operation" | "path" | "temp_path" | "resolved">,
  text: string,
  afterRename: () => void,
): string {
  const path = secretsPath(dir),
    suffix = randomUUID(),
    temp = `${path}.${suffix}.tmp`,
    backup = `${path}.${suffix}.bak`,
    opts = { flag: "wx", mode: 0o600 } as const;
  const current = () => {
    try {
      assertLaunchFence(store, dir, dataDir, fence);
    } catch {
      throw stale();
    }
    if (readSecretsText(dir) !== step.original) throw stale();
  };
  writeFileSync(temp, text, opts);
  let reserved = false,
    renamed = false;
  try {
    store.uow.run(() => {
      current();
      store.database
        .prepare(
          "INSERT INTO launch_secret_intents(operation,kind,path,temp_path,keys,old_keys,yaml_before,created_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          step.operation,
          intent.kind,
          path,
          temp,
          JSON.stringify(intent.keys),
          JSON.stringify(intent.old_keys),
          intent.yaml_before,
          new Date().toISOString(),
        );
      step.reserve();
    });
    reserved = true;
    return store.uow.run(() => {
      current();
      if (!intents(store, step.operation).length) throw stale();
      if (step.original !== null) writeFileSync(backup, step.original, opts);
      renameSync(temp, path);
      renamed = true;
      const files = launchFilesStamp(dir);
      afterRename();
      return files;
    });
  } catch (error) {
    if (!reserved) {
      rmSync(temp, { force: true });
      throw error;
    }
    if (!renamed) {
      // Proved: the rename never happened. Record that, then drop the temp.
      try {
        store.uow.run(() => {
          const [own] = intents(store, step.operation);
          if (own) close(store, dir, own, "failed");
        });
      } catch {
        throw new SecretsUnsettled(); // the temp file stays as the proof
      }
      rmSync(temp, { force: true });
      rmSync(backup, { force: true });
      throw error;
    }
    throw new SecretsUnsettled();
  }
}

/**
 * Add brand-new keys (absent and unreferenced) ahead of a YAML publication.
 * Nothing already in secrets.env changes, so the old launch.yaml reads exactly
 * the same secrets whatever happens next.
 */
export function addSecrets(
  store: Store,
  dir: string,
  dataDir: string,
  fence: LaunchFence,
  step: Step & {
    readonly values: Readonly<Record<string, string>>;
    readonly superseded: readonly string[];
    readonly yamlBefore: string;
  },
) {
  const before = step.original === null ? {} : parseSecretsText(step.original);
  if (Object.keys(step.values).some((k) => Object.hasOwn(before, k)))
    throw stale();
  return replaceSecrets(
    store,
    dir,
    dataDir,
    fence,
    step,
    {
      kind: "write",
      keys: Object.keys(step.values),
      old_keys: [...step.superseded],
      yaml_before: sha256(step.yamlBefore),
    },
    updateSecretsText(step.original, step.values, []),
    () => {},
  );
}

/** Remove keys with no YAML change; the secrets.env rename is the commit. */
export function clearSecrets(
  store: Store,
  dir: string,
  dataDir: string,
  fence: LaunchFence,
  step: Step & { readonly keys: readonly string[] },
) {
  replaceSecrets(
    store,
    dir,
    dataDir,
    fence,
    step,
    { kind: "clear", keys: [...step.keys], old_keys: [], yaml_before: null },
    updateSecretsText(step.original, {}, step.keys),
    () => {
      const [own] = intents(store, step.operation);
      if (own) close(store, dir, own, "applied");
    },
  );
}

/** The recorded state of a confirmation without a settled receipt. */
export function auditStatus(store: Store, operation: string) {
  const row = store.database
    .prepare(
      "SELECT status FROM launch_secret_changes WHERE operation=? LIMIT 1",
    )
    .get(operation);
  return row ? String(row.status) : null;
}

/** When each key was last written from the Web; keys set by hand have none. */
export function secretTimes(store: Store) {
  const rows = store.database
    .prepare(
      "SELECT key, MAX(created_at) AS at FROM launch_secret_changes WHERE status='applied' GROUP BY key",
    )
    .all();
  return new Map(rows.map((r) => [String(r.key), String(r.at)]));
}
