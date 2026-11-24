import { useCallback } from "react";
import { routeHash } from "../route.js";
import {
  httpSharedFiles,
  type SharedFilesClient,
} from "../shared-files-api.js";
import { useResource } from "../useResource.js";

/**
 * C-717: where a file over the attachment limit can go instead. The shared
 * file library (C-685) takes large files straight to private storage when
 * that storage is configured; otherwise the host operator places the file in
 * the worker's managed directory. Shown after an oversize refusal only, so
 * the library is asked only then. The link opens a new tab and keeps the
 * draft.
 */
export function LargeFileRoute({
  projectId,
  client = httpSharedFiles,
}: {
  readonly projectId: string;
  readonly client?: Pick<SharedFilesClient, "list">;
}) {
  const load = useCallback(() => client.list(""), [client]);
  const library = useResource(load);
  if (library.data?.availability === "ready")
    return (
      <>
        可以改传到
        <a
          href={routeHash({ kind: "shared-files", projectId })}
          target="_blank"
          rel="noopener"
        >
          共享文件库
        </a>
      </>
    );
  if (library.pending) return null;
  return <>请找主机运维放到 worker 受管目录</>;
}
