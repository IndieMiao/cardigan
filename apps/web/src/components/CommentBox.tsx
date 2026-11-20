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
  const mention =
    cursor === undefined ? undefined : mentionQuery(body, cursor, ordered);
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
  // leaving the card; the previous list stays up meanwhile. Typing within one
  // `@` reads nothing.
  function loadCandidates(): void {
    const read = ++candidateRead.current;
    setCandidates((previous) =>
      previous?.cardId === cardId && previous.employees
        ? { cardId, employees: previous.employees }
        : { cardId },
    );
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

  /** Recompute the `@query` before the caret after typing or moving it. */
  function trackMention(field: HTMLTextAreaElement): void {
    const next = mentionQuery(field.value, field.selectionStart, ordered);
    if (next?.start !== mention?.start) {
      if (next) loadCandidates();
      setDismissedAt(undefined);
    }
    if (next?.start !== mention?.start || next?.query !== mention?.query)
      setActive(0);
    setCursor(field.selectionStart);
  }

  function choose(candidate: MentionCandidate): void {
    if (!mention) return;
    startDraft();
    const next = insertMention(body, mention, candidate.name);
    caret.current = next.caret;
    setBody(next.body);
    setCursor(undefined);
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
            placeholder="支持 Markdown；@ 提及员工；可以直接粘贴图片"
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
              trackMention(event.target);
            }}
            onSelect={(event) => trackMention(event.currentTarget)}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files).filter(
                (file) => file.type.startsWith("image/"),
              );
              if (files.length === 0) return;
              startDraft();
              setImages((current) => [
                ...current,
                ...files.map((file) => ({
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

/**
 * The `@query` being typed right before the caret; never inside an e-mail.
 * The query may hold spaces while it still matches a candidate's name (as in
 * `Mary Jane`); a full name followed by a space is a finished mention.
 */
export function mentionQuery(
  text: string,
  caret: number,
  candidates: readonly MentionCandidate[] = [],
): MentionQuery | undefined {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("@");
  if (start < 0 || /[A-Za-z0-9._%+-]/u.test(before[start - 1] ?? ""))
    return undefined;
  const query = before.slice(start + 1);
  if (/^\s|[\n\r\u2028\u2029]/u.test(query)) return undefined;
  if (/\s/u.test(query)) {
    const key = query.toLowerCase();
    const names = candidates.map((c) => c.name.toLowerCase());
    if (
      (/\s$/u.test(key) && names.includes(key.trimEnd())) ||
      !names.some((name) => name.includes(key))
    )
      return undefined;
  }
  return { start, query, end: mentionEnd(text, start, caret, candidates) };
}

/**
 * With the caret inside an existing mention, a chosen name replaces all of it,
 * so no old tail is left behind: the longest candidate name the text already
 * spells, or else the rest of a Latin word. Han text has no spaces, so beyond
 * a known name only the text before the caret is replaced.
 */
function mentionEnd(
  text: string,
  start: number,
  caret: number,
  candidates: readonly MentionCandidate[],
): number {
  const word = /^[A-Za-z0-9_-]*/u;
  let end = caret;
  if (/[A-Za-z0-9_-]$/u.test(text.slice(start + 1, caret)))
    end += word.exec(text.slice(caret))?.[0].length ?? 0;
  for (const { name } of candidates) {
    const after = start + 1 + name.length;
    const spelled = text.slice(start + 1, after);
    // `@Bobx` does not spell Bob: a Latin word must end with the name.
    if (
      spelled.toLowerCase() === name.toLowerCase() &&
      !(/[A-Za-z0-9_-]$/u.test(name) && word.exec(text.slice(after))?.[0])
    )
      end = Math.max(end, after);
  }
  return end;
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

/** Canonical padded base64 of a pasted image (the API decodes it strictly). */
export async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
