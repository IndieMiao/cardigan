import { randomBytes } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Generated Claude Code settings files are named
 * `cardigan-<pid>-<8 hex>.<profile>.claude-settings.json`.
 * The pid comes first so a later launch can tell whether the owner is alive.
 */
const SETTINGS_FILE_PATTERN =
  /^cardigan-(\d+)-([0-9a-f]{8})\..+\.claude-settings\.json$/;

/** `<pid>-<random hex>`: unique per launch, and carries the owner pid. */
export function newInstanceId(
  pid: number,
  randomHex: string = randomBytes(4).toString("hex"),
): string {
  if (!/^[0-9a-f]{8}$/.test(randomHex)) {
    throw new Error("randomHex must be 8 lowercase hex characters");
  }
  return `${pid}-${randomHex}`;
}

/** Owner pid of a generated settings file, or `undefined` for foreign files. */
export function parseSettingsFileOwner(
  fileName: string,
): { pid: number; instanceId: string } | undefined {
  const match = SETTINGS_FILE_PATTERN.exec(fileName);
  if (match === null) {
    return undefined;
  }
  const pid = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return undefined;
  }
  return { pid, instanceId: `${match[1]}-${match[2]}` };
}

/** Default liveness probe: signal 0 only checks that the pid exists. */
export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "EPERM"
    );
  }
}

export interface StaleSettingsScan {
  /** Absolute paths of settings files whose owner pid is gone. */
  readonly stale: readonly string[];
  /** Absolute paths of settings files owned by a live process. */
  readonly live: readonly string[];
}

/**
 * Scan the runtime directory for generated settings files and classify them by
 * whether the owning process still exists.
 */
export async function scanSettingsFiles(
  runtimeDir: string,
  isAlive: (pid: number) => boolean = defaultIsAlive,
): Promise<StaleSettingsScan> {
  let entries: string[];
  try {
    entries = await readdir(runtimeDir);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return { stale: [], live: [] };
    }
    throw error;
  }

  const stale: string[] = [];
  const live: string[] = [];
  for (const entry of entries) {
    const owner = parseSettingsFileOwner(entry);
    if (owner === undefined) {
      continue;
    }
    const path = join(runtimeDir, entry);
    if (isAlive(owner.pid)) {
      live.push(path);
    } else {
      stale.push(path);
    }
  }
  return { stale, live };
}

/**
 * Delete settings files left behind by processes that no longer exist. Called
 * at the start of every launch, so a killed process cannot leak secrets to
 * disk forever. Returns the paths that were removed.
 */
export async function removeStaleSettingsFiles(
  runtimeDir: string,
  isAlive: (pid: number) => boolean = defaultIsAlive,
): Promise<string[]> {
  const { stale } = await scanSettingsFiles(runtimeDir, isAlive);
  const removed: string[] = [];
  for (const path of stale) {
    try {
      await rm(path, { force: true });
      removed.push(path);
    } catch {
      // Best effort: a file we cannot remove is reported again next time.
    }
  }
  return removed;
}
