import type { HumanAction } from "./entities.js";

/** Explicit legacy holds stay effective until a human or PM reclassifies them. */
export const isMergePrerequisite = (
  action: Pick<HumanAction, "blocks_merge" | "prerequisite">,
) =>
  action.blocks_merge === true &&
  (action.prerequisite === undefined ||
    ["credential", "external_account"].includes(action.prerequisite));
