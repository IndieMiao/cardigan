import { useRef, useState } from "react";
import {
  type CardDetail,
  type CardiganClient,
  describeWriteError,
} from "../api.js";
import { RequestFeedback } from "./RequestFeedback.js";

export function CardTemplate({
  detail,
  client,
  projectId,
  onSaved,
  showMetadata = true,
}: {
  detail: CardDetail;
  client: CardiganClient;
  projectId: string;
  onSaved: () => void;
  showMetadata?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const keys = useRef(new Map<string, string>());
  const template = detail.template;
  if (!template) return null;
  const allowed = detail.mark_done?.allowed === true;
  return (
    <div className="card-template">
      {showMetadata && (
        <p>
          模板：{template.title} · v{template.version}
        </p>
      )}
      {template.completion.mode === "human_mark_done" && (
        <>
          {!open && (
            <button
              type="button"
              disabled={!allowed || busy}
              onClick={() => setOpen(true)}
            >
              标记完成
            </button>
          )}
          {!allowed && (
            <p className="hint">
              {detail.mark_done?.reason ?? "当前会话不能标记完成。"}
            </p>
          )}
          {open && (
            <form
              className="card-action-form"
              aria-label="标记完成"
              onSubmit={async (event) => {
                event.preventDefault();
                if (sending.current || !allowed || !result.trim()) return;
                sending.current = true;
                setBusy(true);
                setError("");
                const input = JSON.stringify([result, attachments]);
                const key = keys.current.get(input) ?? crypto.randomUUID();
                keys.current.set(input, key);
                try {
                  await client.markCardDone(
                    projectId,
                    detail.card.id,
                    result,
                    attachments,
                    key,
                  );
                  keys.current.delete(input);
                  setOpen(false);
                  setResult("");
                  setAttachments([]);
                  setMessage("卡片已标记完成。");
                  onSaved();
                } catch (cause) {
                  setError(describeWriteError(cause));
                } finally {
                  sending.current = false;
                  setBusy(false);
                }
              }}
            >
              <fieldset disabled={busy}>
                <label>
                  完成结果
                  <textarea
                    required
                    rows={3}
                    value={result}
                    onChange={(e) => setResult(e.target.value)}
                  />
                </label>
                <fieldset>
                  <legend>证据附件（可选）</legend>
                  {detail.attachments.length === 0 && <p>本卡暂无附件。</p>}
                  {detail.attachments.map((a) => (
                    <label key={a.id}>
                      <input
                        type="checkbox"
                        checked={attachments.includes(a.id)}
                        onChange={(e) =>
                          setAttachments((old) =>
                            e.target.checked
                              ? [...old, a.id].sort()
                              : old.filter((id) => id !== a.id),
                          )
                        }
                      />
                      {a.id}
                      {a.original_filename ? ` · ${a.original_filename}` : ""}
                    </label>
                  ))}
                </fieldset>
                <div className="card-action-buttons">
                  <button type="submit" disabled={!allowed || !result.trim()}>
                    确认标记完成
                  </button>
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => setOpen(false)}
                  >
                    暂不完成
                  </button>
                </div>
              </fieldset>
              <RequestFeedback
                interactive
                pending={busy}
                pendingMessage="正在提交…"
                error={error}
              />
            </form>
          )}
        </>
      )}
      <RequestFeedback message={message} />
    </div>
  );
}
