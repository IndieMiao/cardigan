// biome-ignore-all lint/security/noDangerouslySetInnerHtml: the preview is
// `renderMarkdown` output (html off, filtered links), not raw user HTML.
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
  type CardiganClient,
  describeError,
  describeWriteError,
  type MentionCandidate,
  type PostedComment,
} from "../api.js";
import { renderMarkdown } from "../markdown.js";
import { EmployeeFace } from "./EmployeeIdentity.js";
import { RequestFeedback } from "./RequestFeedback.js";
import { Button } from "./ui/button.js";
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
 * hand-typed `@role` / `@A-n` keep working. Pasted images are uploaded and
 * attached to the comment's timeline entry, and the send button is live: the
 * comment is posted as the human, through `POST /cards/:card/comments`, and
 * every pasted image goes to `POST /cards/:card/attachments` attached to that
 * entry.
 */

export interface CommentBoxProps {
  readonly ref?: Ref<CommentBoxHandle>;
  readonly client: CardiganClient;
  readonly projectId: string;
  readonly cardId: string;
  readonly hasPmOps?: boolean | undefined;
  /** Called after the comment and its images were accepted. */
  readonly onPosted?: (comment: PostedComment) => void | Promise<void>;
  /** Refresh the timeline when a previous comment was accepted with different text. */
  readonly onConflict?: () => void | Promise<void>;
}

export interface CommentBoxHandle {
  focus(onFocused: (input: HTMLTextAreaElement) => void): void;
}

interface PastedImage {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly name: string;
  readonly mime: string;
  readonly file: File;
  readonly note: string;
}

export function CommentBox({
  ref,
  client,
  projectId,
  cardId,
  hasPmOps,
  onPosted,
  onConflict,
}: CommentBoxProps) {
  const routingHintId = useId();
  const listId = useId();
  const [body, setBody] = useState("");
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [images, setImages] = useState<readonly PastedImage[]>([]);
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
    // Retained files will attach to a new comment, so they need new keys too.
    setImages((current) =>
      current.map((image) => ({
        ...image,
        idempotencyKey: crypto.randomUUID(),
      })),
    );
  };
  const expanded = focused || body.length > 0 || images.length > 0;

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

  const preview = useMemo(() => renderMarkdown(body), [body]);
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
  const suggesting =
    expanded &&
    tab === "write" &&
    !submitting &&
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
    if (!listOpen) return;
    document
      .getElementById(optionId(current))
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

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (!listOpen || event.nativeEvent.isComposing) return;
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
      images.some(
        (image) =>
          [...image.note].length > 200 ||
          /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(image.note),
      )
    ) {
      setError("附件说明最多 200 字符，不能包含控制字符或换行。");
      return;
    }
    // Refuse before posting: the comment is created first, attachments follow.
    if (
      attachmentLimit !== undefined &&
      images.some((image) => image.file.size > attachmentLimit)
    ) {
      setError(`附件不能超过 ${formatMiB(attachmentLimit)}。`);
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
          body,
          ...(mentionsIn(body).length > 0
            ? { mentions: mentionsIn(body) }
            : {}),
        },
        startDraft(),
      );
      for (const image of images) {
        await client.uploadAttachment(
          projectId,
          cardId,
          {
            file: await toBase64(image.file),
            ...(image.file.name ? { original_filename: image.file.name } : {}),
            ...(image.note.trim() ? { note: image.note } : {}),
            mime: image.mime,
            kind: "evidence",
            attach_to: { kind: "timeline_entry", id: comment.id },
          },
          image.idempotencyKey,
        );
      }
      setBody("");
      setImages([]);
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
      className="comment-box"
      aria-label="写评论"
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false);
          if (!body.length && !images.length) setTab("write");
        }
      }}
    >
      {hasPmOps === false && (
        <p id={routingHintId} className="hint" role="status">
          这张卡目前没有人负责
        </p>
      )}
      {expanded && (
        <div className="comment-tabs" role="tablist" aria-label="评论编辑方式">
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
      )}

      {tab === "write" ? (
        <>
          <Textarea
            ref={textarea}
            className="comment-input"
            aria-label="评论正文"
            aria-describedby={hasPmOps === false ? routingHintId : undefined}
            aria-autocomplete="list"
            data-escape-handled={listOpen ? "" : undefined}
            aria-controls={listOpen ? listId : undefined}
            aria-activedescendant={
              listOpen && matches.length > 0 ? optionId(current) : undefined
            }
            placeholder={
              attachmentLimit === undefined
                ? "支持 Markdown；@ 提及员工；可以直接粘贴图片"
                : `支持 Markdown；@ 提及员工；可以直接粘贴图片，单张不超过 ${formatMiB(attachmentLimit)}`
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
              const files = Array.from(event.clipboardData.files).filter(
                (file) => file.type.startsWith("image/"),
              );
              if (files.length === 0) return;
              // Refuse an oversized image here: once listed it could not be
              // removed and would block the comment (C-616).
              const accepted =
                attachmentLimit === undefined
                  ? files
                  : files.filter((file) => file.size <= attachmentLimit);
              if (
                attachmentLimit !== undefined &&
                accepted.length < files.length
              )
                setError(`附件不能超过 ${formatMiB(attachmentLimit)}。`);
              if (accepted.length === 0) return;
              startDraft();
              setImages((current) => [
                ...current,
                ...accepted.map((file) => ({
                  id: crypto.randomUUID(),
                  idempotencyKey: crypto.randomUUID(),
                  name: file.name || file.type,
                  mime: file.type,
                  file,
                  note: "",
                })),
              ]);
            }}
          />
          <SuggestionList
            open={listOpen}
            onOpenChange={(open) => {
              if (!open) setDismissedAt(mention?.start);
            }}
            field={textarea}
            id={listId}
            label="提及员工"
          >
            {loaded?.error !== undefined ? (
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
        <div
          className="comment-preview markdown"
          dangerouslySetInnerHTML={{
            __html:
              body.trim().length === 0 ? "<p>（还没有内容）</p>" : preview,
          }}
        />
      )}

      {images.length > 0 && (
        <div className="notice">
          <p>已捕获 {images.length} 张图片，随评论一起作为证据附件上传。</p>
          {images.map((image) => (
            <label className="attachment-caption" key={image.id}>
              <span>{image.name}</span>
              <Input
                type="text"
                aria-label={`${image.name} 的说明`}
                placeholder="附件说明（可选，最多 200 字符）"
                value={image.note}
                disabled={submitting}
                onChange={(event) => {
                  const note = event.target.value;
                  setImages((current) =>
                    current.map((item) =>
                      item.id === image.id
                        ? { ...item, note, idempotencyKey: crypto.randomUUID() }
                        : item,
                    ),
                  );
                }}
              />
            </label>
          ))}
        </div>
      )}

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
          <span className="hint">
            以你的身份发表；正文支持 Markdown，编号由服务端识别成链接。
          </span>
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

const formatMiB = (bytes: number) =>
  bytes % 1048576 === 0
    ? `${bytes / 1048576} MiB`
    : `${(bytes / 1048576).toFixed(1)} MiB`;

/** Canonical padded base64 of a pasted image (the API decodes it strictly). */
export async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
