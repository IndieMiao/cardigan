import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  assertLaunchFence,
  type LaunchFence,
  launchFileStamp,
  withSecretsStamp,
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
 * Q-1094 / Q-1095, state matrix C-549#263 / #264 / #267.
 *
 * One commit point per confirmation. A value only ever goes to a brand-new
 * key; the YAML rename (proved only by the host's receipt) commits it.
 * Clearing keys (never with a YAML change) commits by the secrets.env rename.
 *
 * Ownership is proved by file identity, never by values or paths:
 * - each operation first creates its own empty staging directory and records
 *   its device/inode before any secret byte is written (R1', #267);
 * - whether secrets.env was renamed is read from inode identity (R2');
 * - a key is removed only while secrets.env is still exactly the file this
 *   operation installed (inode and stamp recorded with the rename) and
 *   nothing references it (R1').
 * Only intents whose owner has released them, or whose owner process is gone,
 * are settled by anyone else (R3'). Audit rows are never deleted (#252).
 *
 * Single writer (C-549#300 / #320): Workbench confirmations run one at a
 * time in this process (`serialSecrets`). secrets.env is not written
 * concurrently from elsewhere; when an outside change is detected the
 * operation stops: no YAML publication, no key removed, and the outside file
 * is never taken as this operation's result.
 *
 * Settling has three steps (#320): the outcome (audit, receipts, `resolved`)
 * is committed on its own and never changes; then key clean-up, whose temp
 * file lives in the operation's own staging directory (`keys_done`); then the
 * staging directory goes, and only after that the intent row. A failure in a
 * later step is retried by the next settle and never alters the outcome.
 */
export type Outcome = "applied" | "failed" | "unconfirmed" | "pending";
type Phase = "reserving" | "staging" | "prepared" | "renamed" | "yaml_reserved";
type Intent = {
  operation: string;
  kind: "write" | "clear";
  path: string;
  staging: string;
  staging_id: string | null;
  temp_id: string | null;
  after_stamp: string | null;
  phase: Phase;
  keys: string[];
  old_keys: string[];
  owner_token: string;
  owner_pid: number;
  owner_start: string;
  released: boolean;
  resolved: Outcome | null;
  keys_done: boolean;
};

/** This process; an intent owned by it and still executing is never settled. */
const TOKEN = randomUUID();
const active = new Set<string>();
function startTime(pid: number) {
  try {
    // Field 22 of /proc/<pid>/stat, after the parenthesised command name.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
  } catch {
    return "";
  }
}
const START = startTime(process.pid);
function ownerGone(i: Intent) {
  if (i.owner_token === TOKEN) return false;
  try {
    process.kill(i.owner_pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  // Alive pid: the same process only if its start time matches.
  const now = startTime(i.owner_pid);
  return !!i.owner_start && !!now && now !== i.owner_start;
}
/** R3': released, owner gone, or owned here but no longer executing. */
const settleable = (i: Intent) =>
  i.released ||
  ownerGone(i) ||
  (i.owner_token === TOKEN && !active.has(i.operation));

const fileId = (path: string) => {
  const s = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return s ? `${s.dev}:${s.ino}` : null;
};
/**
 * The same sample the launch fence takes (V-2753:2); `null` only when the
 * file is absent. Any other error throws: it proves nothing about the file.
 */
const fileStamp = (path: string) => {
  try {
    return launchFileStamp(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

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
    staging: String(r.staging),
    staging_id: r.staging_id === null ? null : String(r.staging_id),
    temp_id: r.temp_id === null ? null : String(r.temp_id),
    after_stamp: r.after_stamp === null ? null : String(r.after_stamp),
    phase: String(r.phase) as Phase,
    keys: JSON.parse(String(r.keys)) as string[],
    old_keys: JSON.parse(String(r.old_keys)) as string[],
    owner_token: String(r.owner_token),
    owner_pid: Number(r.owner_pid),
    owner_start: String(r.owner_start),
    released: !!r.released,
    resolved: r.resolved === null ? null : (String(r.resolved) as Outcome),
    keys_done: !!r.keys_done,
  }));
}

/** New keys of writes not known to be in effect: nobody may reference them. */
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

/** The staging directory, only while it is still the one this operation made. */
function ownStaging(i: Intent) {
  return i.staging_id !== null && fileId(i.staging) === i.staging_id
    ? i.staging
    : null;
}
const stagedTemp = (dir: string) => join(dir, "secrets.env");
const stagedBackup = (dir: string) => join(dir, "backup");

const stagedCleanup = (dir: string) => join(dir, "cleanup");
const readText = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** Retry the clean-up later: nothing proves the file changed (V-2753:1). */
class CleanupRetry extends Error {}

/**
 * The text of a file this clean-up still owns. A read that fails is not a
 * change: it throws (retry), unless a fresh check proves the file is no
 * longer ours (`null`: keep every key, the clean-up ends).
 */
function readOwn(path: string, ours: () => boolean) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !ours())
      return null;
    throw new CleanupRetry("secrets.env unreadable", { cause: error });
  }
}

/**
 * R1': remove `keys` only while secrets.env is still exactly the file this
 * operation installed and nothing references them (under the write lock).
 * The rewritten file is staged in the operation's own staging directory, so
 * an interrupted clean-up never leaves a copy anywhere else. Any outside
 * change seen before the rename keeps every key. Returns false, or throws,
 * when it must be retried later: a read that fails never ends it.
 */
function removeOwnKeys(
  store: Store,
  dir: string,
  i: Intent,
  keys: readonly string[],
) {
  const ours = () =>
    i.after_stamp !== null && fileStamp(i.path) === i.after_stamp;
  if (!keys.length || !ours()) return true; // not provably ours any more: keep
  const referenced = referencedKeys(dir);
  if (referenced === null) return false; // retry later
  const reserved = new Set(
    intents(store)
      .filter(
        (o) =>
          o.operation !== i.operation &&
          o.kind === "write" &&
          o.resolved !== "applied",
      )
      .flatMap((o) => o.keys),
  );
  const original = readOwn(i.path, ours);
  if (original === null || !ours()) return true; // provably changed: keep
  const present = parseSecretsText(original);
  const removable = keys.filter(
    (k) => Object.hasOwn(present, k) && !referenced.has(k) && !reserved.has(k),
  );
  if (!removable.length) return true;
  const staging = ownStaging(i);
  if (!staging) return true; // nowhere provably ours to stage it: keep
  const next = updateSecretsText(original, {}, removable);
  const temp = stagedCleanup(staging);
  // A copy left by an interrupted earlier attempt is this operation's own.
  rmSync(temp, { force: true });
  writeFileSync(temp, next, { flag: "wx", mode: 0o600 });
  const tempId = fileId(temp);
  // Last check before the rename: still our file, still the text we read.
  if (!ours() || readOwn(i.path, ours) !== original) {
    rmSync(temp, { force: true });
    return true;
  }
  renameSync(temp, i.path);
  const stamp = fileStamp(i.path);
  const still =
    fileId(i.path) === tempId &&
    readText(i.path) === next &&
    fileStamp(i.path) === stamp;
  store.database
    .prepare("UPDATE launch_secret_intents SET after_stamp=? WHERE operation=?")
    .run(still ? stamp : null, i.operation);
  return true;
}

const setAudit = (store: Store, operation: string, status: string) =>
  store.database
    .prepare("UPDATE launch_secret_changes SET status=? WHERE operation=?")
    .run(status, operation);

/**
 * Commit an outcome on its own (under the write lock): audit status, clear
 * receipts and `resolved`. Nothing after this changes them.
 */
function decide(store: Store, i: Intent, outcome: Outcome) {
  if (outcome === "pending" || i.resolved) return;
  setAudit(
    store,
    i.operation,
    outcome === "applied"
      ? "applied"
      : outcome === "failed"
        ? "not_applied"
        : "unconfirmed",
  );
  if (i.kind === "clear") {
    if (outcome === "applied")
      store.database
        .prepare("UPDATE launch_web_changes SET installed=1 WHERE operation=?")
        .run(i.operation);
    else if (outcome === "failed")
      store.database
        .prepare(
          "DELETE FROM launch_web_changes WHERE operation=? AND installed=0",
        )
        .run(i.operation);
  }
  store.database
    .prepare("UPDATE launch_secret_intents SET resolved=? WHERE operation=?")
    .run(outcome, i.operation);
}

/**
 * The retryable tail of a decided operation: key clean-up, then its own
 * staging directory, then the intent row (only once the directory is gone).
 * Throws when a step must be retried; the outcome stays as decided.
 */
function finish(store: Store, dir: string, operation: string) {
  store.uow.run(() => {
    const [i] = intents(store, operation);
    if (!i?.resolved || i.keys_done) return;
    const done =
      i.kind === "clear" ||
      removeOwnKeys(
        store,
        dir,
        i,
        i.resolved === "applied" ? i.old_keys : i.keys,
      );
    if (done)
      store.database
        .prepare(
          "UPDATE launch_secret_intents SET keys_done=1 WHERE operation=?",
        )
        .run(operation);
  });
  const [i] = intents(store, operation);
  if (!i?.resolved || !i.keys_done) return;
  if (i.staging_id === null) {
    // Identity never recorded, so no secret byte was ever written in it: an
    // empty directory may go, anything else is not ours and stays.
    try {
      rmdirSync(i.staging);
    } catch {
      /* absent, or not empty: not ours */
    }
  } else if (ownStaging(i)) rmSync(i.staging, { recursive: true, force: true });
  if (i.staging_id !== null && ownStaging(i)) return; // still there: retry
  store.database
    .prepare("DELETE FROM launch_secret_intents WHERE operation=?")
    .run(operation);
}

/** R2': what the files and receipts prove about one intent right now. */
function judge(store: Store, i: Intent): Outcome {
  if (i.resolved) return i.resolved;
  // The rename only ever happens after the temp file's inode is recorded.
  if (i.temp_id === null) return "failed";
  const staging = ownStaging(i);
  const renamed =
    fileId(i.path) === i.temp_id
      ? true
      : staging && fileId(stagedTemp(staging)) === i.temp_id
        ? false
        : null;
  if (i.kind === "clear")
    return renamed === true
      ? "applied"
      : renamed === false
        ? "failed"
        : "unconfirmed";
  if (renamed === false) return "failed";
  // The YAML rename only ever happens after its receipt was reserved.
  if (i.phase !== "yaml_reserved") return "failed";
  const receipt = store.database
    .prepare("SELECT installed FROM launch_web_changes WHERE operation=?")
    .get(i.operation);
  if (receipt?.installed) return "applied";
  if (receipt) return "pending";
  return "unconfirmed";
}

/**
 * Settle one operation now, if it may be settled; returns its outcome
 * (`pending` while it must be left alone). A decided outcome is returned as
 * it is; the clean-up after it is retried here and never changes it.
 */
export function settleSecrets(
  store: Store,
  dir: string,
  operation: string,
  force = false,
): Outcome | "none" {
  let tail = false;
  const outcome = store.uow.run(() => {
    const [i] = intents(store, operation);
    if (!i) return "none" as const;
    const may = force || settleable(i);
    if (i.resolved) {
      tail = may;
      return i.resolved;
    }
    if (!may) return "pending" as const;
    const result = judge(store, i);
    if (result === "pending") return result;
    decide(store, i, result);
    tail = true;
    return result;
  });
  if (tail) finishQuietly(store, dir, operation);
  return outcome;
}

/** Settle whatever earlier confirmations left (start-up, reads, confirmations). */
export function settleSecretIntents(store: Store, dir: string) {
  for (const { operation } of intents(store))
    try {
      settleSecrets(store, dir, operation);
    } catch {
      /* retried by the next settle */
    }
}

/**
 * Single writer (C-549#300): Workbench secrets confirmations for one
 * configuration directory run one at a time in this process.
 */
const queues = new Map<string, Promise<unknown>>();
export function serialSecrets<T>(dir: string, run: () => Promise<T>) {
  const key = realpathSync(dir);
  const result = (queues.get(key) ?? Promise.resolve()).then(run, run);
  const tail = result.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return result;
}

/** The outcome is not proved yet; a later settle decides (or keeps it). */
export class SecretsUnsettled extends Error {}

export interface Step {
  readonly operation: string;
  readonly original: string | null;
  /** Durable request identity (session + idempotency key digest) and version. */
  readonly requestKey: string;
  readonly snapshot: string;
  /** Rows committed with the intent (audit, receipt). */
  readonly reserve: () => void;
}

/**
 * The secrets.env step of one operation, in the confirmed order:
 * intent → own staging directory (identity recorded) → temp and backup
 * written in it → temp inode recorded → rename (stamp recorded). A failure
 * before the rename is recorded as such first, then the own staging
 * directory goes. Returns the launch files stamp taken right after the
 * rename under the same lock.
 */
function stageAndRename(
  store: Store,
  dir: string,
  dataDir: string,
  fence: LaunchFence,
  step: Step,
  kind: "write" | "clear",
  keys: readonly string[],
  oldKeys: readonly string[],
  text: string,
  afterRename: (i: Intent) => void,
): string {
  const path = secretsPath(dir),
    root = join(realpathSync(dir), ".secrets-staging"),
    staging = join(root, step.operation);
  const current = () => {
    try {
      assertLaunchFence(store, dir, dataDir, fence);
    } catch {
      throw stale();
    }
    if (readSecretsText(dir) !== step.original) throw stale();
  };
  const own = () => {
    const [i] = intents(store, step.operation);
    if (!i || i.resolved) throw stale();
    return i;
  };
  active.add(step.operation);
  store.uow.run(() => {
    current();
    store.database
      .prepare(
        "INSERT INTO launch_secret_intents(operation,kind,path,staging,phase,keys,old_keys,request_key,snapshot,owner_token,owner_pid,owner_start,created_at) VALUES(?,?,?,?,'reserving',?,?,?,?,?,?,?,?)",
      )
      .run(
        step.operation,
        kind,
        path,
        staging,
        JSON.stringify(keys),
        JSON.stringify(oldKeys),
        step.requestKey,
        step.snapshot,
        TOKEN,
        process.pid,
        START,
        new Date().toISOString(),
      );
    step.reserve();
  });
  let renamed = false;
  let stagingId: string | null = null;
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    // Exclusive: an existing path is never ours, never touched.
    mkdirSync(staging, { mode: 0o700 });
    stagingId = fileId(staging);
    store.uow.run(() => {
      own();
      store.database
        .prepare(
          "UPDATE launch_secret_intents SET staging_id=?, phase='staging' WHERE operation=?",
        )
        .run(stagingId, step.operation);
    });
    const opts = { flag: "wx", mode: 0o600 } as const;
    writeFileSync(stagedTemp(staging), text, opts);
    if (step.original !== null)
      writeFileSync(stagedBackup(staging), step.original, opts);
    const tempId = fileId(stagedTemp(staging));
    store.uow.run(() => {
      own();
      store.database
        .prepare(
          "UPDATE launch_secret_intents SET temp_id=?, phase='prepared' WHERE operation=?",
        )
        .run(tempId, step.operation);
    });
    const files = store.uow.run(() => {
      current();
      own();
      if (step.original !== null)
        renameSync(
          stagedBackup(staging),
          `${path}.${step.operation.replaceAll("-", "")}.bak`,
        );
      renameSync(stagedTemp(staging), path);
      renamed = true;
      // V-2748:1: only our own file, exactly as written and unchanged across
      // the check, is this operation's result; anything else stops it here.
      const stamp = fileStamp(path);
      const ours =
        stamp !== null &&
        fileId(path) === tempId &&
        readText(path) === text &&
        fileStamp(path) === stamp;
      store.database
        .prepare(
          "UPDATE launch_secret_intents SET after_stamp=?, phase='renamed' WHERE operation=?",
        )
        .run(ours ? stamp : null, step.operation);
      const [i] = intents(store, step.operation);
      if (!ours) {
        // Not ours: no YAML step, no key removed. A write did not take
        // effect; whether a clear still holds cannot be proved.
        if (i) decide(store, i, kind === "clear" ? "unconfirmed" : "failed");
        return null;
      }
      if (i) afterRename(i);
      // V-2753:2: the publication expects exactly what was verified: the
      // launch.yaml stamp current() just checked and the recorded stamp.
      return withSecretsStamp(fence.files, stamp);
    });
    if (files !== null) {
      // A clear is decided with its rename; its tail (staging) follows now.
      if (kind === "clear") finishQuietly(store, dir, step.operation);
      return files;
    }
  } catch (error) {
    if (!renamed) {
      // Proved: the rename never happened. Record that first; the own
      // staging directory goes only after (it is the proof until then).
      let recorded = false;
      try {
        recorded =
          settleSecrets(store, dir, step.operation, true) !== "pending";
      } catch {
        /* the staging directory stays as the proof */
      }
      if (!recorded) throw new SecretsUnsettled();
      throw error;
    }
    throw new SecretsUnsettled();
  }
  // An outside change was found right after the rename (decided above).
  finishQuietly(store, dir, step.operation);
  throw kind === "clear" ? new SecretsUnsettled() : stale();
}

function finishQuietly(store: Store, dir: string, operation: string) {
  try {
    finish(store, dir, operation);
  } catch {
    /* retried by the next settle; the outcome stands */
  }
}

/**
 * Add brand-new keys (absent, unreferenced, not pending) ahead of a YAML
 * publication. Nothing already in secrets.env changes, so the old launch.yaml
 * reads exactly the same secrets whatever happens next.
 */
export function addSecrets(
  store: Store,
  dir: string,
  dataDir: string,
  fence: LaunchFence,
  step: Step & {
    readonly values: Readonly<Record<string, string>>;
    readonly superseded: readonly string[];
  },
) {
  const before = step.original === null ? {} : parseSecretsText(step.original);
  if (Object.keys(step.values).some((k) => Object.hasOwn(before, k)))
    throw stale();
  return stageAndRename(
    store,
    dir,
    dataDir,
    fence,
    step,
    "write",
    Object.keys(step.values),
    step.superseded,
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
  stageAndRename(
    store,
    dir,
    dataDir,
    fence,
    step,
    "clear",
    step.keys,
    [],
    updateSecretsText(step.original, {}, step.keys),
    (i) => decide(store, i, "applied"),
  );
}

/** The YAML publication of `operation` reserved its receipt (same transaction). */
export function markYamlReserved(store: Store, operation: string) {
  store.database
    .prepare(
      "UPDATE launch_secret_intents SET phase='yaml_reserved' WHERE operation=?",
    )
    .run(operation);
}

/**
 * The request is over (whatever it answered): its intent, if any, may now be
 * settled by anyone (R3'). If this write fails, this process still settles it
 * because it is no longer executing.
 */
export function releaseSecrets(store: Store, operation: string) {
  active.delete(operation);
  try {
    store.database
      .prepare("UPDATE launch_secret_intents SET released=1 WHERE operation=?")
      .run(operation);
  } catch {
    /* the owner still settles it: it is no longer executing */
  }
}

/** R4': the durable record of a request (session + idempotency key). */
export function requestRecord(store: Store, requestKey: string) {
  const row = store.database
    .prepare(
      "SELECT operation, snapshot, status FROM launch_secret_changes WHERE request_key=? ORDER BY id DESC LIMIT 1",
    )
    .get(requestKey);
  return row
    ? {
        operation: String(row.operation),
        snapshot: String(row.snapshot),
        status: String(row.status),
      }
    : null;
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
