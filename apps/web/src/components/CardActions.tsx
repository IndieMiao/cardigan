import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  ApiError,
  type CardiganClient,
  type CardUpdateInput,
  type CardView,
  describeWriteError,
} from "../api.js";
import { Menu } from "./Menu.js";
import { PrioritySelect } from "./Priority.js";
import { RequestFeedback } from "./RequestFeedback.js";

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

/**
 * C-69: unmarking restarts the auto-merge timeout; mention it only when the
 * project has it on. The flag is already saved, so a failed read stays silent.
 */
/** C-72: a no-op unmark restarts nothing; show the time that still applies. */
function alreadyUnmarkedNote(due_at: string | null) {
  const due =
    due_at === null
      ? ""
      : `当前合并确认将于 ${new Date(due_at).toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })} 按项目设置自动合并。`;
  return `该卡本来就没有敏感标记，这次没有改动，合并确认的超时计时也没有重新开始。${due}`;
}

async function unmarkNote(client: CardiganClient, projectId: string) {
  try {
    const minutes = (await client.preferences(projectId))
      .auto_merge_after_minutes;
    return minutes === null
      ? ""
      : `如有等你处理的合并确认，从现在起重新计时，${minutes} 分钟内无人处理将按项目设置自动合并。`;
  } catch {
    return "";
  }
}

export function CardActions({
  card,
  client,
  projectId,
  onSaved,
  primaryActions,
  navigation,
}: {
  card: CardView;
  client: CardiganClient;
  projectId: string;
  onSaved: () => void;
  primaryActions?: ReactNode;
  navigation?: ReactNode;
}) {
  const [mode, setMode] = useState<Mode>();
  const [message, setMessage] = useState("");
  const editButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const menuOpensForm = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const previousMode = useRef<Mode | undefined>(undefined);
  useEffect(() => {
    if (!mode && previousMode.current)
      (previousMode.current === "edit"
        ? editButton
        : moreButton
      ).current?.focus();
    previousMode.current = mode;
  }, [mode]);
  // Retain uncertain requests even if the user closes and reopens the form.
  const keys = useRef(new Map<string, string>());
  const closed = card.status === "done" || card.status === "cancelled";
  const [flagging, setFlagging] = useState(false);
  const [flagError, setFlagError] = useState("");
  // C-65: human-only; the Workbench is the human's surface.
  const toggleSensitive = async () => {
    if (flagging) return;
    const next = !card.sensitive;
    const request = JSON.stringify({ mode: "sensitive", next });
    const key = keys.current.get(request) ?? crypto.randomUUID();
    keys.current.set(request, key);
    setFlagging(true);
    setFlagError("");
    setMessage("");
    try {
      const result = await client.setCardSensitive(
        projectId,
        card.id,
        next,
        key,
      );
      keys.current.delete(request);
      setMessage(
        next
          ? "已标为敏感：合并确认将由你亲自处理。"
          : result.changed
            ? `已取消敏感标记。${await unmarkNote(client, projectId)}`
            : alreadyUnmarkedNote(result.auto_merge_due_at),
      );
      onSaved();
    } catch (cause) {
      setFlagError(describeWriteError(cause));
    } finally {
      setFlagging(false);
    }
  };
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
    <div ref={root} className="card-actions">
      <div className="card-action-buttons">
        <button
          type="button"
          className="quiet"
          ref={editButton}
          disabled={!!mode}
          onClick={() => {
            setMessage("");
            setMode("edit");
          }}
        >
          编辑
        </button>
        {primaryActions}
        <Menu
          label="更多卡片操作"
          className="card-action-menu"
          onCloseAutoFocus={(event) => {
            if (menuOpensForm.current) {
              event.preventDefault();
              menuOpensForm.current = false;
              queueMicrotask(() =>
                root.current
                  ?.querySelector<HTMLElement>("form input, form textarea")
                  ?.focus(),
              );
            }
          }}
          trigger={
            <button
              ref={moreButton}
              disabled={!!mode}
              type="button"
              className="quiet"
            >
              更多{" "}
              <svg
                aria-hidden="true"
                className="card-menu-chevron"
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
              >
                <path
                  d="m4 6 4 4 4-4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
            </button>
          }
          items={[
            {
              id: "copy",
              label: "复制链接",
              onSelect: async () => {
                try {
                  await navigator.clipboard.writeText(window.location.href);
                  setMessage("已复制");
                } catch {
                  setMessage("复制失败，请手动复制地址");
                }
              },
            },
            {
              id: "sensitive",
              label: card.sensitive ? "取消敏感标记" : "标为敏感",
              disabled: flagging,
              onSelect: () => void toggleSensitive(),
            },
            {
              id: closed ? "supersede" : "cancel",
              label: (
                <span className={closed ? undefined : "danger"}>
                  {closed ? "标记被取代" : "取消卡片"}
                </span>
              ),
              onSelect: () => {
                setMessage("");
                menuOpensForm.current = true;
                setMode(closed ? "supersede" : "cancel");
              },
            },
          ]}
        />
        {navigation}
      </div>
      {card.sensitive && (
        <p className="hint">敏感卡片：合并确认由你亲自处理。</p>
      )}
      <RequestFeedback
        message={message}
        pending={flagging}
        interactive
        pendingMessage="正在提交…"
        error={flagError}
      />
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
  const [priority, setPriority] = useState(card.priority);
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
        criteria.every((row) => row.value.trim())
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
                    priority,
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
              : describeWriteError(failure),
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
            <div className="priority-field">
              <span>优先级</span>
              <PrioritySelect value={priority} onChange={setPriority} />
            </div>
          </>
        )}
        {mode === "cancel" && (
          <>
            <p>
              确认取消 {card.id}
              ？取消后将同步取消尚未通过的工作项，已通过的验证项保留。未完成的人工待办也会随卡取消（不记为完成）。
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
            {mode === "edit" ? "保存修改" : labels[mode]}
          </button>
          <button type="button" className="quiet" onClick={dismiss}>
            {mode === "cancel" ? "暂不取消" : "放弃修改"}
          </button>
        </div>
      </fieldset>
      <RequestFeedback
        interactive
        pending={pending}
        pendingMessage="正在提交…"
        error={error}
      />
    </form>
  );
}
