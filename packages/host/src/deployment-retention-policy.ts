/**
 * C-743: automatic retention of the deployment directory, applied after each
 * successful deployment. `mode: preview` records what would go and removes
 * nothing.
 */
export interface RetentionPolicy {
  /** Newest releases kept besides every release `state.json` references. */
  release_keep: number;
  /** Automatic database snapshots younger than this many days are kept. */
  backup_days: number;
  /** The newest snapshots kept regardless of age. */
  backup_min: number;
  mode: "auto" | "preview";
}
export const DEFAULT_RETENTION: RetentionPolicy = {
  release_keep: 10,
  backup_days: 7,
  backup_min: 3,
  mode: "auto",
};
/** C-520 manifest keys; still accepted so an existing host file parses. */
const LEGACY = new Set([
  "revision",
  "releases",
  "snapshots",
  "daily_days",
  "released_days",
  "approval",
]);

export function parseRetention(raw: unknown): RetentionPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid retention policy");
  const p = { ...DEFAULT_RETENTION };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (LEGACY.has(key)) continue;
    if (key === "mode") {
      if (value !== "auto" && value !== "preview")
        throw new Error("Invalid retention mode");
      p.mode = value;
      continue;
    }
    if (
      !["release_keep", "backup_days", "backup_min"].includes(key) ||
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > 36500
    )
      throw new Error("Invalid retention setting");
    p[key as "release_keep" | "backup_days" | "backup_min"] = value;
  }
  return p;
}
