import { File as FileIcon, FileText, Film, Image } from "lucide-react";
import {
  type KeyboardEvent,
  type Ref,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ApiError,
  type AttachmentView,
  type CardiganClient,
  describeError,
  describeWriteError,
  type MentionCandidate,
  type PostedComment,
} from "../api.js";
import {
  type AttachmentQuery,
  type AttachmentRefTarget,
  attachmentQuery,
  attachmentRefKind,
  attachmentTarget,
  formatBytes,
  formatMiB,
  insertAttachmentRef,
  isVideoType,
  numberPendingRefs,
  pendingToken,
  toBase64,
  UPLOAD_ACCEPT,
  uploadFilename,
  uploadMime,
  uploadProblem,
} from "../attachment-refs.js";
import { renderMarkdown } from "../markdown.js";
import { useAttachmentRefs } from "../useAttachmentRefs.js";
import { type MeasuredVideo, measureVideo } from "../video-probe.js";
import { AttachmentRefBody } from "./AttachmentRefBody.js";
import { EmployeeFace } from "./EmployeeIdentity.js";
import { RequestFeedback } from "./RequestFeedback.js";
import { Button } from "./ui/button.js";
import { FileChip, FileChipList, FileProblems } from "./ui/file-chip.js";
import { FilePicker } from "./ui/file-picker.js";
import { Input } from "./ui/input.js";
import {
  SuggestionList,
  SuggestionOption,
  SuggestionStatus,
} from "./ui/suggestion-list.js";
import { Textarea } from "./ui/textarea.js";

/**
 * The comment box (M5 plan §3.7, §4 M5.3; the write endpoints arrive with M5.2).
 *
 * A plain Markdown textarea with a preview — not a WYSIWYG editor. Typing `@`
 * suggests the project's employees (C-514; the card's own people first) and
 * inserts `@<name>`, which the server routes like any typed employee name;
 * hand-typed `@role` / `@A-n` keep working. Files (chosen, dropped or pasted
 * images) are uploaded and attached to the comment's timeline entry, and the
 * send button is live: the comment is posted as the human, through
 * `POST /cards/:card/comments`, and every file goes to
 * `POST /cards/:card/attachments` attached to that entry.
 *
 * C-615: typing `#` offers the card's attachments and the files in the box,
 * and inserts `attachment-123` or, for a file not sent yet, `attachment-new-K`
 * (K numbers the box's files). The posted body numbers those by the order the
 * files are sent (see attachment-refs.ts), and the timeline shows each as the
 * attachment its upload became.
 */

export interface CommentBoxProps {
  readonly ref?: Ref<CommentBoxHandle>;
  readonly client: CardiganClient;
  readonly projectId: string;
  readonly cardId: string;
  readonly hasPmOps?: boolean | undefined;
  /** The card's attachments, offered after `#`. */
  readonly attachments?: readonly AttachmentView[];
  /** Other cards' attachments the server let this page see, for the preview. */
  readonly referencedAttachments?:
    | readonly (AttachmentView & { readonly card_id: string })[]
    | undefined;
  /** Called after the comment and its files were accepted. */
  readonly onPosted?: (comment: PostedComment) => void | Promise<void>;
  /** Refresh the timeline when a previous comment was accepted with different text. */
  readonly onConflict?: () => void | Promise<void>;
}

export interface CommentBoxHandle {
  focus(onFocused: (input: HTMLTextAreaElement) => void): void;
}

interface PendingFile {
  readonly id: string;
  /** The `K` of the draft's `attachment-new-K`; never reused in a draft. */
  readonly draft: number;
  readonly idempotencyKey: string;
  readonly name: string;
  readonly mime: string;
  readonly file: File;
  readonly note: string;
  /**
   * The attachment this file became on the accepted comment. A retry skips it:
   * sending it again (say with a changed note, so a new key) would add a
   * second copy and shift what `attachment-new-N` names.
   */
  readonly uploaded?: string;
  /** C-683: the video's resumable upload; a retry continues it. */
  readonly uploadId?: string;
  /** C-683: bytes of the video the server has, while it is being sent. */
  readonly sent?: number;
  /** C-683: what the browser measured and drew, kept for a retry. */
  readonly measured?: MeasuredVideo;
}

interface AttachmentCandidate {
  readonly token: string;
  readonly name: string;
  readonly meta: string;
  readonly kind: AttachmentRefTarget["kind"];
}

const NO_ATTACHMENTS: readonly AttachmentView[] = [];

