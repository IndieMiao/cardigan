import {
  type Clock,
  type ProjectId,
  reconcileStorageCorsAction,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";
import type { OffsiteCorsReport } from "./offsite-sync.js";

/**
 * C-807: host-level notices (like deployment notices) live in the platform
 * project. Without it there is nowhere to put the to-do; the health page and
 * the shared files page still show the refusal.
 */
export const STORAGE_NOTICE_PROJECT = "cardigan";

/** Open, refresh or close the owner's storage CORS to-do for one report. */
export function recordStorageCors(
  store: Pick<Store, "listProjects" | "uow">,
  report: OffsiteCorsReport,
  clock: Clock,
  project: ProjectId = STORAGE_NOTICE_PROJECT as ProjectId,
) {
  if (!store.listProjects().some((p) => p.id === project)) return;
  store.uow.run((tx) => {
    const effect = unwrap(
      reconcileStorageCorsAction(
        loadCommandState(tx, project),
        { kind: "system", project_id: project },
        report,
        { ids: tx.ids, clock },
      ),
    );
    persistEffect(tx, project, effect);
  });
}
