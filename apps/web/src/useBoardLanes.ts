import { useCallback, useRef, useState } from "react";
import { type CardiganClient, describeError } from "./api.js";
import type { BoardLanes } from "./components/Board.js";
import { cardStatusLabel } from "./status.js";
import { useResource } from "./useResource.js";

interface LaneState {
  readonly projectId: string;
  /** Values the server accepted in this session, in write order. */
  readonly confirmed: BoardLanes;
  /** The latest click per lane while its write is unsettled. */
  readonly optimistic: BoardLanes;
  /** Lanes whose latest write failed, with the value the human wanted. */
  readonly failed: Readonly<
    Record<string, { collapsed: boolean; message: string }>
  >;
}

const empty = (projectId: string): LaneState => ({
  projectId,
  confirmed: {},
  optimistic: {},
  failed: {},
});

function without<T>(record: Readonly<Record<string, T>>, key: string) {
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * C-64: the human's lane folding, kept in the server-side project preferences
 * so it survives reloads, navigation and other devices. Clicks apply at once
 * and writes go out in click order, so the server ends on the last successful
 * write. Each lane carries an operation number: only the newest operation of
 * a lane may roll it back or report an error; older responses only update the
 * confirmed value.
 */
export function useBoardLanes(
  client: CardiganClient,
  projectId: string,
  revision = 0,
  enabled = true,
) {
  const load = useCallback(
    () => client.preferences(projectId),
    [client, projectId],
  );
  const preferences = useResource(load, revision, enabled);
  const [stored, setState] = useState<LaneState>(() => empty(projectId));
  const state = stored.projectId === projectId ? stored : empty(projectId);
  /** Responses that arrive after the project changed are dropped. */
  const update = useCallback(
    (change: (current: LaneState) => LaneState, start = false) =>
      setState((old) =>
        old.projectId === projectId
          ? change(old)
          : start
            ? change(empty(projectId))
            : old,
      ),
    [projectId],
  );
  const versions = useRef(new Map<string, number>());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const lanes: BoardLanes = {
    ...preferences.data?.board_collapsed_lanes,
    ...state.confirmed,
    ...state.optimistic,
  };
  const setLane = useCallback(
    (status: string, collapsed: boolean) => {
      const key = `${projectId}\u0000${status}`;
      const version = (versions.current.get(key) ?? 0) + 1;
      versions.current.set(key, version);
      const latest = () => versions.current.get(key) === version;
      update(
        (s) => ({
          ...s,
          optimistic: { ...s.optimistic, [status]: collapsed },
          failed: without(s.failed, status),
        }),
        true,
      );
      const write = () =>
        client.setBoardLane(projectId, status, collapsed, crypto.randomUUID());
      queue.current = queue.current.then(write).then(
        () =>
          update((s) => ({
            ...s,
            confirmed: { ...s.confirmed, [status]: collapsed },
            ...(latest() ? { optimistic: without(s.optimistic, status) } : {}),
          })),
        (error: unknown) => {
          // A newer click on this lane decides what the lane shows.
          if (!latest()) return;
          update((s) => ({
            ...s,
            optimistic: without(s.optimistic, status),
            failed: {
              ...s.failed,
              [status]: { collapsed, message: describeError(error) },
            },
          }));
        },
      );
    },
    [client, projectId, update],
  );
  const failed = Object.entries(state.failed);
  const retryWrites = useCallback(() => {
    for (const [status, { collapsed }] of Object.entries(state.failed))
      setLane(status, collapsed);
  }, [setLane, state.failed]);
  return {
    lanes,
    /** Wait for the first answer so lanes do not jump after the first paint. */
    ready: preferences.data !== undefined || preferences.error !== undefined,
    setLane,
    /** Saved lanes could not be read; the board shows the defaults meanwhile. */
    readError:
      preferences.error === undefined
        ? undefined
        : preferences.data === undefined
          ? `看板折叠设置读取失败，暂按默认显示：${preferences.error}`
          : `看板折叠设置刷新失败：${preferences.error}`,
    reload: preferences.reload,
    error: failed.length
      ? `${failed.map(([status]) => cardStatusLabel(status)).join("、")}列的折叠设置没有保存：${failed.at(-1)?.[1].message}`
      : undefined,
    retry: failed.length ? retryWrites : undefined,
  };
}
