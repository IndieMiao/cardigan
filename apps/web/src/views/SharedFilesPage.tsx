import { type DragEvent, useCallback, useState } from "react";
import { describeError } from "../api.js";
import { EmptyState, Time } from "../components/Foundation.js";
import {
  DataTableCell,
  DataTableLayout,
} from "../components/layout/DataTableLayout.js";
import { PageHeader } from "../components/layout/PageHeader.js";
import {
  SettingsDialogActions,
  SettingsDialogFields,
  settingsDialogClassName,
} from "../components/layout/SettingsLayout.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog.js";
import { FilePicker } from "../components/ui/file-picker.js";
import { Input } from "../components/ui/input.js";
import {
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.js";
import { routeHash, useRouteFilters } from "../route.js";
import {
  formatBytes,
  httpSharedFiles,
  type SharedFileEntry,
  type SharedFilesClient,
  type SharedVersion,
  sharedActorLabel,
} from "../shared-files-api.js";
import { useResource } from "../useResource.js";

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * C-685: the cross-project shared file library. Browse directories, drop or
 * pick files to upload (straight to OSS), download, create directories, see
 * versions, and delete (people only). The same library is visible from every
 * project; the route only keeps the current directory.
 */
export function SharedFilesPage({
  projectId,
  client = httpSharedFiles,
}: {
  readonly projectId: string;
  readonly client?: SharedFilesClient;
}) {
  const [filters, setFilters] = useRouteFilters({
    kind: "shared-files",
    projectId,
  });
  const dir = filters.path ?? "";
  const load = useCallback(() => client.list(dir), [client, dir]);
  const listing = useResource(load);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [newDir, setNewDir] = useState("");
  const [history, setHistory] = useState<{
    file: SharedFileEntry;
    versions?: readonly SharedVersion[];
  }>();
  const [removing, setRemoving] = useState<{
    path: string;
    kind: "file" | "dir";
  }>();
  const ready = listing.data?.availability === "ready";
  const go = (path: string) => setFilters(path ? { path } : {});
  const href = (path: string) =>
    routeHash({
      kind: "shared-files",
      projectId,
      ...(path ? { filters: { path } } : {}),
    });

  async function act(label: string, work: () => Promise<void>) {
    setBusy(label);
    setError(undefined);
    setMessage(undefined);
    try {
      await work();
      return true;
    } catch (failure) {
      setError(describeError(failure));
      return false;
    } finally {
      setBusy(undefined);
      listing.reload();
    }
  }

  async function upload(files: readonly File[]) {
    if (!ready || busy) return;
    await act("上传", async () => {
      for (const file of files) {
        const path = join(dir, file.name);
        setBusy(`正在上传 ${file.name}`);
        const ticket = await client.beginUpload({
          path,
          size: file.size,
          ...(file.type ? { content_type: file.type } : {}),
        });
        await client.put(ticket, file, (fraction) =>
          setBusy(`正在上传 ${file.name}（${Math.floor(fraction * 100)}%）`),
        );
        await client.commit(ticket.upload_id);
      }
      setMessage(
        files.length === 1 ? "已上传" : `已上传 ${files.length} 个文件`,
      );
    });
  }

  const drop = {
    onDragOver: (event: DragEvent) => {
      if (ready && event.dataTransfer.types.includes("Files"))
        event.preventDefault();
    },
    onDrop: (event: DragEvent) => {
      if (!ready) return;
      event.preventDefault();
      void upload(Array.from(event.dataTransfer.files));
    },
  };

  const crumbs = dir ? dir.split("/") : [];
  const data = listing.data;
  return (
    <section className="ui-workspace" aria-label="共享文件" {...drop}>
      <PageHeader
        title="共享文件"
        showCapacity={false}
        actions={
          <>
            <FilePicker
              label="上传"
              disabled={!ready || busy !== undefined}
              onFiles={(files) => void upload(files)}
            />
            <Button
              type="button"
              variant="ghost"
              disabled={!ready || busy !== undefined}
              onClick={() => {
                setNewDir("");
                setMkdirOpen(true);
              }}
            >
              新建目录
            </Button>
          </>
        }
      />
      {data && <p className="empty">{data.notice}</p>}
      <nav aria-label="目录">
        <a href={href("")}>全部</a>
        {crumbs.map((name, index) => {
          const path = crumbs.slice(0, index + 1).join("/");
          return (
            <span key={path}>
              {" / "}
              <a href={href(path)}>{name}</a>
            </span>
          );
        })}
      </nav>
      <RequestFeedback
        pending={listing.pending || busy !== undefined}
        interactive={listing.interactive || busy !== undefined}
        pendingMessage={busy ?? "正在加载…"}
        message={message}
        error={error ?? listing.error}
        retry={listing.reload}
      />
      {data && data.availability !== "ready" && (
        <EmptyState>
          {data.availability === "not_configured"
            ? "未配置私有存储"
            : "私有存储暂不可达"}
        </EmptyState>
      )}
      {data && data.dirs.length === 0 && data.files.length === 0 && (
        <EmptyState>没有文件</EmptyState>
      )}
      {data && (data.dirs.length > 0 || data.files.length > 0) && (
        <DataTableLayout stacked label="文件列表">
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>大小</TableHead>
              <TableHead>更新</TableHead>
              <TableHead>写入者</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.dirs.map((entry) => (
              <TableRow key={`d:${entry.path}`}>
                <DataTableCell data-label="名称">
                  <a
                    href={href(entry.path)}
                    onClick={(event) => {
                      event.preventDefault();
                      go(entry.path);
                    }}
                  >
                    {baseName(entry.path)}/
                  </a>
                </DataTableCell>
                <DataTableCell data-label="大小">—</DataTableCell>
                <DataTableCell data-label="更新" nowrap>
                  <Time value={entry.created_at} relative />
                </DataTableCell>
                <DataTableCell data-label="写入者">
                  {sharedActorLabel(entry.created_by)}
                </DataTableCell>
                <DataTableCell data-label="操作">
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy !== undefined}
                    onClick={() =>
                      setRemoving({ path: entry.path, kind: "dir" })
                    }
                  >
                    删除
                  </Button>
                </DataTableCell>
              </TableRow>
            ))}
            {data.files.map((file) => (
              <TableRow key={`f:${file.path}`}>
                <DataTableCell data-label="名称">{file.name}</DataTableCell>
                <DataTableCell data-label="大小" nowrap>
                  {formatBytes(file.current.size)}
                </DataTableCell>
                <DataTableCell data-label="更新" nowrap>
                  <Time value={file.current.committed_at} relative />
                </DataTableCell>
                <DataTableCell data-label="写入者">
                  {sharedActorLabel(file.current.created_by)}
                </DataTableCell>
                <DataTableCell data-label="操作">
                  {ready && (
                    <Button asChild variant="ghost">
                      <a href={client.downloadHref(file.path)}>下载</a>
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setHistory({ file });
                      client.versions(file.path).then(
                        (result) =>
                          setHistory((old) =>
                            old?.file.path === file.path
                              ? { file, versions: result.versions }
                              : old,
                          ),
                        (failure) => setError(describeError(failure)),
                      );
                    }}
                  >
                    版本（{file.version_count}）
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy !== undefined}
                    onClick={() =>
                      setRemoving({ path: file.path, kind: "file" })
                    }
                  >
                    删除
                  </Button>
                </DataTableCell>
              </TableRow>
            ))}
          </TableBody>
        </DataTableLayout>
      )}
      <Dialog
        open={mkdirOpen}
        onOpenChange={(open) => !busy && setMkdirOpen(open)}
      >
        <DialogContent className={settingsDialogClassName}>
          <DialogTitle>新建目录</DialogTitle>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              const name = newDir.trim();
              if (!name || busy) return;
              if (await act("新建目录", () => client.mkdir(join(dir, name))))
                setMkdirOpen(false);
            }}
          >
            <SettingsDialogFields>
              <label>
                目录名
                <Input
                  value={newDir}
                  autoFocus
                  disabled={busy !== undefined}
                  onChange={(event) => setNewDir(event.target.value)}
                />
              </label>
            </SettingsDialogFields>
            <SettingsDialogActions>
              <Button
                type="submit"
                disabled={!newDir.trim() || busy !== undefined}
              >
                创建
              </Button>
            </SettingsDialogActions>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={removing !== undefined}
        onOpenChange={(open) => !open && !busy && setRemoving(undefined)}
      >
        <DialogContent className={settingsDialogClassName}>
          <DialogTitle>
            删除{removing?.kind === "dir" ? "目录" : "文件"}“
            {removing ? baseName(removing.path) : ""}”
          </DialogTitle>
          <SettingsDialogActions>
            <Button
              type="button"
              variant="destructive"
              disabled={busy !== undefined}
              onClick={async () => {
                if (!removing) return;
                if (
                  await act("删除", () =>
                    client.remove(removing.path, removing.kind),
                  )
                )
                  setRemoving(undefined);
              }}
            >
              删除
            </Button>
          </SettingsDialogActions>
        </DialogContent>
      </Dialog>
      <Dialog
        open={history !== undefined}
        onOpenChange={(open) => !open && setHistory(undefined)}
      >
        <DialogContent className={settingsDialogClassName}>
          <DialogTitle>{history?.file.name} 的版本</DialogTitle>
          {history && !history.versions && <p className="empty">正在加载…</p>}
          {history?.versions && (
            <DataTableLayout stacked label="版本">
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>写入者</TableHead>
                  <TableHead>大小</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.versions.map((version) => (
                  <TableRow key={version.id}>
                    <DataTableCell data-label="时间" nowrap>
                      <Time value={version.committed_at} />
                    </DataTableCell>
                    <DataTableCell data-label="写入者">
                      {sharedActorLabel(version.created_by)}
                    </DataTableCell>
                    <DataTableCell data-label="大小" nowrap>
                      {formatBytes(version.size)}
                    </DataTableCell>
                    <DataTableCell data-label="操作">
                      {ready && (
                        <Button asChild variant="ghost">
                          <a
                            href={client.downloadHref(
                              history.file.path,
                              version.id,
                            )}
                          >
                            下载
                          </a>
                        </Button>
                      )}
                    </DataTableCell>
                  </TableRow>
                ))}
              </TableBody>
            </DataTableLayout>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
