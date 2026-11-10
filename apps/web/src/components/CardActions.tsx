import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  type CardiganClient,
  type CardUpdateInput,
  type CardView,
  describeError,
} from "../api.js";

type Mode = "edit" | "cancel" | "supersede";
type Operation =
  | { mode: "edit"; input: CardUpdateInput }
  | { mode: "cancel"; reason: string }
  | { mode: "supersede"; target: string };
const labels = {
  edit: "编辑卡片",
  cancel: "确认取消卡片",
  supersede: "标记被取代",
};

export function CardActions({
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
  const [mode, setMode] = useState<Mode>();
  const [message, setMessage] = useState("");
  // Retain uncertain requests even if the user closes and reopens the form.
  const keys = useRef(new Map<string, string>());
  const closed = card.status === "done" || card.status === "cancelled";
  const perform = async (operation: Operation) => {
    const request = JSON.stringify(operation);
    const key = keys.current.get(request) ?? crypto.randomUUID();
    keys.current.set(request, key);
    if (operation.mode === "edit")
      await client.updateCard(projectId, card.id, operation.input, key);
    else if (operation.mode === "cancel")
      await client.cancelCard(projectId, card.id, operation.reason, key);
    else await client.supersedeCard(projectId, card.id, operation.target, key);
    keys.current.delete(request);
    setMode(undefined);
    setMessage(operation.mode === "cancel" ? "卡片已取消。" : "卡片已更新。");
    onSaved();
  };
  return (
    <div className="card-actions">
      {!mode && (
        <div className="card-action-buttons">
          <button
            type="button"
            className="quiet"
            onClick={() => {
              setMessage("");
              setMode("edit");
            }}
          >
            编辑
          </button>
          {closed ? (
            <button
              type="button"
              className="quiet"
              onClick={() => {
                setMessage("");
                setMode("supersede");
              }}
            >
              标记被取代
            </button>
          ) : (
            <button
              type="button"
              className="quiet danger"
              onClick={() => {
                setMessage("");
                setMode("cancel");
              }}
            >
              取消卡片
            </button>
          )}
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {mode && (
        <CardActionForm
          key={mode}
          mode={mode}
          card={card}
          perform={perform}
          dismiss={() => setMode(undefined)}
        />
      )}
    </div>
  );
}

function CardActionForm({
  mode,
  card,
  perform,
  dismiss,
}: {
  mode: Mode;
  card: CardView;
  perform: (operation: Operation) => Promise<void>;
  dismiss: () => void;
}) {
  const [title, setTitle] = useState(card.title);
  const [goal, setGoal] = useState(card.goal);
  const [criteria, setCriteria] = useState(() =>
    card.acceptance_criteria.map((value) => ({
      id: crypto.randomUUID(),
      value,
    })),
  );
  const [priority, setPriority] = useState(String(card.priority));
  const [reason, setReason] = useState("");
  const [target, setTarget] = useState(card.superseded_by ?? "");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const sending = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current
      ?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")
      ?.focus();
  }, []);
  const valid =
    mode === "edit"
      ? title.trim() &&
        goal.trim() &&
        criteria.length > 0 &&
        criteria.every((row) => row.value.trim()) &&
        priority.trim() &&
        Number.isFinite(Number(priority))
      : mode === "supersede"
        ? /^C-[1-9]\d*$/u.test(target.trim()) && target.trim() !== card.id
        : true;
  return (
    <form
      ref={form}
      className="card-action-form"
      aria-label={labels[mode]}
      onSubmit={async (event) => {
        event.preventDefault();
        if (sending.current || !valid) return;
        sending.current = true;
        setPending(true);
        setError("");
        try {
          await perform(
            mode === "edit"
              ? {
                  mode,
                  input: {
                    title,
                    goal,
                    acceptance_criteria: criteria.map((row) => row.value),
                    priority: Number(priority),
                  },
                }
              : mode === "cancel"
                ? { mode, reason }
                : { mode, target: target.trim() },
          );
        } catch (failure) {
          setError(
            mode === "cancel" &&
              failure instanceof ApiError &&
              failure.code === "illegal_transition"
              ? "已完成卡片不能取消；请建新卡，再把旧卡标记为被取代。"
              : describeError(failure),
          );
        } finally {
          sending.current = false;
          setPending(false);
        }
      }}
    >
      <h2>{labels[mode]}</h2>
      <fieldset disabled={pending}>
        {mode === "edit" && (
          <>
            <label>
              标题
              <input
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              目标
              <textarea
                required
                rows={4}
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
              />
            </label>
            <fieldset className="card-criteria-editor">
              <legend>验收标准</legend>
              {criteria.map((row, index) => (
                <div key={row.id} className="card-criterion-row">
                  <label>
                    验收标准 {index + 1}
                    <textarea
                      required
                      rows={2}
                      value={row.value}
                      onChange={(e) =>
                        setCriteria((rows) =>
                          rows.map((item) =>
                            item.id === row.id
                              ? { ...item, value: e.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="quiet"
                    aria-label={`删除验收标准 ${index + 1}`}
                    disabled={criteria.length === 1}
                    onClick={() =>
                      setCriteria((rows) =>
                        rows.filter((item) => item.id !== row.id),
                      )
                    }
                  >
                    删除
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="quiet"
                onClick={() =>
                  setCriteria((rows) => [
                    ...rows,
                    { id: crypto.randomUUID(), value: "" },
                  ])
                }
              >
                添加验收标准
              </button>
            </fieldset>
            <label>
              优先级
              <input
                required
                type="number"
                step="any"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              />
            </label>
          </>
        )}
        {mode === "cancel" && (
          <>
            <p>
              确认取消 {card.id}
              ？取消后将同步取消尚未通过的工作项，已通过的验证项保留。
            </p>
            <label>
              取消原因（可选）
              <textarea
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          </>
        )}
        {mode === "supersede" && (
          <>
            <label>
              被哪张卡取代
              <input
                required
                placeholder="C-123"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              />
            </label>
            <p className="hint">
              只接受同项目的另一张现存卡片编号，原卡片状态保持不变。
            </p>
          </>
        )}
        <div className="card-action-buttons">
          <button
            type="submit"
            disabled={!valid}
            className={mode === "cancel" ? "danger" : undefined}
          >
            {pending
              ? "正在提交…"
              : mode === "edit"
                ? "保存修改"
                : labels[mode]}
          </button>
          <button type="button" className="quiet" onClick={dismiss}>
            {mode === "cancel" ? "暂不取消" : "放弃修改"}
          </button>
        </div>
      </fieldset>
      {error && (
        <div role="alert" className="error-panel">
          {error}
          <p>操作可能已经成功，保留原内容重试不会重复提交。</p>
        </div>
      )}
    </form>
  );
}