export function CommentBox({
  ref,
  client,
  projectId,
  cardId,
  hasPmOps,
  attachments = NO_ATTACHMENTS,
  referencedAttachments,
  onPosted,
  onConflict,
}: CommentBoxProps) {
  const routingHintId = useId();
  const listId = useId();
  const [body, setBody] = useState("");
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [files, setFiles] = useState<readonly PendingFile[]>([]);
  const nextDraft = useRef(1);
  const [problems, setProblems] = useState<
    readonly { readonly name: string; readonly reason: string }[]
  >([]);
  const [dragging, setDragging] = useState(false);
  // The comment of this draft was accepted but some files are not uploaded:
  // the files keep their order, as the body numbers them by it.
  const [posted, setPosted] = useState(false);
  const [attachmentActive, setAttachmentActive] = useState(0);
  // Escape closes the `#` list for the `#` it was opened at, until a new `#`.
  const [attachmentDismissedAt, setAttachmentDismissedAt] = useState<number>();
  // The caret the `@query` is read at; cleared once a name is inserted.
  const [cursor, setCursor] = useState<number>();
  // Escape closes the list for the `@` it was opened at, until a new `@`.
  const [dismissedAt, setDismissedAt] = useState<number>();
  // An `@` the user typed (keeping the text from `keep` on), as opposed to the
  // caret moved into an old one: choosing a name never replaces that text.
  const [typed, setTyped] = useState<TypedMention>();
  // Where chosen names sit, followed through every edit.
  const [memory, setMemory] = useState<MentionMemory>(NO_MEMORY);
  // The selection each input began with, read from the native `beforeinput`.
  const intent = useRef<InputIntent | undefined>(undefined);
  const compositionStart = useRef<number | undefined>(undefined);
  const [active, setActive] = useState(0);
  const [candidates, setCandidates] = useState<{
    readonly cardId: string;
    readonly employees?: readonly MentionCandidate[];
    readonly error?: string;
  }>();
  const candidateRead = useRef(0);
  const caret = useRef<number | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  /** Host attachment limit from the session; unknown on older servers. */
  const attachmentLimit = client.attachmentMaxBytes?.();
  /** C-683: host video limit; unknown on older servers. */
  const videoLimit = client.videoMaxBytes?.();
  const [focused, setFocused] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const afterFocus = useRef<((input: HTMLTextAreaElement) => void) | undefined>(
    undefined,
  );
  const textarea = useRef<HTMLTextAreaElement>(null);
  const section = useRef<HTMLElement>(null);
  const draftKey = useRef<string | undefined>(undefined);
  const sending = useRef(false);
  const startDraft = () => (draftKey.current ??= crypto.randomUUID());
  const resetDraftKey = () => {
    draftKey.current = undefined;
    setPosted(false);
    // Retained files will attach to a new comment, so they need new keys too.
    setFiles((current) =>
      current.map(({ uploaded: _uploaded, ...file }) => ({
        ...file,
        idempotencyKey: crypto.randomUUID(),
      })),
    );
  };
  const expanded =
    focused || body.length > 0 || files.length > 0 || problems.length > 0;

  useImperativeHandle(
    ref,
    () => ({
      focus(onFocused) {
        afterFocus.current = onFocused;
        setTab("write");
        setFocused(true);
        setFocusRequest((request) => request + 1);
      },
    }),
    [],
  );
  // Focus and scroll only after the write tab and expanded textarea have laid out.
  useLayoutEffect(() => {
    if (!focusRequest || !afterFocus.current || !textarea.current) return;
    textarea.current.focus({ preventScroll: true });
    afterFocus.current(textarea.current);
    afterFocus.current = undefined;
  }, [focusRequest]);

  const ownRefs = useMemo(() => {
    const refs = new Map<string, AttachmentRefTarget>(
      [...attachments, ...(referencedAttachments ?? [])].map((a) => [
        a.id,
        attachmentTarget(a, cardId),
      ]),
    );
    for (const file of files)
      refs.set(pendingToken(file.draft), {
        id: pendingToken(file.draft),
        name: file.name,
        mime: file.mime,
        size: file.file.size,
        kind: attachmentRefKind(file.mime),
      });
    return refs;
  }, [attachments, referencedAttachments, files, cardId]);
  const knownIds = useMemo(() => new Set(ownRefs.keys()), [ownRefs]);
  // Numbers the page has not seen yet (another card's file named for the
  // first time) are read when the preview shows them.
  const previewTexts = useMemo(
    () => (tab === "preview" ? [body] : []),
    [tab, body],
  );
  const draftRefs = useAttachmentRefs(
    client,
    projectId,
    cardId,
    previewTexts,
    knownIds,
    knownIds,
  );
  const previewRefs = useMemo(() => {
    if (!draftRefs.length) return ownRefs;
    const refs = new Map(ownRefs);
    for (const a of draftRefs) refs.set(a.id, attachmentTarget(a, cardId));
    return refs;
  }, [ownRefs, draftRefs, cardId]);
  const preview = useMemo(
    () =>
      tab === "preview"
        ? renderMarkdown(body, { attachments: previewRefs })
        : "",
    [body, previewRefs, tab],
  );
  const canSubmit = body.trim().length > 0 && !submitting;

  const loaded = candidates?.cardId === cardId ? candidates : undefined;
  const ordered = useMemo(
    () => orderMentionCandidates(loaded?.employees ?? []),
    [loaded],
  );
  const occurrence = cursor === undefined ? undefined : mentionAt(body, cursor);
  const mention =
    cursor === undefined
      ? undefined
      : mentionQuery(body, cursor, ordered, typed, memory);
  const matches = mention ? matchMentionCandidates(ordered, mention.query) : [];
  // The trigger nearest the caret wins when both an `@` and a `#` are open.
  const reference =
    cursor === undefined ? undefined : attachmentQuery(body, cursor);
  const referenceFirst =
    reference !== undefined &&
    (mention === undefined || reference.start > mention.start);
  const attachmentMatches = useMemo(
    () =>
      reference && referenceFirst
        ? matchAttachmentCandidates(
            attachmentCandidates(files, attachments),
            reference.query,
          )
        : [],
    [reference, referenceFirst, files, attachments],
  );
  const attachmentListOpen =
    expanded &&
    tab === "write" &&
    !submitting &&
    referenceFirst &&
    reference.start !== attachmentDismissedAt &&
    attachmentMatches.length > 0;
  const attachmentCurrent = Math.min(
    attachmentActive,
    Math.max(attachmentMatches.length - 1, 0),
  );
  const suggesting =
    expanded &&
    tab === "write" &&
    !submitting &&
    !referenceFirst &&
    mention !== undefined &&
    mention.start !== dismissedAt;
  const listOpen =
    suggesting &&
    (loaded?.employees === undefined ||
      loaded.error !== undefined ||
      matches.length > 0);
  const current = Math.min(active, Math.max(matches.length - 1, 0));
  const optionId = (index: number) => `${listId}-option-${index}`;

  // Read at every new `@`, so joiners, leavers and renames show up without
  // leaving the card. Only this read's names can be chosen: the previous list
  // is dropped meanwhile. Typing within one `@` reads nothing.
  function loadCandidates(): void {
    const read = ++candidateRead.current;
    setCandidates({ cardId });
    client.mentionCandidates(projectId, cardId).then(
      ({ employees }) => {
        if (read === candidateRead.current)
          setCandidates({ cardId, employees });
      },
      (failure: unknown) => {
        if (read === candidateRead.current)
          setCandidates({ cardId, error: describeError(failure) });
      },
    );
  }

  // React's onBeforeInput is synthesized from other events and carries no
  // selection; the native event fires before the text changes.
  useEffect(() => {
    const field = textarea.current;
    if (!field || tab !== "write") return;
    const onBeforeInput = (event: Event) => {
      intent.current = {
        before: field.value,
        selectionStart: field.selectionStart,
        selectionEnd: field.selectionEnd,
        inputType: (event as InputEvent).inputType ?? "",
        ...(compositionStart.current === undefined
          ? {}
          : { compositionStart: compositionStart.current }),
      };
    };
    const onCompositionStart = () => {
      compositionStart.current = field.selectionStart;
    };
    const onCompositionEnd = () => {
      compositionStart.current = undefined;
    };
    field.addEventListener("beforeinput", onBeforeInput);
    field.addEventListener("compositionstart", onCompositionStart);
    field.addEventListener("compositionend", onCompositionEnd);
    return () => {
      field.removeEventListener("beforeinput", onBeforeInput);
      field.removeEventListener("compositionstart", onCompositionStart);
      field.removeEventListener("compositionend", onCompositionEnd);
    };
  }, [tab]);

  useLayoutEffect(() => {
    if (caret.current === undefined || !textarea.current) return;
    textarea.current.setSelectionRange(caret.current, caret.current);
    caret.current = undefined;
  });
  useEffect(() => {
    if (!listOpen && !attachmentListOpen) return;
    document
      .getElementById(optionId(listOpen ? current : attachmentCurrent))
      ?.scrollIntoView?.({ block: "nearest" });
  });

  /**
   * Recompute the `@query` before the caret after moving it, or after a change
   * (`edit`, `null` when its range is not known).
   */
  function trackMention(
    field: HTMLTextAreaElement,
    edit?: TextEdit | null,
  ): void {
    // A choice is not on screen yet: React reports the selection of the old
    // text in the same key event (Enter), which would undo the choice.
    if (caret.current !== undefined) return;
    const { value, selectionStart } = field;
    const hash = attachmentQuery(value, selectionStart)?.start;
    if (hash !== reference?.start) {
      setAttachmentDismissedAt(undefined);
      setAttachmentActive(0);
    } else if (value.slice(0, selectionStart) !== body.slice(0, cursor))
      setAttachmentActive(0);
    const start = mentionAt(value, selectionStart);
    if (start !== occurrence) {
      if (start !== undefined) loadCandidates();
      setDismissedAt(undefined);
    }
    setTyped(
      followTyped(start === occurrence ? typed : undefined, start, edit),
    );
    if (edit !== undefined)
      setMemory((current) =>
        value === "" ? NO_MEMORY : followChosen(current, edit, value),
      );
    if (
      start !== occurrence ||
      value.slice(0, selectionStart) !== body.slice(0, cursor)
    )
      setActive(0);
    setCursor(selectionStart);
  }

  function choose(candidate: MentionCandidate): void {
    if (!mention) return;
    startDraft();
    const next = insertMention(body, mention, candidate.name);
    caret.current = next.caret;
    setBody(next.body);
    const at = next.body.indexOf("@", mention.start);
    setMemory((current) => ({
      ...current,
      chosen: [
        ...followChosen(
          current,
          {
            start: mention.start,
            end: mention.end,
            inserted:
              next.body.length - body.length + mention.end - mention.start,
          },
          next.body,
        ).chosen,
        { start: at, end: at + 1 + candidate.name.length, valid: true },
      ],
    }));
    // The finished `@<name> ` offers nothing more; staying on it reads nothing.
    setCursor(next.caret);
    // Choosing ends the typed `@`: the inserted name is an existing mention
    // from now on, so moving back into it can swap it as a whole.
    setTyped(undefined);
    textarea.current?.focus();
  }

  function chooseAttachment(
    query: AttachmentQuery,
    candidate: AttachmentCandidate,
  ): void {
    startDraft();
    const next = insertAttachmentRef(body, query, candidate.token);
    caret.current = next.caret;
    setBody(next.body);
    setMemory((current) =>
      followChosen(
        current,
        {
          start: query.start,
          end: query.end,
          inserted: next.body.length - body.length + query.end - query.start,
        },
        next.body,
      ),
    );
    setTyped(undefined);
    setCursor(next.caret);
    textarea.current?.focus();
  }

  /** Add the files the server takes; say why the others were left out. */
  function addFiles(chosen: readonly File[]): void {
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
          draft: nextDraft.current++,
          idempotencyKey: crypto.randomUUID(),
          name: file.name || file.type,
          mime,
          file,
          note: "",
        });
    }
    setProblems(rejected);
    if (!accepted.length) return;
    startDraft();
    setFiles((current) => [...current, ...accepted]);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.nativeEvent.isComposing) return;
    if (attachmentListOpen && reference) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setAttachmentDismissedAt(reference.start);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setAttachmentActive(
          (attachmentCurrent + step + attachmentMatches.length) %
            attachmentMatches.length,
        );
      } else if (
        (event.key === "Enter" || event.key === "Tab") &&
        !event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        const candidate = attachmentMatches[attachmentCurrent];
        if (!candidate) return;
        event.preventDefault();
        chooseAttachment(reference, candidate);
      }
      return;
    }
    if (!listOpen) return;
    if (event.key === "Escape") {
      // Close the list only; an enclosing drawer stays open.
      event.preventDefault();
      event.stopPropagation();
      setDismissedAt(mention?.start);
      return;
    }
    if (matches.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current + step + matches.length) % matches.length);
    } else if (
      (event.key === "Enter" || event.key === "Tab") &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      const candidate = matches[current];
      if (!candidate) return;
      event.preventDefault();
      choose(candidate);
    }
  }

  async function submit(): Promise<void> {
    if (!canSubmit || sending.current) return;
    if (
      files.some(
        (file) =>
          [...file.note].length > 200 ||
          /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(file.note),
      )
    ) {
      setError("附件说明最多 200 字符，不能包含控制字符或换行。");
      return;
    }
    // Refuse before posting: the comment is created first, attachments follow.
    if (
      attachmentLimit !== undefined &&
      files.some(
        (pending) =>
          !isVideoType(pending.mime) && pending.file.size > attachmentLimit,
      )
    ) {
      setError(`附件不能超过 ${formatMiB(attachmentLimit)}。`);
      return;
    }
    if (
      videoLimit !== undefined &&
      files.some(
        (pending) =>
          isVideoType(pending.mime) && pending.file.size > videoLimit,
      )
    ) {
      setError(`视频不能超过 ${formatMiB(videoLimit)}。`);
      return;
    }
    const sent = numberPendingRefs(
      body,
      files.map((file) => file.draft),
    );
    if (sent.missing.length) {
      setError(`正文引用的文件已移除：${sent.missing.join("、")}`);
      return;
    }
    sending.current = true;
    setSubmitting(true);
    setError(undefined);
    let comment: PostedComment | undefined;
    try {
      comment = await client.addComment(
        projectId,
        cardId,
        {
          body: sent.body,
          ...(mentionsIn(sent.body).length > 0
            ? { mentions: mentionsIn(sent.body) }
            : {}),
        },
        startDraft(),
      );
      if (files.length) setPosted(true);
      // One at a time, in the box's order. Each file fills its own slot N of
      // the body's `attachment-new-N`, so a retry or another upload to the
      // comment never shifts what N names.
      for (const [index, file] of files.entries()) {
        if (file.uploaded) continue;
        const filename = uploadFilename(file.file.name);
        const update = (patch: Partial<PendingFile>) =>
          setFiles((current) =>
            current.map((item) =>
              item.id === file.id ? { ...item, ...patch } : item,
            ),
          );
        // C-683: the browser measures a video and draws its cover once (a
        // retry resends the same request), then sends it in chunks; a retry
        // resumes the upload.
        const video = isVideoType(file.mime);
        const measured = video
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
            ...(file.note.trim() ? { note: file.note } : {}),
            mime: file.mime,
            kind: "evidence",
            attach_to: { kind: "timeline_entry", id: comment.id },
            ref_slot: index + 1,
          },
          file.idempotencyKey,
        );
        setFiles((current) =>
          current.map((item) =>
            item.id === file.id ? { ...item, uploaded: receipt.id } : item,
          ),
        );
      }
      setBody("");
      setFiles([]);
      setProblems([]);
      setPosted(false);
      nextDraft.current = 1;
      draftKey.current = undefined;
      setTab("write");
      setCursor(undefined);
      setDismissedAt(undefined);
      setMemory(NO_MEMORY);
      if (section.current?.contains(document.activeElement))
        (document.activeElement as HTMLElement).blur();
      setFocused(false);
      try {
        await onPosted?.(comment);
      } catch (failure) {
        setError(`评论已发表，但刷新失败：${describeError(failure)}`);
      }
    } catch (failure) {
      // The text stays in the box: a failed submit must not lose the comment.
      if (
        !comment &&
        failure instanceof ApiError &&
        failure.code === "idempotency_conflict"
      ) {
        resetDraftKey();
        const message =
          "上一次的评论已经发表。当前正文已保留，再次点击发表评论会作为新评论发表。";
        setError(message);
        try {
          await onConflict?.();
        } catch (refreshFailure) {
          setError(
            `${message} 时间线刷新失败：${describeError(refreshFailure)}`,
          );
        }
      } else {
        setError(
          comment
            ? `评论已发表，附件上传失败：${describeWriteError(failure, "上传可能已经成功，保留原内容重试不会重复上传。")}`
            : describeWriteError(failure, "发表可能已经成功，重试不会重复发表"),
        );
      }
    } finally {
      sending.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section
      ref={section}
      className="comment-box ui-drop-target"
      aria-label="写评论"
      data-dragging={dragging ? "" : undefined}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false);
          if (!body.length && !files.length) setTab("write");
        }
      }}
      onDragEnter={(event) => {
        if (submitting || !hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (submitting || !hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDragging(false);
      }}
      onDrop={(event) => {
        setDragging(false);
        if (submitting || !hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {hasPmOps === false && (
        <p id={routingHintId} className="hint" role="status">
          这张卡目前没有人负责
        </p>
      )}
      {expanded && (
        <div className="ui-comment-toolbar">
          <div
            className="comment-tabs"
            role="tablist"
            aria-label="评论编辑方式"
          >
            <Button
              type="button"
              role="tab"
              aria-selected={tab === "write"}
              onClick={() => setTab("write")}
            >
              编写
            </Button>
            <Button
              type="button"
              role="tab"
              aria-selected={tab === "preview"}
              onClick={() => setTab("preview")}
            >
              预览
            </Button>
          </div>
          <FilePicker
            label="上传附件"
            accept={UPLOAD_ACCEPT}
            disabled={submitting}
            onFiles={addFiles}
          />
        </div>
      )}

      {tab === "write" ? (
        <>
          <Textarea
            ref={textarea}
            className="comment-input"
            aria-label="评论正文"
            aria-describedby={hasPmOps === false ? routingHintId : undefined}
            aria-autocomplete="list"
            data-escape-handled={
              listOpen || attachmentListOpen ? "" : undefined
            }
            aria-controls={listOpen || attachmentListOpen ? listId : undefined}
            aria-activedescendant={
              listOpen && matches.length > 0
                ? optionId(current)
                : attachmentListOpen
                  ? optionId(attachmentCurrent)
                  : undefined
            }
            placeholder={
              attachmentLimit === undefined
                ? "支持 Markdown；@ 提及员工；# 引用附件；可以粘贴图片或拖入文件"
                : `支持 Markdown；@ 提及；# 引用附件；单个文件不超过 ${formatMiB(attachmentLimit)}`
            }
            rows={expanded ? 6 : 2}
            value={body}
            disabled={submitting}
            onChange={(event) => {
              const value = event.target.value;
              if (!value.trim()) {
                resetDraftKey();
                setError(undefined);
              } else startDraft();
              setBody(value);
              const began = intent.current;
              intent.current = undefined;
              const edit =
                began?.before === body ? inputEdit(began, value) : undefined;
              trackMention(event.target, edit ?? null);
            }}
            onSelect={(event) => trackMention(event.currentTarget)}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              const pasted = Array.from(event.clipboardData.files).filter(
                (file) => file.type.startsWith("image/"),
              );
              if (pasted.length === 0) return;
              addFiles(pasted);
            }}
          />
          <SuggestionList
            open={listOpen || attachmentListOpen}
            onOpenChange={(open) => {
              if (open) return;
              if (attachmentListOpen)
                setAttachmentDismissedAt(reference?.start);
              else setDismissedAt(mention?.start);
            }}
            field={textarea}
            id={listId}
            label={attachmentListOpen ? "引用附件" : "提及员工"}
          >
            {attachmentListOpen && reference ? (
              attachmentMatches.map((candidate, index) => (
                <SuggestionOption
                  key={candidate.token}
                  id={optionId(index)}
                  active={index === attachmentCurrent}
                  icon={<AttachmentKindIcon kind={candidate.kind} />}
                  label={candidate.name}
                  meta={candidate.meta}
                  onActivate={() => setAttachmentActive(index)}
                  onSelect={() => chooseAttachment(reference, candidate)}
                />
              ))
            ) : loaded?.error !== undefined ? (
              <SuggestionStatus>未能加载员工：{loaded.error}</SuggestionStatus>
            ) : loaded?.employees === undefined ? (
              <SuggestionStatus>正在加载员工…</SuggestionStatus>
            ) : (
              matches.map((candidate, index) => (
                <SuggestionOption
                  key={candidate.id}
                  id={optionId(index)}
                  active={index === current}
                  icon={<EmployeeFace employee={candidate} size={24} />}
                  label={candidate.name}
                  meta={candidate.title}
                  onActivate={() => setActive(index)}
                  onSelect={() => choose(candidate)}
                />
              ))
            )}
          </SuggestionList>
        </>
      ) : (
        <AttachmentRefBody
          className="comment-preview markdown"
          html={body.trim().length === 0 ? "<p>（还没有内容）</p>" : preview}
        />
      )}

      {files.length > 0 && (
        <FileChipList label="待上传的附件">
          {files.map((file) => (
            <FileChip
              key={file.id}
              name={file.name}
              size={
                file.sent !== undefined && !file.uploaded
                  ? `${formatBytes(file.file.size)} · ${uploadPercent(file.sent, file.file.size)}%`
                  : formatBytes(file.file.size)
              }
              kind={attachmentRefKind(file.mime)}
              removeDisabled={submitting || posted}
              onRemove={() =>
                setFiles((current) =>
                  current.filter((item) => item.id !== file.id),
                )
              }
            >
              <Input
                type="text"
                aria-label={`${file.name} 的说明`}
                placeholder="说明（可选）"
                value={file.note}
                disabled={submitting || posted}
                onChange={(event) => {
                  const note = event.target.value;
                  setFiles((current) =>
                    current.map((item) =>
                      item.id === file.id
                        ? { ...item, note, idempotencyKey: crypto.randomUUID() }
                        : item,
                    ),
                  );
                }}
              />
            </FileChip>
          ))}
        </FileChipList>
      )}
      <FileProblems problems={problems} />

      <RequestFeedback
        interactive
        pending={submitting}
        pendingMessage="发表中…"
        error={error}
      />

      {expanded && (
        <div className="comment-actions">
          <Button
            type="button"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            发表评论
          </Button>
        </div>
      )}
    </section>
  );
}

export interface MentionQuery {
  /** Index of the `@`. */
  readonly start: number;
  /** What follows the `@` up to the caret. */
  readonly query: string;
  /** Where the text a chosen name replaces ends; at or after the caret. */
  readonly end: number;
}

/** The selection and kind of an input, read before the text changed. */
export interface InputIntent {
  readonly before: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  /** `InputEvent.inputType`, e.g. `insertText` or `deleteContentBackward`. */
  readonly inputType: string;
  /** Where the running IME composition began. */
  readonly compositionStart?: number;
}

/** One change: the old text's `[start, end)` became `inserted` characters. */
export interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly inserted: number;
}

