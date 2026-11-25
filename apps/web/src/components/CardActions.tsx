import {
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ApiError,
  type CardiganClient,
  type CardUpdateInput,
  type CardView,
  describeWriteError,
  type StoryChildChoice,
} from "../api.js";
import { routeHash } from "../route.js";
import { CardFormOutlet } from "./CardFormOutlet.js";
import { CreateCardDialog } from "./CreateCardButton.js";
import { IdBadge } from "./IdTag.js";
import { DialogFeedback } from "./layout/DialogFeedbackLayout.js";
import { Menu, type MenuItem } from "./Menu.js";
import { CardLink } from "./Operations.js";
import { PrioritySelect } from "./Priority.js";
import { RequestFeedback } from "./RequestFeedback.js";
import { Button } from "./ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFields,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.js";
import { Input, RadioChoice } from "./ui/input.js";
import { MoreButton } from "./ui/more-button.js";
import { Textarea } from "./ui/textarea.js";

/** C-700: the ⋯ menu's writes each open a dialog; editing stays inline. */
type DialogMode = "pause" | "cancel" | "supersede";
type Hold = { reason: string; resume_condition: string };
type Operation =
  | { mode: "edit"; input: CardUpdateInput }
  | { mode: "pause"; hold: Hold }
  | { mode: "cancel"; reason: string; children?: StoryChildChoice }
  | { mode: "supersede"; target: string };

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
  disabled = false,
  onEditingChange,
  formContainer,
}: {
  card: CardView;
  client: CardiganClient;
  projectId: string;
  onSaved: () => void;
  primaryActions?: ReactNode;
  navigation?: ReactNode;
  disabled?: boolean;
  onEditingChange?: (editing: boolean) => void;
  /** C-695: the buttons sit in the status row; the form and notes go here. */
  formContainer?: HTMLElement | null;
}) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditingState] = useState(false);
  const setEditing = (next: boolean) => {
    setEditingState(next);
    onEditingChange?.(next);
  };
  const [dialog, setDialog] = useState<DialogMode>();
  const [message, setMessage] = useState("");
  const editButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const menuOpensDialog = useRef(false);
  const actionForm = useRef<HTMLFormElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (!editing && wasEditing.current) editButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
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
    else if (operation.mode === "pause")
      await client.updateCard(
        projectId,
        card.id,
        { hold: operation.hold },
        key,
      );
    else if (operation.mode === "cancel")
      await client.cancelCard(
        projectId,
        card.id,
        operation.reason,
        key,
        ...(operation.children ? [operation.children] : []),
      );
    else await client.supersedeCard(projectId, card.id, operation.target, key);
    keys.current.delete(request);
    if (operation.mode === "edit") setEditing(false);
    else setDialog(undefined);
    setMessage(
      operation.mode === "cancel"
        ? "卡片已取消。"
        : operation.mode === "pause"
          ? "卡片已暂停。"
          : "卡片已更新。",
    );
    onSaved();
  };
  const openDialog = (mode: DialogMode) => {
    setMessage("");
    menuOpensDialog.current = true;
    setDialog(mode);
  };
  const items: MenuItem[] = [
    ...(closed
      ? []
      : [
          {
            id: "pause",
            label: card.hold ? "修改暂停信息…" : "暂停卡片…",
            onSelect: () => openDialog("pause"),
          },
        ]),
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
      id: "create",
      label: card.story && !closed ? "新建子卡" : "新建卡片",
      onSelect: () => {
        menuOpensDialog.current = true;
        setCreating(true);
      },
    },
    {
      id: "sensitive",
      label: card.sensitive ? "取消敏感标记" : "标为敏感",
      disabled: flagging,
      onSelect: () => void toggleSensitive(),
    },
    ...(closed
      ? [
          {
            id: "supersede",
            label: "标记被取代…",
            onSelect: () => openDialog("supersede"),
          },
        ]
      : [
          { id: "cancel-separator", kind: "separator" as const },
          {
            id: "cancel",
            label: <span className="danger">取消卡片…</span>,
            onSelect: () => openDialog("cancel"),
          },
        ]),
  ];
  return (
    <div className="card-actions">
      <div className="card-action-buttons">
        <Button
          type="button"
          variant="ghost"
          ref={editButton}
          disabled={disabled || editing}
          onClick={() => {
            setMessage("");
            setEditing(true);
          }}
        >
          编辑
        </Button>
        {primaryActions}
        <Menu
          label="更多卡片操作"
          className="card-action-menu"
          onCloseAutoFocus={(event) => {
            // The dialog being opened takes focus; it returns it to ⋯ on close.
            if (menuOpensDialog.current) {
              event.preventDefault();
              menuOpensDialog.current = false;
            }
          }}
          trigger={
            <MoreButton
              ref={moreButton}
              label="更多卡片操作"
              disabled={disabled || editing}
            />
          }
          items={items}
        />
        {navigation}
      </div>
      <CreateCardDialog
        key={JSON.stringify([projectId, card.id])}
        open={creating}
        setOpen={setCreating}
        parentId={card.story && !closed ? card.id : undefined}
        projectId={projectId}
        client={client}
        restoreFocus={() => moreButton.current?.focus()}
        onCreated={(cardId) => {
          onSaved();
          window.location.hash = routeHash({
            kind: "card",
            projectId,
            cardId,
          });
        }}
      />
      <CardActionDialog
        mode={dialog}
        closed={closed}
        projectId={projectId}
        card={card}
        perform={perform}
        dismiss={() => setDialog(undefined)}
        restoreFocus={() => moreButton.current?.focus()}
      />
      <CardFormOutlet container={formContainer}>
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
        {editing && (
          <CardEditForm
            form={actionForm}
            card={card}
            perform={perform}
            dismiss={() => setEditing(false)}
          />
        )}
      </CardFormOutlet>
    </div>
  );
}

