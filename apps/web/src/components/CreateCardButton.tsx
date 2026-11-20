import { useCallback, useRef, useState } from "react";
import {
  type CardiganClient,
  type CreateCardInput,
  describeWriteError,
} from "../api.js";
import { useResource } from "../useResource.js";
import { RequestFeedback } from "./RequestFeedback.js";
import { Button } from "./ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog.js";
import { Input } from "./ui/input.js";
import { SelectControl } from "./ui/select-control.js";
import { Textarea } from "./ui/textarea.js";

interface CreateCardProps {
  client: CardiganClient;
  projectId: string;
  onCreated: (id: string) => void;
}

export function CreateCardButton(props: CreateCardProps) {
  const [open, setOpen] = useState(false);
  return (
    <CreateCardDialog {...props} open={open} setOpen={setOpen} showTrigger />
  );
}

export function CreateCardDialog({
  client,
  projectId,
  onCreated,
  open,
  setOpen,
  showTrigger = false,
  parentId,
  restoreFocus,
}: CreateCardProps & {
  open: boolean;
  setOpen: (open: boolean) => void;
  showTrigger?: boolean;
  parentId?: string | undefined;
  restoreFocus?: () => void;
}) {
  const [template, setTemplate] = useState(parentId ? "dev" : "story"),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const {
    data,
    error: catalogError,
    pending: loading,
    reload,
  } = useResource(
    useCallback(() => client.templates(projectId), [client, projectId]),
    0,
    open,
  );
  const templates =
    data?.templates.filter(
      (t) =>
        t.status === "active" && !(parentId && t.builtin && t.id === "story"),
    ) ?? [];
  const selected = templates.find((t) => t.id === template);
  const [readOnly, setReadOnly] = useState(false);
  const keys = useRef(new Map<string, string>());
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) {
          setOpen(next);
          setError("");
        }
      }}
    >
      {showTrigger && (
        <DialogTrigger asChild>
          <Button variant="outline">新建卡片</Button>
        </DialogTrigger>
      )}
      <DialogContent
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          if (restoreFocus) {
            event.preventDefault();
            restoreFocus();
          }
        }}
      >
        <DialogTitle>{parentId ? "新建子卡" : "新建卡片"}</DialogTitle>
        <form
          className="card-action-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (pending) return;
            const fields = new FormData(e.currentTarget);
            const field = (key: string) => String(fields.get(key) ?? "").trim();
            const parent = field("parent");
            const input: CreateCardInput = {
              ...(selected?.requires_state_and_save
                ? {
                    state_and_save: readOnly
                      ? "无写入"
                      : {
                          save_timing: field("save_timing"),
                          leave_behavior: field("leave_behavior"),
                          failure_feedback: field("failure_feedback"),
                          consistency: field("consistency"),
                        },
                  }
                : {}),
              title: field("title"),
              goal: field("goal"),
              template_id: template,
              ...(parent ? { parent_card_id: parent } : {}),
              acceptance_criteria: field("criteria")
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
            };
            const fingerprint = JSON.stringify(input);
            const key = keys.current.get(fingerprint) ?? crypto.randomUUID();
            keys.current.set(fingerprint, key);
            setPending(true);
            setError("");
            try {
              const card = await client.createCard(projectId, input, key);
              keys.current.delete(fingerprint);
              setOpen(false);
              onCreated(card.id);
            } catch (cause) {
              setError(describeWriteError(cause));
            } finally {
              setPending(false);
            }
          }}
        >
          {catalogError && (
            <Button type="button" onClick={reload}>
              重试
            </Button>
          )}
          <fieldset disabled={pending || loading}>
            <label>
              模板
              <SelectControl value={template} onValueChange={setTemplate}>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </SelectControl>
            </label>
            <label>
              标题
              <Input name="title" required />
            </label>
            <label>
              目标
              <Textarea name="goal" required />
            </label>
            {!(selected?.builtin && template === "story") && (
              <label>
                父需求卡（可选）
                <Input
                  name="parent"
                  defaultValue={parentId}
                  placeholder="C-123"
                  pattern="C-[1-9][0-9]*"
                />
              </label>
            )}
            {selected?.requires_state_and_save && (
              <fieldset>
                <legend>状态与保存</legend>
                <label>
                  写入行为
                  <SelectControl
                    value={readOnly ? "none" : "write"}
                    onValueChange={(v) => setReadOnly(v === "none")}
                  >
                    <option value="write">有写入</option>
                    <option value="none">无写入</option>
                  </SelectControl>
                </label>
                {!readOnly &&
                  Object.entries({
                    save_timing: "保存时机",
                    leave_behavior: "离页行为",
                    failure_feedback: "失败提示",
                    consistency: "读写一致性",
                  }).map(([key, label]) => (
                    <label key={key}>
                      {label}
                      <Input name={key} required />
                    </label>
                  ))}
              </fieldset>
            )}
            <label>
              验收标准
              <Textarea
                name="criteria"
                required={selected?.require_acceptance_criteria}
              />
            </label>
            <Button type="submit" disabled={!selected}>
              创建
            </Button>
          </fieldset>
          <RequestFeedback
            interactive
            pending={pending}
            error={error || catalogError || ""}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}