/**
 * The range an input replaced, from the selection it began with: the
 * selection itself, the composition so far, or for a collapsed delete the
 * characters before or after the caret. Undefined when the new text does not
 * agree with that range, so callers can stay on the safe side.
 */
export function inputEdit(
  intent: InputIntent,
  after: string,
): TextEdit | undefined {
  const { before, selectionStart, selectionEnd, inputType } = intent;
  let start = selectionStart;
  let end = selectionEnd;
  if (
    inputType === "insertCompositionText" &&
    intent.compositionStart !== undefined
  )
    start = Math.min(start, intent.compositionStart);
  else if (start === end && inputType.startsWith("delete")) {
    const removed = before.length - after.length;
    if (inputType.endsWith("Backward")) start -= removed;
    else end += removed;
  }
  const inserted = after.length - before.length + (end - start);
  return start >= 0 &&
    end <= before.length &&
    inserted >= 0 &&
    after.slice(0, start) === before.slice(0, start) &&
    after.slice(start + inserted) === before.slice(end)
    ? { start, end, inserted }
    : undefined;
}

export interface TypedMention {
  /** Index of an `@` the user typed. */
  readonly start: number;
  /**
   * Where the text that already followed the input of the `@` begins now;
   * undefined when an edit's range was not known.
   */
  readonly keep: number | undefined;
}