function CardEditForm({
  form,
  card,
  perform,
  dismiss,
}: {
  form: RefObject<HTMLFormElement | null>;
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
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const sending = useRef(false);
  useEffect(() => {
    form.current
      ?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")
      ?.focus();
  }, [form]);
  const valid =
    title.trim() &&
    goal.trim() &&
    criteria.length > 0 &&
    criteria.every((row) => row.value.trim());
  return (
    <form
      ref={form}
      className="card-action-form"
      aria-label="编辑卡片"
      data-escape-handled
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (!pending) dismiss();
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (sending.current || !valid) return;
        sending.current = true;
        setPending(true);
        setError("");
        try {
          await perform({
            mode: "edit",
            input: {
              title,
              goal,
              acceptance_criteria: criteria.map((row) => row.value),
              priority,
            },
          });
        } catch (failure) {
          setError(describeWriteError(failure));
        } finally {
          sending.current = false;
          setPending(false);
        }
      }}
    >
      <h2>编辑卡片</h2>
      <fieldset disabled={pending}>
        <label>
          标题
          <Input
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          目标
          <Textarea
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
                <Textarea
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
              <Button
                type="button"
                variant="ghost"
                aria-label={`删除验收标准 ${index + 1}`}
                disabled={criteria.length === 1}
                onClick={() =>
                  setCriteria((rows) =>
                    rows.filter((item) => item.id !== row.id),
                  )
                }
              >
                删除
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              setCriteria((rows) => [
                ...rows,
                { id: crypto.randomUUID(), value: "" },
              ])
            }
          >
            添加验收标准
          </Button>
        </fieldset>
        <div className="priority-field">
          <span>优先级</span>
          <PrioritySelect value={priority} onChange={setPriority} />
        </div>
        <div className="card-action-buttons">
          <Button type="submit" disabled={!valid}>
            保存修改
          </Button>
          <Button type="button" variant="ghost" onClick={dismiss}>
            放弃修改
          </Button>
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

const dialogTitles: Record<DialogMode, string> = {
  pause: "暂停卡片",
  cancel: "取消卡片",
  supersede: "标记被取代",
};

/**
 * C-700: pausing, cancelling and marking a card superseded each confirm in a
 * dialog. Writing happens only on confirm; dismissing (Esc, the cancel button,
 * a click outside) writes nothing and returns focus to ⋯. A failure stays in
 * the dialog with its reason.
 */
