import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type AssignmentDiff,
  type CardiganClient,
  describeWriteError,
  type ExecutionAssignment,
  type RunView,
} from "../api.js";
import { IdTag } from "./Foundation.js";
import { DetailFact, DetailFacts } from "./layout/CardDetailLayout.js";
import { DialogFeedback } from "./layout/DialogFeedbackLayout.js";
import {
  DiffEmpty,
  DiffFile,
  DiffFileList,
  DiffGroup,
  DiffPatch,
  DiffSheetHeading,
  DiffSummary,
} from "./layout/WorktreeDiffLayout.js";
import { RequestFeedback } from "./RequestFeedback.js";
import { Button, IconButton } from "./ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.js";
import { CloseIcon } from "./ui/icons.js";
import { IdBadge } from "./ui/id-badge.js";
import { Sheet, SheetContent } from "./ui/sheet.js";

export type AssignmentOp = "start" | "restart" | "stop";

/**
 * C-703: start, restart and stop an Assignment from the Workbench. A write
 * goes out only on a click (stop: on the dialog's confirm); one at a time.
 * A failed attempt keeps its Idempotency-Key, so 重试 sends the same request;
 * a success drops it. The server's reason is shown as it is.
 */
export function useAssignmentOps(
  client: CardiganClient,
  projectId: string,
  a: ExecutionAssignment,
) {
  const [pending, setPending] = useState<AssignmentOp>();
  const [failure, setFailure] = useState<{ op: AssignmentOp; text: string }>();
  const [message, setMessage] = useState("");
  const keys = useRef(new Map<string, string>());
  const sending = useRef(false);
  const terminal = a.runtime_ref?.terminal_ref ?? "";
  const perform = async (op: AssignmentOp): Promise<boolean> => {
    if (sending.current) return false;
    sending.current = true;
    const request = JSON.stringify([op, projectId, a.id, terminal]);
    const key = keys.current.get(request) ?? crypto.randomUUID();
    keys.current.set(request, key);
    setPending(op);
    setFailure(undefined);
    setMessage("");
    try {
      if (op === "stop") {
        const result = await client.stopAssignment(projectId, a.id, key);
        setMessage(
          result.stale
            ? `${a.id} 的会话已变化，没有改动`
            : result.released
              ? `已停止 ${a.id}：终端已释放${result.aborted ? "，当前执行已取消" : ""}`
              : `已停止 ${a.id}：排队的执行已取消`,
        );
      } else {
        const result = await client.startAssignment(
          projectId,
          a.id,
          op === "restart",
          key,
        );
        setMessage(
          `${op === "restart" ? "已重启" : "已启动"} ${a.id}：${result.run_id} 等待派发`,
        );
      }
      keys.current.delete(request);
      return true;
    } catch (cause) {
      setFailure({ op, text: describeWriteError(cause) });
      return false;
    } finally {
      sending.current = false;
      setPending(undefined);
    }
  };
  return { pending, failure, message, perform };
}
export type AssignmentOpsState = ReturnType<typeof useAssignmentOps>;

const pendingLabels: Record<AssignmentOp, string> = {
  start: "正在启动…",
  restart: "正在重启…",
  stop: "正在停止…",
};
/** The panel's start or restart button; the page's single emphasis button. */
export function StartButton({
  ops,
  restart,
}: {
  readonly ops: AssignmentOpsState;
  readonly restart: boolean;
}) {
  const op = restart ? "restart" : "start";
  return (
    <Button
      type="button"
      size="regular"
      variant="emphasis"
      disabled={ops.pending !== undefined}
      onClick={() => void ops.perform(op)}
    >
      {ops.pending === op
        ? pendingLabels[op]
        : restart
          ? "重启会话"
          : "启动会话"}
    </Button>
  );
}
/** Progress, the result or the failure of the panel's writes. */
export function AssignmentOpsFeedback({
  ops,
}: {
  readonly ops: AssignmentOpsState;
}) {
  const failed =
    ops.failure && ops.failure.op !== "stop" ? ops.failure : undefined;
  return (
    <RequestFeedback
      interactive
      pending={ops.pending !== undefined && ops.pending !== "stop"}
      pendingMessage={pendingLabels[ops.pending ?? "start"]}
      message={ops.message}
      error={failed?.text}
      retry={failed && (() => void ops.perform(failed.op))}
    />
  );
}

/**
 * Confirms 停止执行: who and what is stopped, and that the current Run is
 * cancelled. Only the confirm button writes; 返回, Esc and a click outside
 * write nothing. While stopping it cannot be dismissed; a failure stays here
 * with its reason, and confirming again retries the same request.
 */