/** A name put in by choosing it: `@` at `start`, the name up to `end`. */
export interface ChosenMention {
  readonly start: number;
  readonly end: number;
  /** False once an edit touched the name: its end is no longer proven. */
  readonly valid: boolean;
}

export interface MentionMemory {
  readonly chosen: readonly ChosenMention[];
  /** An edit of unknown range happened while names were recorded. */
  readonly lost: boolean;
}

export const NO_MEMORY: MentionMemory = { chosen: [], lost: false };

/**
 * Follow chosen names through one change (`null` when its range is not
 * known; `text` is the text after it), with the `@` at `a` and the name up to
 * `b`, the edit replacing `[s, e)`:
 * - `e <= a`, before the `@`: the name moves;
 * - `s > b`, after the name: it stays;
 * - `s = b`, at the name's end: it stays when the edit only deletes there or
 *   puts in a space or punctuation first, and only its `@` is known when it
 *   puts in a letter, digit or Han character that runs on the name;
 * - `a < s < b`, inside the name: only its `@` is known;
 * - `s <= a < e`, the `@` removed: it is dropped.
 * Without a known range nothing can be followed, so every `@` counts as
 * edited from then on. A name once marked edited never becomes trusted again.
 */
export function followChosen(
  memory: MentionMemory,
  edit: TextEdit | null,
  text = "",
): MentionMemory {
  if (edit === null)
    return memory.chosen.length > 0 ? { chosen: [], lost: true } : memory;
  const grown = edit.inserted - (edit.end - edit.start);
  const chosen: ChosenMention[] = [];
  for (const name of memory.chosen) {
    if (edit.end <= name.start)
      chosen.push({
        ...name,
        start: name.start + grown,
        end: name.end + grown,
      });
    else if (edit.start > name.end) chosen.push(name);
    else if (edit.start === name.end)
      chosen.push(
        edit.inserted > 0 && WORD.test(text.slice(edit.start))
          ? { ...name, valid: false }
          : name,
      );
    else if (edit.start > name.start) chosen.push({ ...name, valid: false });
  }
  return { ...memory, chosen };
}