function CardActionDialog({
  mode,
  closed,
  ...props
}: {
  mode: DialogMode | undefined;
  closed: boolean;
  projectId: string;
  card: CardView;
  perform: (operation: Operation) => Promise<void>;
  dismiss: () => void;
  restoreFocus: () => void;
}) {
  const [pending, setPending] = useState(false);
  const { dismiss, restoreFocus } = props;
  // A card that closes meanwhile can no longer be paused or cancelled.
  const stale = mode !== undefined && (mode === "supersede") !== closed;
  useEffect(() => {
    if (stale && !pending) dismiss();
  }, [stale, pending, dismiss]);
  return (
    <Dialog
      open={mode !== undefined}
      onOpenChange={(next) => {
        if (!next && !pending) dismiss();
      }}
    >
      {mode && (
        <DialogContent
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (pending) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus();
          }}
        >
          <CardActionDialogForm
            key={mode}
            mode={mode}
            pending={pending}
            setPending={setPending}
            {...props}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}

function CardActionDialogForm({
  mode,
  projectId,
  card,
  perform,
  pending,
  setPending,
}: {
  mode: DialogMode;
  projectId: string;
  card: CardView;
  perform: (operation: Operation) => Promise<void>;
  pending: boolean;
  setPending: (pending: boolean) => void;
}) {
  const activeChildren =
    card.story_progress?.children.filter(
      (c) => c.status !== "done" && c.status !== "cancelled",
    ) ?? [];
  const childIds = activeChildren.map((c) => c.id).sort();
  const [choice, setChoice] = useState<StoryChildChoice>();
  const confirmed =
    choice && JSON.stringify(choice.ids) === JSON.stringify(childIds)
      ? choice
      : undefined;
  const [reason, setReason] = useState("");
  const [holdReason, setHoldReason] = useState(card.hold?.reason ?? "");
  const [condition, setCondition] = useState(card.hold?.resume_condition ?? "");
  const [target, setTarget] = useState(card.superseded_by ?? "");
  const [error, setError] = useState("");
  const sending = useRef(false);
  const editingHold = mode === "pause" && !!card.hold;
  const valid =
    mode === "pause"
      ? !!holdReason.trim() && !!condition.trim()
      : mode === "supersede"
        ? /^C-[1-9]\d*$/u.test(target.trim()) && target.trim() !== card.id
        : !activeChildren.length || !!confirmed;
  const title = editingHold ? "修改暂停信息" : dialogTitles[mode];
  const confirmLabel =
    mode === "cancel"
      ? `取消卡片 ${card.id}`
      : editingHold
        ? "保存暂停信息"
        : dialogTitles[mode];
  return (
    <form
      aria-label={title}
      onSubmit={async (event) => {
        event.preventDefault();
        if (sending.current || !valid) return;
        sending.current = true;
        setPending(true);
        setError("");
        try {
          await perform(
            mode === "pause"
              ? {
                  mode,
                  hold: {
                    reason: holdReason.trim(),
                    resume_condition: condition.trim(),
                  },
                }
              : mode === "cancel"
                ? {
                    mode,
                    reason,
                    ...(confirmed ? { children: confirmed } : {}),
                  }
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
      <DialogHeader>
        <DialogTitle>
          {title} <IdBadge id={card.id} />
        </DialogTitle>
      </DialogHeader>
      <DialogBody>
        <DialogFields>
          {mode === "pause" && (
            <>
              <label>
                暂停原因
                <Textarea
                  required
                  rows={3}
                  value={holdReason}
                  disabled={pending}
                  onChange={(e) => setHoldReason(e.target.value)}
                />
              </label>
              <label>
                恢复条件
                <Textarea
                  required
                  rows={3}
                  value={condition}
                  disabled={pending}
                  onChange={(e) => setCondition(e.target.value)}
                />
              </label>
            </>
          )}
          {mode === "cancel" && (
            <>
              {activeChildren.length > 0 && (
                <fieldset disabled={pending}>
                  <legend>未结束的子卡</legend>
                  <ul>
                    {activeChildren.map((c) => (
                      <li key={c.id}>
                        <CardLink
                          projectId={projectId}
                          id={c.id}
                          label={c.title}
                        />
                      </li>
                    ))}
                  </ul>
                  {(["detach", "cancel"] as const).map((action) => (
                    <RadioChoice
                      key={action}
                      name="story-children"
                      checked={confirmed?.action === action}
                      onChange={() => setChoice({ action, ids: childIds })}
                    >
                      {action === "detach" ? "保留并脱离需求卡" : "一并取消"}
                    </RadioChoice>
                  ))}
                </fieldset>
              )}
              <label>
                取消原因（可选）
                <Textarea
                  rows={3}
                  value={reason}
                  disabled={pending}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
            </>
          )}
          {mode === "supersede" && (
            <label>
              被哪张卡取代
              <Input
                required
                placeholder="C-123"
                value={target}
                disabled={pending}
                onChange={(e) => setTarget(e.target.value)}
              />
            </label>
          )}
        </DialogFields>
        <DialogFeedback>
          <RequestFeedback
            interactive
            pending={pending}
            pendingMessage="正在提交…"
            error={error}
          />
        </DialogFeedback>
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button size="regular" disabled={pending}>
            {mode === "cancel" ? "返回" : "取消"}
          </Button>
        </DialogClose>
        <Button
          type="submit"
          size="regular"
          disabled={!valid || pending}
          variant={mode === "cancel" ? "destructive" : "emphasis"}
        >
          {confirmLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