export function StopDialog({
  open,
  onOpenChange,
  a,
  run,
  name,
  ops,
  restoreFocus,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly a: ExecutionAssignment;
  readonly run: RunView | undefined;
  readonly name: ReactNode;
  readonly ops: AssignmentOpsState;
  readonly restoreFocus: () => void;
}) {
  const pending = ops.pending === "stop";
  const failed = ops.failure?.op === "stop" ? ops.failure.text : undefined;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) return;
        onOpenChange(next);
      }}
    >
      {open && (
        <DialogContent
          aria-describedby={undefined}
          narrowSheet
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (pending) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus();
          }}
        >
          <form
            aria-label="停止执行"
            onSubmit={async (event) => {
              event.preventDefault();
              if (await ops.perform("stop")) onOpenChange(false);
            }}
          >
            <DialogHeader>
              <DialogTitle>
                停止执行 {run && <IdBadge id={run.id} />}
              </DialogTitle>
            </DialogHeader>
            <DialogBody>
              <DetailFacts>
                <DetailFact label="员工">
                  <IdBadge id={a.id} />
                  {name}
                </DetailFact>
                {a.card_id && (
                  <DetailFact label="卡片">
                    <IdTag id={a.card_id} label={a.card_title ?? "卡片"} />
                  </DetailFact>
                )}
                <DetailFact label="结果">
                  终端关闭，当前执行记为已取消
                </DetailFact>
              </DetailFacts>
              <DialogFeedback>
                <RequestFeedback
                  interactive
                  pending={pending}
                  pendingMessage={pendingLabels.stop}
                  error={failed}
                />
              </DialogFeedback>
            </DialogBody>
            <DialogFooter>
              <DialogClose asChild>
                <Button size="regular" disabled={pending}>
                  返回
                </Button>
              </DialogClose>
              <Button
                type="submit"
                size="regular"
                variant="destructive"
                disabled={pending}
              >
                {pending ? pendingLabels.stop : "停止并取消执行"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}

interface PatchFile {
  readonly path: string;
  readonly lines: readonly string[];
}
/** Split `git diff HEAD` into its files, in patch order. */
export function patchFiles(patch: string): PatchFile[] {
  const files: { path: string; lines: string[] }[] = [];
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/.+ b\/(.+)$/u.exec(line);
    if (header?.[1]) files.push({ path: header[1], lines: [] });
    files.at(-1)?.lines.push(line);
  }
  for (const file of files) while (file.lines.at(-1) === "") file.lines.pop();
  return files;
}
const counts = (lines: readonly string[]) => {
  let added = 0,
    removed = 0;
  for (const line of lines)
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  return `+${added} −${removed}`;
};

/**
 * 查看改动: the worktree's changes read once per opening, one folded row per
 * file. Nothing here writes.
 */
export function DiffSheet({
  open,
  onOpenChange,
  client,
  projectId,
  a,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly client: CardiganClient;
  readonly projectId: string;
  readonly a: ExecutionAssignment;
}) {
  const [diff, setDiff] = useState<AssignmentDiff>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const load = useCallback(() => {
    const current = ++generation.current;
    setPending(true);
    setError("");
    client.assignmentDiff(projectId, a.id).then(
      (value) => {
        if (current !== generation.current) return;
        setDiff(value);
        setPending(false);
      },
      (reason: unknown) => {
        if (current !== generation.current) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setPending(false);
      },
    );
  }, [client, projectId, a.id]);
  useEffect(() => {
    if (!open) {
      generation.current++;
      setDiff(undefined);
      return;
    }
    load();
  }, [open, load]);
  const files = diff ? patchFiles(diff.patch) : [];
  const tracked = diff
    ? [
        ...diff.tracked.map(
          (path) =>
            files.find((file) => file.path === path) ?? { path, lines: [] },
        ),
        ...files.filter((file) => !diff.tracked.includes(file.path)),
      ]
    : [];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {open && (
        <SheetContent aria-describedby={undefined}>
          <DialogHeader>
            <DiffSheetHeading
              title={
                <DialogTitle>
                  <IdBadge id={a.id} /> 改动
                </DialogTitle>
              }
              close={
                <DialogClose asChild>
                  <IconButton variant="ghost" aria-label="关闭改动">
                    <CloseIcon aria-hidden="true" />
                  </IconButton>
                </DialogClose>
              }
            />
          </DialogHeader>
          <DialogBody>
            <DialogFeedback>
              <RequestFeedback
                pending={pending}
                pendingMessage="正在读取改动…"
                error={error}
                retry={load}
              />
            </DialogFeedback>
            {diff && (
              <>
                <DiffSummary>
                  {diff.branch && (
                    <span>
                      分支 <code>{diff.branch}</code>
                    </span>
                  )}
                  <span>
                    HEAD <code>{diff.head_sha.slice(0, 12)}</code>
                  </span>
                  <span>
                    {diff.reachable ? "已在中心仓库" : "不在中心仓库"}
                  </span>
                  {diff.truncated && <span>只显示前 512 KB</span>}
                </DiffSummary>
                {tracked.length === 0 && diff.untracked.length === 0 && (
                  <DiffEmpty>没有改动</DiffEmpty>
                )}
                {tracked.length > 0 && (
                  <DiffGroup title="已跟踪改动" count={tracked.length}>
                    <DiffFileList aria-label="已跟踪改动">
                      {tracked.map((file) =>
                        file.lines.length > 0 ? (
                          <DiffFile
                            key={file.path}
                            path={file.path}
                            stats={counts(file.lines)}
                          >
                            <DiffPatch
                              label={`${file.path} 的改动`}
                              lines={file.lines}
                            />
                          </DiffFile>
                        ) : (
                          <DiffFile key={file.path} path={file.path} />
                        ),
                      )}
                    </DiffFileList>
                  </DiffGroup>
                )}
                {diff.untracked.length > 0 && (
                  <DiffGroup title="未跟踪文件" count={diff.untracked.length}>
                    <DiffFileList aria-label="未跟踪文件">
                      {diff.untracked.map((path) => (
                        <DiffFile key={path} path={path} />
                      ))}
                    </DiffFileList>
                  </DiffGroup>
                )}
              </>
            )}
          </DialogBody>
        </SheetContent>
      )}
    </Sheet>
  );
}
