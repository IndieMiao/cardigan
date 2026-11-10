// biome-ignore-all lint/security/noDangerouslySetInnerHtml: the preview is
// `renderMarkdown` output (html off, filtered links), not raw user HTML.
import {
  type Ref,
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
  type PostedComment,
} from "../api.js";
import { renderMarkdown } from "../markdown.js";

/**
 * The comment box (M5 plan §3.7, §4 M5.3; the write endpoints arrive with M5.2).
 *
 * A plain Markdown textarea with a preview — not a WYSIWYG editor. Mentions are
 * offered as buttons after an `@`, pasted images are uploaded and attached to
 * the comment's timeline entry, and the send button is live: the comment is
 * posted as the human, through `POST /cards/:card/comments`, and every pasted
 * image goes to `POST /cards/:card/attachments` attached to that entry.
 */

export interface MentionOption {
  readonly value: string;
  readonly label: string;
}

export interface CommentBoxProps {
  readonly ref?: Ref<CommentBoxHandle>;
  readonly client: CardiganClient;
  readonly projectId: string;
  readonly cardId: string;
  readonly mentions?: readonly MentionOption[];
  /** Called after the comment and its images were accepted. */
  readonly onPosted?: (comment: PostedComment) => void | Promise<void>;
  /** Refresh the timeline when a previous comment was accepted with different text. */
  readonly onConflict?: () => void | Promise<void>;
}

export interface CommentBoxHandle {
  focus(onFocused: (input: HTMLTextAreaElement) => void): void;
}

interface PastedImage {
  readonly idempotencyKey: string;
  readonly name: string;
  readonly mime: string;
  readonly file: File;
}

export function CommentBox({
  ref,
  client,
  projectId,
  cardId,
  mentions = [],
  onPosted,
  onConflict,
}: CommentBoxProps) {
  const [body, setBody] = useState("");
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [images, setImages] = useState<readonly PastedImage[]>([]);
  const [suggesting, setSuggesting] = useState(false);
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

  function insertMention(mention: string): void {
    startDraft();
    const field = textarea.current;
    const at = field?.selectionStart ?? body.length;
    // Replace the `@` that opened the suggestion list.
    const before = body.slice(0, at).replace(/@[^\s@]*$/u, "");
    const next = `${before}@${mention} ${body.slice(at)}`;
    setBody(next);
    setSuggesting(false);
    field?.focus();
  }

  async function submit(): Promise<void> {
    if (!canSubmit || sending.current) return;
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
      setSuggesting(false);
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
      {expanded && (
        <div className="comment-tabs" role="tablist" aria-label="评论编辑方式">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "write"}
            onClick={() => setTab("write")}
          >
            编写
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "preview"}
            onClick={() => setTab("preview")}
          >
            预览
          </button>
        </div>
      )}

      {tab === "write" ? (
        <>
          <textarea
            ref={textarea}
            className="comment-input"
            aria-label="评论正文"
            placeholder="支持 Markdown；@ 提及角色或 Assignment；可以直接粘贴图片"
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
              setSuggesting(/@[^\s@]*$/u.test(value));
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files).filter(
                (file) => file.type.startsWith("image/"),
              );
              if (files.length === 0) return;
              startDraft();
              setImages((current) => [
                ...current,
                ...files.map((file) => ({
                  idempotencyKey: crypto.randomUUID(),
                  name: file.name || file.type,
                  mime: file.type,
                  file,
                })),
              ]);
            }}
          />
          {expanded && suggesting && mentions.length > 0 && (
            <ul className="mention-list" aria-label="提及建议">
              {mentions.map((mention) => (
                <li key={mention.value}>
                  <button
                    type="button"
                    className="quiet"
                    disabled={submitting}
                    onClick={() => insertMention(mention.value)}
                  >
                    {mention.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
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
        <p className="notice">
          已捕获 {images.length} 张图片（
          {images.map((image) => image.name).join("、")}
          ），随评论一起作为证据附件上传。
        </p>
      )}

      {error !== undefined && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {expanded && (
        <div className="comment-actions">
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {submitting ? "发表中…" : "发表评论"}
          </button>
          <span className="hint">
            以你的身份发表；正文支持 Markdown，编号由服务端识别成链接。
          </span>
        </div>
      )}
    </section>
  );
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
