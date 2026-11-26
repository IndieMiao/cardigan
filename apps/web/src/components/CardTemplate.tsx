import { useCallback, useRef, useState } from "react";
import {
  type AttachmentView,
  type CardDetail,
  type CardiganClient,
  describeWriteError,
} from "../api.js";
import {
  attachmentRefKind,
  checkUpload,
  type FileProblem,
  fileLabel,
  formatBytes,
  isVideoType,
  toBase64,
  UPLOAD_ACCEPT,
  uploadFilename,
} from "../attachment-refs.js";
import { useResource } from "../useResource.js";
import { type MeasuredVideo, measureVideo } from "../video-probe.js";
import { uploadPercent } from "./CommentBox.js";
import { LargeFileRoute } from "./LargeFileRoute.js";
import { DialogFeedback } from "./layout/DialogFeedbackLayout.js";
import {
  EvidenceEmpty,
  EvidenceList,
  EvidencePicker,
  EvidenceRow,
  evidenceIconClassName,
} from "./layout/EvidencePickerLayout.js";
import { RequestFeedback } from "./RequestFeedback.js";
import { Tooltip } from "./Tooltip.js";
import { Button } from "./ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFields,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.js";
import {
  FileChip,
  FileChipList,
  FileKindIcon,
  FileProblems,
} from "./ui/file-chip.js";
import { FilePicker } from "./ui/file-picker.js";
import { IdBadge } from "./ui/id-badge.js";
import { Textarea } from "./ui/textarea.js";
import { useDraftLeaveGuard } from "./useDraftLeaveGuard.js";

/** A file chosen in the dialog, sent when the person confirms. */
interface PendingFile {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly file: File;
  readonly mime: string;
  /** The attachment it became; a retry skips it. */
  readonly uploaded?: string;
  /** C-683: the video's resumable upload; a retry continues it. */
  readonly uploadId?: string;
  readonly sent?: number;
  readonly measured?: MeasuredVideo;
}

/** The comment new evidence files are attached to (uploads need an entry). */
const EVIDENCE_COMMENT = "完成证据";

