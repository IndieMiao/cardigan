import type { HumanAction } from "./entities.js";

export const isMergePrerequisite = (
  action: Pick<HumanAction, "blocks_merge" | "prerequisite">,
) =>
  action.blocks_merge === true &&
  ["credential", "external_account"].includes(action.prerequisite ?? "");
