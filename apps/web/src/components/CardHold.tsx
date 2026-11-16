import { useEffect, useRef, useState } from "react";
import {
  type CardiganClient,
  type CardView,
  describeWriteError,
} from "../api.js";
import { RequestFeedback } from "./RequestFeedback.js";

export function CardHoldDetails({
  card,
  compact = false,
}: {
  card: Pick<CardView, "hold">;
  compact?: boolean;
}) {
  if (!card.hold) return null;
  return (
    <div className={`card-hold-details${compact ? " card-hold-compact" : ""}`}>
      <strong className="card-hold-tag">已暂停</strong>
      <p title={compact ? card.hold.reason : undefined}>
        原因：{card.hold.reason}
      </p>
      <p title={compact ? card.hold.resume_condition : undefined}>
        恢复条件：{card.hold.resume_condition}
      </p>
    </div>
  );
}

export function CardHoldActions({
  card,
  client,
  projectId,
  onSaved,
}: {
  card: CardView;
  client: CardiganClient;
  projectId: string;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState(card.hold?.reason ?? "");
  const [condition, setCondition] = useState(card.hold?.resume_condition ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const sending = useRef(false);
  const keys = useRef(new Map<string, string>());
  const field = useRef<HTMLTextAreaElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (!editing && !pending && returnFocus.current) {
      returnFocus.current = false;
      toggle.current?.focus();
    }
  }, [editing, pending]);
  useEffect(() => {
    if (editing) field.current?.focus();
  }, [editing]);
  const close = () => {
    returnFocus.current = true;
    setEditing(false);
  };
  const save = async (
    hold: { reason: string; resume_condition: string } | null,
  ) => {
    if (sending.current) return;
    sending.current = true;
    setPending(true);
    setError("");
    setMessage("");
    const request = JSON.stringify(hold);
    const key = keys.current.get(request) ?? crypto.randomUUID();
    keys.current.set(request, key);
    try {
      await client.updateCard(projectId, card.id, { hold }, key);
      keys.current.delete(request);
      close();
      setMessage(
        hold ? "卡片已暂停。" : "已解除暂停，按当前依赖和原有门禁继续。",
      );
      onSaved();
    } catch (cause) {
      setError(describeWriteError(cause));
    } finally {
      sending.current = false;
      setPending(false);
    }
  };
  return (
    <section className="card-hold" aria-label="卡片暂停">
      <CardHoldDetails card={card} />
      {!["done", "cancelled"].includes(card.status) && (
        <>
          <div className="card-action-buttons">
            <button
              ref={toggle}
              type="button"
              className="quiet"
              disabled={pending}
              aria-expanded={editing}
              onClick={() => {
                if (editing) close();
                else {
                  setReason(card.hold?.reason ?? "");
                  setCondition(card.hold?.resume_condition ?? "");
                  setEditing(true);
                }
              }}
            >
              {card.hold ? "修改暂停信息" : "暂停卡片"}
            </button>
            {card.hold && (
              <button
                type="button"
                className="quiet"
                disabled={pending}
                onClick={() => void save(null)}
              >
                解除暂停
              </button>
            )}
          </div>
          {editing && (
            <form
              className="card-hold-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!reason.trim() || !condition.trim()) {
                  setError("请填写暂停原因和恢复条件。");
                  return;
                }
                void save({
                  reason: reason.trim(),
                  resume_condition: condition.trim(),
                });
              }}
            >
              <label>
                暂停原因
                <textarea
                  ref={field}
                  required
                  value={reason}
                  disabled={pending}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <label>
                恢复条件
                <textarea
                  required
                  value={condition}
                  disabled={pending}
                  onChange={(event) => setCondition(event.target.value)}
                />
              </label>
              <p className="hint">
                暂停期间不派发新工作。已有结果保留，正在执行的工作可继续完成。
              </p>
              <div className="card-action-buttons">
                <button type="submit" disabled={pending}>
                  保存暂停信息
                </button>
                <button
                  type="button"
                  className="quiet"
                  disabled={pending}
                  onClick={close}
                >
                  收起
                </button>
              </div>
            </form>
          )}
        </>
      )}
      <RequestFeedback
        pending={pending}
        error={error}
        message={message}
        interactive
      />
    </section>
  );
}
