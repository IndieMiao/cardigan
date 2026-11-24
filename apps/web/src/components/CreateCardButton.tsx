import { useCallback, useRef, useState } from "react";
import {
  ApiError,
  type CardiganClient,
  type CreateCardInput,
  type CreatedCard,
  describeWriteError,
  type TemplateView,
} from "../api.js";
import {
  attachmentRefKind,
  formatBytes,
  isVideoType,
  toBase64,
  UPLOAD_ACCEPT,
  uploadFilename,
  uploadMime,
  uploadProblem,
} from "../attachment-refs.js";
import { useResource } from "../useResource.js";
import { type MeasuredVideo, measureVideo } from "../video-probe.js";
import { uploadPercent } from "./CommentBox.js";
import { SettingsDiscardDialog } from "./layout/SettingsLayout.js";
import { RequestFeedback } from "./RequestFeedback.js";
import { Button } from "./ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog.js";
import { FileChip, FileChipList, FileProblems } from "./ui/file-chip.js";
import { FilePicker } from "./ui/file-picker.js";
import { Input } from "./ui/input.js";
import { SelectControl } from "./ui/select-control.js";
import { Textarea } from "./ui/textarea.js";

interface CreateCardProps {
  client: CardiganClient;
  projectId: string;
  onCreated: (id: string) => void;
}

const isStory = (t: TemplateView) => t.builtin && (t.story || t.id === "story");
/** C-684: what a person may open when the server does not say (older servers). */
const DEFAULT_HUMAN_TEMPLATES: readonly string[] = ["story"];

interface PendingFile {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly file: File;
  readonly mime: string;
  /** The attachment it became; a retry skips it. */
  readonly uploaded?: string;
  /** C-683: the video's resumable upload; a retry continues it. */
  readonly uploadId?: string;
  /** C-683: bytes of the video the server has, while it is being sent. */
  readonly sent?: number;
  /** C-683: what the browser measured and drew, kept for a retry. */
  readonly measured?: MeasuredVideo;
}

/** C-684: the cards page's standing entry; a person opens a story by default. */
export function CreateCardButton(props: CreateCardProps) {
  const [open, setOpen] = useState(false);
  return (
    <CreateCardDialog {...props} open={open} setOpen={setOpen} showTrigger />
  );
}

