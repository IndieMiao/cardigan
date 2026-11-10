import { useCallback, useRef, useState } from "react";
import { type CardiganClient, describeError } from "./api.js";
import type { BoardLanes } from "./components/Board.js";
import { cardStatusLabel } from "./status.js";
import { useResource } from "./useResource.js";

/**
 * C-64: the human's lane folding, kept in the server-side project preferences
 * so it survives reloads, navigation and other devices. Clicks apply at once;
 * writes go out in click order and a failed write rolls back its own lane.
 */
export function useBoardLanes(client: CardiganClient, projectId: string) {
  const load = useCallback(
    () => client.preferences(projectId),
    [client, projectId],
  );
  const preferences = useResource(load);
  const [local, setLocal] = useState<{
    projectId: string;
    lanes: BoardLanes;
  }>({ projectId, lanes: {} });
  const [failure, setFailure] = useState<{
    projectId: string;
    message: string;
    retry: () => void;
  }>();
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const ownLanes = local.projectId === projectId ? local.lanes : {};
  const lanes: BoardLanes = {
    ...preferences.data?.board_collapsed_lanes,
    ...ownLanes,
  };
  const setLane = useCallback(
    (status: string, collapsed: boolean) => {
      setFailure(undefined);
      let previous: BoardLanes = {};
      setLocal((old) => {
        const current = old.projectId === projectId ? old.lanes : {};
        previous = current;
        return { projectId, lanes: { ...current, [status]: collapsed } };
      });
      const write = () =>
        client.setBoardLane(projectId, status, collapsed, crypto.randomUUID());
      queue.current = queue.current.then(write).catch((error: unknown) => {
        setLocal((old) => {
          // A later click on the same lane wins over this rollback.
          if (old.projectId !== projectId || old.lanes[status] !== collapsed)
            return old;
          const lanes = { ...old.lanes };
          if (Object.hasOwn(previous, status))
            lanes[status] = previous[status] === true;
          else delete lanes[status];
          return { projectId, lanes };
        });
        setFailure({
          projectId,
          message: `${cardStatusLabel(status)}列的折叠设置没有保存：${describeError(error)}`,
          retry: () => setLane(status, collapsed),
        });
      });
    },
    [client, projectId],
  );
  return {
    lanes,
    /** Wait for the saved setting so lanes do not jump after the first paint. */
    ready: preferences.data !== undefined || preferences.error !== undefined,
    setLane,
    error: failure?.projectId === projectId ? failure.message : undefined,
    retry: failure?.projectId === projectId ? failure.retry : undefined,
  };
}
