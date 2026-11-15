import { createHash, randomUUID } from "node:crypto";
import { needsYouReadPhase, type ProjectId } from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";

/** Incremental source and discrete clock membership; no full page, TTL or write authority. */
export function readNeedsVersion(
  store: Store,
  project: ProjectId,
  context: string,
  now?: string,
  runtimeGrace?: number,
): string {
  return store.uow.read((tx) =>
    createHash("sha256")
      .update(
        JSON.stringify([
          project,
          store.snapshotVersion(project) ?? randomUUID(),
          context,
          now === undefined
            ? null
            : needsYouReadPhase(
                loadCommandState(tx, project),
                now,
                runtimeGrace,
              ),
        ]),
      )
      .digest("hex"),
  );
}