/**
 * Follow a typed `@` through one change (`edit`; `null` when its range is not
 * known; undefined for a caret move). An `@` counts as typed when the edit
 * inserted it; the text after the edit's range is kept from then on.
 */
export function followTyped(
  typed: TypedMention | undefined,
  start: number | undefined,
  edit: TextEdit | null | undefined,
): TypedMention | undefined {
  if (start === undefined) return undefined;
  if (edit === undefined) return typed?.start === start ? typed : undefined;
  if (typed?.start !== start) {
    if (edit === null) return { start, keep: undefined };
    return start >= edit.start && start < edit.start + edit.inserted
      ? { start, keep: edit.start + edit.inserted }
      : undefined;
  }
  const { keep } = typed;
  if (edit === null || keep === undefined) return { start, keep: undefined };
  const grown = edit.inserted - (edit.end - edit.start);
  if (edit.end <= keep) return { start, keep: keep + grown };
  if (edit.start < keep) return { start, keep: edit.start + edit.inserted };
  return typed;
}

/**
 * Where the `@` the caret is in starts, whatever the candidates: the last `@`
 * on the caret's line, not inside an e-mail and not followed by a space.
 */
export function mentionAt(text: string, caret: number): number | undefined {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("@");
  if (start < 0 || /[A-Za-z0-9._%+-]/u.test(before[start - 1] ?? ""))
    return undefined;
  return /^\s|[\n\r\u2028\u2029]/u.test(before.slice(start + 1))
    ? undefined
    : start;
}

