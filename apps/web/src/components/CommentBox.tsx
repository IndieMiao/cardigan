// biome-ignore-all lint/security/noDangerouslySetInnerHtml: the preview is
// `renderMarkdown` output (html off, filtered links), not raw user HTML.
import { useMemo, useRef, useState } from "react";
import { renderMarkdown } from "../markdown.js";

/**
 * The comment box (M5 plan §3.7, §4 M5.3).
 *
 * A plain Markdown textarea with a preview — not a WYSIWYG editor. Mentions are
 * offered as buttons after an `@`, pasted images are counted and shown, and the
 * send button stays disabled: `POST /api/.../comments` arrives with M5.2, and a
 * box that silently drops what you typed would be worse than a disabled button.
 */

export interface MentionOption {
  readonly value: string;
  readonly label: string;
}

export interface CommentBoxProps {
  readonly mentions?: readonly MentionOption[];
  readonly onPreview?: (markdown: string) => void;
}

export function CommentBox({ mentions = [], onPreview }: CommentBoxProps) {
  const [body, setBody] = useState("");
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [images, setImages] = useState<readonly string[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const preview = useMemo(() => renderMarkdown(body), [body]);

  function insertMention(mention: string): void {
    const field = textarea.current;
    const at = field?.selectionStart ?? body.length;
    // Replace the `@` that opened the suggestion list.
    const before = body.slice(0, at).replace(/@[^\s@]*$/u, "");
    const next = `${before}@${mention} ${body.slice(at)}`;
    setBody(next);
    setSuggesting(false);
    field?.focus();
  }

  return (
    <section className="comment-box" aria-label="写评论">
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
          onClick={() => {
            setTab("preview");
            onPreview?.(body);
          }}
        >
          预览
        </button>
      </div>

      {tab === "write" ? (
        <>
          <textarea
            ref={textarea}
            className="comment-input"
            aria-label="评论正文"
            placeholder="支持 Markdown；@ 提及角色或 Assignment"
            rows={6}
            value={body}
            onChange={(event) => {
              const value = event.target.value;
              setBody(value);
              setSuggesting(/@[^\s@]*$/u.test(value));
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files).filter(
                (file) => file.type.startsWith("image/"),
              );
              if (files.length === 0) return;
              setImages((current) => [
                ...current,
                ...files.map((file) => file.name || file.type),
              ]);
            }}
          />
          {suggesting && mentions.length > 0 && (
            <ul className="mention-list" aria-label="提及建议">
              {mentions.map((mention) => (
                <li key={mention.value}>
                  <button
                    type="button"
                    className="quiet"
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
          已捕获 {images.length} 张图片（{images.join("、")}
          ）。图片上传接口随 M5.2 提供，届时会随评论一起提交。
        </p>
      )}

      <div className="comment-actions">
        <button type="button" disabled title="评论提交接口随 M5.2 提供">
          发表评论
        </button>
        <span className="hint">写接口随 M5.2 提供，本页目前只能预览。</span>
      </div>
    </section>
  );
}