export function CardTemplate({
  detail,
  client,
  projectId,
  onSaved,
  onDone,
  revision = 0,
  showMetadata = true,
  disabled = false,
  onEditingChange,
  emphasis = false,
}: {
  detail: CardDetail;
  client: CardiganClient;
  projectId: string;
  onSaved: () => void;
  /**
   * C-696: the card was marked done. The page shows the notice: the panel
   * holding this button goes away with the reload.
   */
  onDone?: (notice: string) => void;
  revision?: number;
  showMetadata?: boolean;
  disabled?: boolean;
  onEditingChange?: (editing: boolean) => void;
  /** C-695: the “下一步” panel's main action (32px, emphasis). */
  emphasis?: boolean;
}) {
  const cardId = detail.card.id;
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onEditingChange?.(next);
  };
  const toggle = useRef<HTMLButtonElement>(null);
  const resultField = useRef<HTMLTextAreaElement>(null);
  const [result, setResult] = useState("");
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [files, setFiles] = useState<readonly PendingFile[]>([]);
  const [problems, setProblems] = useState<readonly FileProblem[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const keys = useRef(new Map<string, string>());
  // The comment holding uploaded evidence: posted once per draft, reused by a retry.
  const commentKey = useRef<string>(undefined);
  const commentId = useRef<string>(undefined);
  const attachmentLimit = client.attachmentMaxBytes?.();
  const videoLimit = client.videoMaxBytes?.();
  const loadEvidence = useCallback(
    async () =>
      (await client.cardPanel?.(projectId, cardId, "attachments"))
        ?.attachments ?? [],
    [client, projectId, cardId],
  );
  const deferred = !!detail.overview && detail.overview.attachment_count > 0;
  const evidence = useResource(loadEvidence, revision, deferred && open);
  const choices: readonly AttachmentView[] | undefined = deferred
    ? evidence.data
    : detail.attachments;
  const dirty =
    open &&
    (result.trim() !== "" ||
      picked.length > 0 ||
      files.some((file) => !file.uploaded));
  const reset = () => {
    setResult("");
    setPicked([]);
    setFiles([]);
    setProblems([]);
    setError("");
    commentKey.current = undefined;
    commentId.current = undefined;
  };
  const { ask, dialog } = useDraftLeaveGuard(
    dirty,
    projectId,
    cardId,
    reset,
    "放弃未提交的完成结果？",
  );
  const template = detail.template;
  if (!template) return null;
  const allowed = detail.mark_done?.allowed === true;
  const all = choices?.map((a) => a.id) ?? [];
  const allPicked = all.length > 0 && all.every((id) => picked.includes(id));
  const waiting = files.filter((file) => !file.uploaded);
  const selected = picked.length + files.length;
  const total = all.length + files.length;

  function addFiles(chosen: readonly File[]) {
    const accepted: PendingFile[] = [];
    const rejected: FileProblem[] = [];
    for (const file of chosen) {
      const checked = checkUpload(file, {
        maxBytes: attachmentLimit ?? null,
        videoMaxBytes: videoLimit ?? null,
        video: !!client.uploadVideo,
      });
      const { mime } = checked;
      if (mime === undefined)
        rejected.push({
          name: fileLabel(file),
          reason: checked.reason,
          ...(checked.oversize ? { oversize: true } : {}),
        });
      else
        accepted.push({
          id: crypto.randomUUID(),
          idempotencyKey: crypto.randomUUID(),
          file,
          mime,
        });
    }
    setProblems(rejected);
    if (accepted.length) setFiles((current) => [...current, ...accepted]);
  }

  /** New files, one at a time in the dialog's order, on one evidence comment. */
  async function upload(): Promise<string[]> {
    const ids: string[] = [];
    for (const file of files) {
      if (file.uploaded) {
        ids.push(file.uploaded);
        continue;
      }
      if (!commentId.current) {
        commentKey.current ??= crypto.randomUUID();
        commentId.current = (
          await client.addComment(
            projectId,
            cardId,
            { body: EVIDENCE_COMMENT },
            commentKey.current,
          )
        ).id;
      }
      const entry = commentId.current;
      const update = (patch: Partial<PendingFile>) =>
        setFiles((current) =>
          current.map((item) =>
            item.id === file.id ? { ...item, ...patch } : item,
          ),
        );
      const filename = uploadFilename(file.file.name);
      // C-683: as the comment box, a video is measured once, then sent in
      // chunks; a retry resumes the upload.
      const measured = isVideoType(file.mime)
        ? (file.measured ?? (await measureVideo(file.file, file.mime)))
        : undefined;
      if (measured && !file.measured) update({ measured });
      const uploadId =
        isVideoType(file.mime) && client.uploadVideo
          ? await client.uploadVideo(projectId, file.file, file.mime, {
              uploadId: file.uploadId,
              onStarted: (id) => update({ uploadId: id }),
              onProgress: (received) => update({ sent: received }),
            })
          : undefined;
      const receipt = await client.uploadAttachment(
        projectId,
        cardId,
        {
          ...(uploadId
            ? { upload_id: uploadId }
            : { file: await toBase64(file.file) }),
          ...(measured && Object.keys(measured.video).length
            ? { video: measured.video }
            : {}),
          ...(measured?.poster ? { poster: measured.poster } : {}),
          ...(filename ? { original_filename: filename } : {}),
          mime: file.mime,
          kind: "evidence",
          attach_to: { kind: "timeline_entry", id: entry },
        },
        file.idempotencyKey,
      );
      update({ uploaded: receipt.id });
      ids.push(receipt.id);
    }
    return ids;
  }

  async function submit() {
    if (sending.current || !allowed || !result.trim()) return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      const uploaded = await upload();
      const attachments = [...new Set([...picked, ...uploaded])].sort();
      const input = JSON.stringify([result, attachments]);
      const key = keys.current.get(input) ?? crypto.randomUUID();
      keys.current.set(input, key);
      await client.markCardDone(projectId, cardId, result, attachments, key);
      keys.current.delete(input);
      reset();
      setOpen(false);
      const notice = `${cardId} 已完成`;
      if (onDone) onDone(notice);
      else setMessage(notice);
      onSaved();
    } catch (cause) {
      setError(describeWriteError(cause));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="card-template">
      {showMetadata && (
        <p>
          模板：{template.title} · v{template.version}
        </p>
      )}
      {template.completion.mode === "human_mark_done" && (
        <>
          {/* C-695: a refused mark stays focusable; why is in the tooltip. */}
          <Tooltip
            content={
              allowed
                ? undefined
                : (detail.mark_done?.reason ?? "当前会话不能标记完成。")
            }
          >
            <Button
              ref={toggle}
              type="button"
              size="regular"
              variant={emphasis && allowed ? "emphasis" : "default"}
              aria-disabled={!allowed || undefined}
              data-disabled={!allowed || undefined}
              disabled={allowed && (busy || disabled)}
              onClick={() => {
                if (allowed) setOpen(true);
              }}
            >
              标记完成
            </Button>
          </Tooltip>
          <Dialog
            open={open}
            onOpenChange={(next) => {
              if (next || busy) return;
              ask(() => {
                reset();
                setOpen(false);
              });
            }}
          >
            <DialogContent
              narrowSheet
              aria-describedby={undefined}
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                resultField.current?.focus();
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                toggle.current?.focus();
              }}
            >
              <form
                aria-label="标记完成"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                <DialogHeader>
                  <DialogTitle>
                    标记完成 <IdBadge id={cardId} />
                  </DialogTitle>
                </DialogHeader>
                <DialogBody>
                  <DialogFields>
                    <label>
                      完成结果
                      <Textarea
                        ref={resultField}
                        required
                        rows={4}
                        value={result}
                        readOnly={busy}
                        onChange={(e) => setResult(e.target.value)}
                      />
                    </label>
                    <EvidencePicker
                      label="证据附件"
                      count={`已选 ${selected}/${total}`}
                      actions={
                        <>
                          {all.length > 0 && (
                            <Button
                              variant="ghost"
                              disabled={busy}
                              onClick={() => setPicked(allPicked ? [] : all)}
                            >
                              {allPicked ? "全不选" : "全选"}
                            </Button>
                          )}
                          <FilePicker
                            label="上传"
                            accept={UPLOAD_ACCEPT}
                            disabled={busy}
                            onFiles={addFiles}
                          />
                        </>
                      }
                    >
                      {choices &&
                        (choices.length > 0 ? (
                          <EvidenceList label="本卡附件">
                            {choices.map((a) => (
                              <EvidenceRow
                                key={a.id}
                                checked={picked.includes(a.id)}
                                disabled={busy}
                                onCheckedChange={(checked) =>
                                  setPicked((old) =>
                                    checked
                                      ? [...old, a.id].sort()
                                      : old.filter((id) => id !== a.id),
                                  )
                                }
                                icon={
                                  <FileKindIcon
                                    kind={attachmentRefKind(a.mime, a.inline)}
                                    className={evidenceIconClassName}
                                  />
                                }
                                name={a.original_filename || a.id}
                                trailing={<IdBadge id={a.id} />}
                              />
                            ))}
                          </EvidenceList>
                        ) : (
                          files.length === 0 && (
                            <EvidenceEmpty>没有附件</EvidenceEmpty>
                          )
                        ))}
                      {files.length > 0 && (
                        <FileChipList label="待上传的附件">
                          {files.map((file) => (
                            <FileChip
                              key={file.id}
                              name={fileLabel(file.file)}
                              size={
                                file.sent !== undefined && !file.uploaded
                                  ? `${formatBytes(file.file.size)} · ${uploadPercent(file.sent, file.file.size)}%`
                                  : formatBytes(file.file.size)
                              }
                              kind={attachmentRefKind(file.mime)}
                              removeDisabled={busy || !!file.uploaded}
                              onRemove={() =>
                                setFiles((current) =>
                                  current.filter((item) => item.id !== file.id),
                                )
                              }
                            />
                          ))}
                        </FileChipList>
                      )}
                      <FileProblems
                        problems={problems}
                        oversize={<LargeFileRoute projectId={projectId} />}
                      />
                    </EvidencePicker>
                  </DialogFields>
                  <DialogFeedback>
                    {deferred && (
                      <RequestFeedback
                        pending={evidence.pending}
                        error={evidence.error}
                        retry={evidence.reload}
                        pendingMessage="正在加载附件…"
                      />
                    )}
                    {/* The confirm button says “正在提交…”; only uploads add a line. */}
                    <RequestFeedback
                      interactive
                      pending={busy && waiting.length > 0}
                      pendingMessage="正在上传附件…"
                      error={error}
                    />
                  </DialogFeedback>
                </DialogBody>
                <DialogFooter>
                  <Button
                    size="regular"
                    disabled={busy}
                    onClick={() =>
                      ask(() => {
                        reset();
                        setOpen(false);
                      })
                    }
                  >
                    取消
                  </Button>
                  <Button
                    type={busy ? "button" : "submit"}
                    size="regular"
                    variant="emphasis"
                    aria-disabled={busy || undefined}
                    disabled={!busy && (!allowed || !result.trim())}
                  >
                    {busy ? "正在提交…" : "确认完成"}
                  </Button>
                </DialogFooter>
              </form>
              {dialog}
            </DialogContent>
          </Dialog>
        </>
      )}
      <RequestFeedback message={message} />
    </div>
  );
}
