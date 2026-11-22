import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Node reports the main module by its real path; argv[1] may be a symlink. */
export function isCliEntry(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}
