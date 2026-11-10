import type { ProjectId } from "./ids.js";

/** A missing project preference row is equivalent to disabled automation. */
export interface ProjectPreferences {
  readonly id: ProjectId;
  readonly auto_merge_after_minutes: number | null;
}

export function validAutoMergeMinutes(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= 1440)
  );
}
