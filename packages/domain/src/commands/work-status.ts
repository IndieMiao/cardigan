import type { WorkItem } from "../entities.js";

export const workCompleted = (item: WorkItem) =>
  item.kind === "produce"
    ? item.status === "accepted"
    : item.status === "passed";