/**
 * The `@query` being typed right before the caret; never inside an e-mail.
 * The query may hold spaces while it still matches a candidate's name (as in
 * `Mary Jane`); a full name followed by a space is a finished mention.
 * After a typed `@`, a chosen name replaces what was typed: the candidate
 * name or Latin word it spells, never the text kept from before (nothing is
 * offered with the caret inside that text, and when the range is not known
 * only the text before the caret is replaced). With the caret moved into an
 * old mention, the shortest name the text fully spells up to a space,
 * punctuation or the end is replaced; inside any other word nothing is
 * offered. A chosen name (`memory`) is replaced exactly as it was put in;
 * once edited, or after an edit of unknown range, only up to the caret.
 */
export function mentionQuery(
  text: string,
  caret: number,
  candidates: readonly MentionCandidate[] = [],
  typed?: TypedMention,
  memory: MentionMemory = NO_MEMORY,
): MentionQuery | undefined {
  const start = mentionAt(text, caret);
  if (start === undefined) return undefined;
  const query = text.slice(start + 1, caret);
  if (/\s/u.test(query)) {
    const key = query.toLowerCase();
    const names = candidates.map((c) => c.name.toLowerCase());
    if (
      (/\s$/u.test(key) && names.includes(key.trimEnd())) ||
      !names.some((name) => name.includes(key))
    )
      return undefined;
  }
  const chosen = memory.chosen.find((name) => name.start === start);
  if (chosen)
    return {
      start,
      query,
      end: chosen.valid && caret <= chosen.end ? chosen.end : caret,
    };
  if (typed?.start === start) {
    const { keep } = typed;
    if (keep === undefined) return { start, query, end: caret };
    if (caret > keep) return undefined;
    let end = Math.min(spelledEnd(text, start, caret, candidates, false), keep);
    if (end === caret && /[A-Za-z0-9_-]$/u.test(query))
      end = Math.min(
        keep,
        caret + (/^[A-Za-z0-9_-]*/u.exec(text.slice(caret))?.[0].length ?? 0),
      );
    return { start, query, end };
  }
  if (memory.lost) return { start, query, end: caret };
  const end = spelledEnd(text, start, caret, candidates, true);
  if (end === caret && WORD.test(text.slice(caret))) return undefined;
  return { start, query, end };
}