export function CreateCardDialog({
  client,
  projectId,
  onCreated,
  open,
  setOpen,
  showTrigger = false,
  parentId,
  restoreFocus,
}: CreateCardProps & {
  open: boolean;
  setOpen: (open: boolean) => void;
  showTrigger?: boolean;
  parentId?: string | undefined;
  restoreFocus?: () => void;
}) {
  const [choice, setTemplate] = useState<string>(),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const {
    data,
    error: catalogError,
    pending: loading,
    reload,
  } = useResource(
    useCallback(
      () =>
        Promise.all([
          client.templates(projectId),
          client.preferences(projectId),
        ]).then(([catalog, preferences]) => ({
          templates: catalog.templates,
          allowed: preferences.human_card_templates ?? DEFAULT_HUMAN_TEMPLATES,
        })),
      [client, projectId],
    ),
    0,
    open,
  );
  // C-684: only the templates the project opened to people (story by default).
  const templates =
    data?.templates.filter(
      (t) =>
        t.status === "active" &&
        data.allowed.includes(t.id) &&
        !(parentId && isStory(t)),
    ) ?? [];
  const template =
    choice ??
    (parentId
      ? (templates.find((t) => t.id === "dev") ?? templates[0])?.id
      : (templates.find(isStory)?.id ?? "story"));
  const selected = templates.find((t) => t.id === template);
  const story = selected !== undefined && isStory(selected);
  const choosing = parentId ? templates.length > 0 : templates.length > 1;
  const [readOnly, setReadOnly] = useState(false);
  const [files, setFiles] = useState<readonly PendingFile[]>([]);
  const [problems, setProblems] = useState<
    readonly { readonly name: string; readonly reason: string }[]
  >([]);
  // The card exists but some files are not uploaded yet: the form is fixed.
  const [created, setCreated] = useState<CreatedCard>();
  const [discarding, setDiscarding] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const keys = useRef(new Map<string, string>());
  const attachmentLimit = client.attachmentMaxBytes?.();
  const videoLimit = client.videoMaxBytes?.();
  const reset = () => {
    setTemplate(undefined);
    setReadOnly(false);
    setFiles([]);
    setProblems([]);
    setCreated(undefined);
    setError("");
  };
  const close = () => {
    const card = created;
    setOpen(false);
    reset();
    if (card) onCreated(card.id);
  };
  // Typed text or files not uploaded yet would be lost by closing.
  const dirty = () =>
    files.some((file) => !file.uploaded) ||
    (!created &&
      Array.from(form.current?.elements ?? []).some(
        (field) =>
          (field instanceof HTMLInputElement ||
            field instanceof HTMLTextAreaElement) &&
          field.type !== "file" &&
          field.type !== "hidden" &&
          field.value.trim() !== "" &&
          field.value !== field.defaultValue,
      ));
  function addFiles(chosen: readonly File[]) {
    const accepted: PendingFile[] = [];
    const rejected: { name: string; reason: string }[] = [];
    for (const file of chosen) {
      const mime = uploadMime(file);
      const problem =
        mime && isVideoType(mime) && !client.uploadVideo
          ? "不支持上传视频"
          : uploadProblem(file, attachmentLimit ?? null, videoLimit ?? null);
      if (problem || !mime)
        rejected.push({ name: file.name || file.type, reason: problem ?? "" });
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
  /** One at a time, in the dialog's order, each attached to the creation entry. */
  async function upload(card: CreatedCard) {
    for (const file of files) {
      if (file.uploaded) continue;
      if (!card.entry_id)
        throw new Error("服务器没有返回卡片的创建记录，请在卡片里上传附件。");
      const filename = uploadFilename(file.file.name);
      const update = (patch: Partial<PendingFile>) =>
        setFiles((current) =>
          current.map((item) =>
            item.id === file.id ? { ...item, ...patch } : item,
          ),
        );
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
        card.id,
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
          attach_to: { kind: "timeline_entry", id: card.entry_id },
        },
        file.idempotencyKey,
      );
      update({ uploaded: receipt.id });
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (next) return setOpen(true);
        if (dirty()) setDiscarding(true);
        else close();
      }}
    >
      {showTrigger && (
        <DialogTrigger asChild>
          <Button variant="primary">新建需求</Button>
        </DialogTrigger>
      )}
      <DialogContent
        inlineFeedback
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          if (restoreFocus) {
            event.preventDefault();
            restoreFocus();
          }
        }}
      >
        <DialogTitle>
          {parentId ? "新建子卡" : story ? "新建需求" : "新建卡片"}
        </DialogTitle>
        <form
          ref={form}
          className="card-action-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (pending || !selected) return;
            const fields = new FormData(e.currentTarget);
            const field = (key: string) => String(fields.get(key) ?? "").trim();
            const parent = field("parent");
            const input: CreateCardInput = {
              ...(selected.requires_state_and_save
                ? {
                    state_and_save: readOnly
                      ? "无写入"
                      : {
                          save_timing: field("save_timing"),
                          leave_behavior: field("leave_behavior"),
                          failure_feedback: field("failure_feedback"),
                          consistency: field("consistency"),
                        },
                  }
                : {}),
              title: field("title"),
              goal: field("goal"),
              template_id: selected.id,
              ...(parent ? { parent_card_id: parent } : {}),
              acceptance_criteria: field("criteria")
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
            };
            const fingerprint = JSON.stringify(input);
            const key = keys.current.get(fingerprint) ?? crypto.randomUUID();
            keys.current.set(fingerprint, key);
            setPending(true);
            setError("");
            let card = created;
            try {
              if (!card) {
                card = await client.createCard(projectId, input, key);
                keys.current.delete(fingerprint);
                setCreated(card);
              }
              await upload(card);
              setOpen(false);
              reset();
              onCreated(card.id);
            } catch (cause) {
              const reason =
                cause instanceof ApiError &&
                cause.code === "validation_failed" &&
                cause.message === "repo is required"
                  ? "该模板需要仓库。请先登记项目仓库，或选择不需要仓库的模板。"
                  : describeWriteError(
                      cause,
                      card ? "上传可能已经成功，重试不会重复上传。" : undefined,
                    );
              setError(
                card
                  ? `卡片 ${card.id} 已创建，附件上传失败：${reason}`
                  : reason,
              );
            } finally {
              setPending(false);
            }
          }}
        >
          {catalogError && (
            <Button type="button" onClick={reload}>
              重试
            </Button>
          )}
          <fieldset disabled={pending || loading}>
            {choosing && (
              <label>
                模板
                <SelectControl
                  value={template ?? ""}
                  onValueChange={setTemplate}
                  disabled={!!created}
                >
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </SelectControl>
              </label>
            )}
            {parentId && data && templates.length === 0 && (
              <p role="status">没有可开的子卡模板</p>
            )}
            <label>
              标题
              <Input name="title" required readOnly={!!created} />
            </label>
            <label>
              {story ? "描述" : "目标"}
              <Textarea
                name="goal"
                required
                readOnly={!!created}
                onPaste={(event) => {
                  const pasted = Array.from(event.clipboardData.files).filter(
                    (file) => file.type.startsWith("image/"),
                  );
                  if (pasted.length && !created) addFiles(pasted);
                }}
              />
            </label>
            {!story && (
              <label>
                父需求卡（可选）
                <Input
                  name="parent"
                  defaultValue={parentId}
                  placeholder="C-123"
                  pattern="C-[1-9][0-9]*"
                  readOnly={!!created}
                />
              </label>
            )}
            {selected?.requires_state_and_save && (
              <fieldset disabled={!!created}>
                <legend>状态与保存</legend>
                <label>
                  写入行为
                  <SelectControl
                    value={readOnly ? "none" : "write"}
                    onValueChange={(v) => setReadOnly(v === "none")}
                  >
                    <option value="write">有写入</option>
                    <option value="none">无写入</option>
                  </SelectControl>
                </label>
                {!readOnly &&
                  Object.entries({
                    save_timing: "保存时机",
                    leave_behavior: "离页行为",
                    failure_feedback: "失败提示",
                    consistency: "读写一致性",
                  }).map(([key, label]) => (
                    <label key={key}>
                      {label}
                      <Input name={key} required />
                    </label>
                  ))}
              </fieldset>
            )}
            {!story && (
              <label>
                验收标准
                <Textarea
                  name="criteria"
                  required={selected?.require_acceptance_criteria}
                  readOnly={!!created}
                />
              </label>
            )}
            {files.length > 0 && (
              <FileChipList label="待上传的附件">
                {files.map((file) => (
                  <FileChip
                    key={file.id}
                    name={file.file.name || file.mime}
                    size={
                      file.sent !== undefined && !file.uploaded
                        ? `${formatBytes(file.file.size)} · ${uploadPercent(file.sent, file.file.size)}%`
                        : formatBytes(file.file.size)
                    }
                    kind={attachmentRefKind(file.mime)}
                    removeDisabled={pending || !!file.uploaded}
                    onRemove={() =>
                      setFiles((current) =>
                        current.filter((item) => item.id !== file.id),
                      )
                    }
                  />
                ))}
              </FileChipList>
            )}
            <FileProblems problems={problems} />
            <div className="card-action-buttons">
              <Button type="submit" disabled={!selected}>
                {created ? "重试上传" : "创建"}
              </Button>
              <FilePicker
                label="添加附件"
                accept={UPLOAD_ACCEPT}
                disabled={pending}
                onFiles={addFiles}
              />
              <DialogClose asChild>
                <Button variant="ghost">取消</Button>
              </DialogClose>
            </div>
          </fieldset>
          <RequestFeedback
            interactive
            pending={pending}
            error={error || catalogError || ""}
          />
        </form>
        <SettingsDiscardDialog
          title="放弃未提交的内容？"
          open={discarding}
          onKeep={() => setDiscarding(false)}
          onDiscard={() => {
            setDiscarding(false);
            close();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