const WORD = /^[\p{L}\p{N}\p{M}_-]/u;

/**
 * The end of the shortest candidate name spelled after the `@` that reaches
 * the caret, else the caret: text after it that only a longer name would
 * take in stays. A Latin name must end its word (`@Bobx` does not spell
 * Bob); `whole` asks any name to be followed by a space, punctuation or the
 * end.
 */
function spelledEnd(
  text: string,
  start: number,
  caret: number,
  candidates: readonly MentionCandidate[],
  whole: boolean,
): number {
  const latin = /^[A-Za-z0-9_-]/u;
  let end: number | undefined;
  for (const { name } of candidates) {
    const after = start + 1 + name.length;
    const next = text.slice(after);
    const runsOn = whole
      ? WORD.test(next)
      : /[A-Za-z0-9_-]$/u.test(name) && latin.test(next);
    if (
      after >= caret &&
      !runsOn &&
      text.slice(start + 1, after).toLowerCase() === name.toLowerCase()
    )
      end = Math.min(end ?? after, after);
  }
  return end ?? caret;
}

/** The card's own people first, then everyone; each group by name. */
export function orderMentionCandidates(
  candidates: readonly MentionCandidate[],
): MentionCandidate[] {
  return [...candidates].sort(
    (a, b) =>
      Number(b.related) - Number(a.related) ||
      a.name.localeCompare(b.name, "zh-Hans-CN") ||
      a.id.localeCompare(b.id),
  );
}

/** Candidates whose name contains the query, ignoring case; order is kept. */
export function matchMentionCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
): MentionCandidate[] {
  const key = query.toLowerCase();
  return candidates.filter((c) => c.name.toLowerCase().includes(key));
}

/**
 * Replace the typed `@query` (through `end`) with `@<name> `. The server only reads a mention
 * after a space, punctuation or the start, so one is added when needed.
 */
export function insertMention(
  body: string,
  mention: MentionQuery,
  name: string,
): { body: string; caret: number } {
  const before = body.slice(0, mention.start);
  const after = body.slice(mention.end);
  const lead = /[\p{L}\p{N}\p{M}_@]$/u.test(before) ? " " : "";
  const space = /^\s/u.test(after);
  const inserted = `${lead}@${name}${space ? "" : " "}`;
  return {
    body: before + inserted + after,
    caret: before.length + inserted.length + (space ? 1 : 0),
  };
}

/** `@coder` tokens in the body, de-duplicated, without the `@`. */
export function mentionsIn(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(/(^|\s)@([A-Za-z0-9][A-Za-z0-9_-]*)/gu)) {
    if (match[2] !== undefined) found.add(match[2]);
  }
  return [...found];
}

/** Whole percent of a video sent; 100 only once every byte is there. */
export function uploadPercent(sent: number, size: number): number {
  if (size <= 0 || sent >= size) return 100;
  return Math.min(99, Math.floor((sent * 100) / size));
}

/** A drag carries files (not text or a link). */
function hasFiles(transfer: DataTransfer | null): boolean {
  return Array.from(transfer?.types ?? []).includes("Files");
}

/** The box's files first (by draft number), then the card's newest first. */
export function attachmentCandidates(
  files: readonly Pick<PendingFile, "draft" | "name" | "mime" | "file">[],
  attachments: readonly AttachmentView[],
): AttachmentCandidate[] {
  return [
    ...files.map((file) => ({
      token: pendingToken(file.draft),
      name: file.name,
      meta: `待上传 · ${formatBytes(file.file.size)}`,
      kind: attachmentRefKind(file.mime),
    })),
    ...[...attachments].reverse().map((attachment) => ({
      token: attachment.id,
      name: attachment.original_filename || attachment.id,
      meta: attachment.id,
      kind: attachmentRefKind(attachment.mime, attachment.inline),
    })),
  ];
}

/** Candidates whose name or number contains the query, ignoring case. */
export function matchAttachmentCandidates(
  candidates: readonly AttachmentCandidate[],
  query: string,
): AttachmentCandidate[] {
  const key = query.toLowerCase();
  return candidates.filter(
    (c) =>
      c.name.toLowerCase().includes(key) || c.token.toLowerCase().includes(key),
  );
}

function AttachmentKindIcon({ kind }: { kind: AttachmentRefTarget["kind"] }) {
  const Icon =
    kind === "image"
      ? Image
      : kind === "video"
        ? Film
        : kind === "file"
          ? FileIcon
          : FileText;
  return <Icon className="ui-file-chip-icon" aria-hidden="true" />;
}
