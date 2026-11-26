import { DECISION_OTHER_OPTION, decisionOtherOption } from "@cardigan/domain";
import { mergeOverrideReasonError } from "@cardigan/domain/merge-override";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  CardiganClient,
  DecisionSuggestionView,
  NeedsDecision,
} from "../api.js";
import { SuggestionProgressEntries } from "../components/DecisionSuggestion.js";
import { IdBadge } from "../components/IdTag.js";
import { DialogFeedback } from "../components/layout/DialogFeedbackLayout.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { Button } from "../components/ui/button.js";
import { Checkbox } from "../components/ui/checkbox.js";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFields,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { Textarea } from "../components/ui/textarea.js";
import { SUGGESTION_COPY } from "../suggestion-copy.js";
import { useAction } from "./useAction.js";

/**
 * C-697: the merge confirmation's writes that need words each confirm in a
 * dialog with a fixed footer instead of a form pushed into the page:
 * 暂不合并, 退回修改 (also when following a suggested return), 其他（自己填写）,
 * 仍要合并 past unmet prerequisites, and following a suggestion that has
 * news since it was written. Closing without submitting writes nothing.
 */
export type MergeDialogMode =
  | "hold"
  | "return"
  | "suggested-return"
  | "suggested-merge"
  | "other"
  | "override";

export function MergeDialogs({
  mode,
  q,
  client,
  projectId,
  quote,
  reason,
  onReason,
  suggestion,
  blockers,
  done,
  close,
  restoreFocus,
}: {
  /** The open dialog; undefined when none is. */
  readonly mode: MergeDialogMode | undefined;
  readonly q: NeedsDecision;
  readonly client: CardiganClient;
  readonly projectId: string;
  /** The optional words recorded with a merge. */
  readonly quote: string;
  /** The return reason, prefilled from a suggested return. */
  readonly reason: string;
  readonly onReason: (value: string) => void;
  readonly suggestion: DecisionSuggestionView | undefined;
  readonly blockers: readonly string[];
  readonly done: () => void;
  readonly close: () => void;
  /** Focus the control that opened the dialog (or its ⋯ menu). */
  readonly restoreFocus: () => void;
}) {
  const action = useAction(done);
  const { clearFeedback } = action;
  const cancel = useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new dialog starts without the previous one's feedback.
  useEffect(() => {
    if (mode) clearFeedback();
  }, [mode]);
  const run = (
    input: readonly unknown[],
    write: (key: string) => Promise<void>,
  ) =>
    void action.run(input, async (key) => {
      await write(key);
      close();
    });
  const applySuggestion = (option: string, said: string) =>
    run(
      [
        projectId,
        q.id,
        "suggestion",
        option,
        said,
        suggestion?.progress?.token,
        suggestion?.version,
      ],
      (key) =>
        client.applySuggestion(
          projectId,
          q.id,
          option,
          said,
          key,
          suggestion?.progress?.token,
          suggestion?.version,
        ),
    );
  return (
    <Dialog
      open={!!mode}
      onOpenChange={(next) => {
        if (!next && !action.busy) close();
      }}
    >
      {mode && (
        <DialogContent
          role={mode === "override" ? "alertdialog" : "dialog"}
          aria-modal={mode === "override" || undefined}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            if (mode !== "override" && mode !== "suggested-merge") return;
            event.preventDefault();
            cancel.current?.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (action.busy) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (action.busy) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus();
          }}
        >
          <MergeDialogForm
            key={mode}
            mode={mode}
            q={q}
            busy={action.busy}
            cancel={cancel}
            reason={reason}
            onReason={onReason}
            suggestion={suggestion}
            blockers={blockers}
            feedback={
              <DialogFeedback>
                <RequestFeedback
                  interactive
                  pending={action.busy}
                  pendingMessage="正在提交…"
                  error={action.error}
                />
              </DialogFeedback>
            }
            submit={(values) => {
              switch (mode) {
                case "hold":
                  return run(
                    [projectId, q.id, "hold", values.text, values.until],
                    (key) =>
                      client.recordDecision(
                        projectId,
                        q.id,
                        "hold",
                        values.text,
                        key,
                        false,
                        values.until,
                      ),
                  );
                case "return":
                  return run(
                    [projectId, q.id, "resolve", "request_changes", reason],
                    (key) =>
                      client.recordDecision(
                        projectId,
                        q.id,
                        "request_changes",
                        reason,
                        key,
                      ),
                  );
                case "suggested-return":
                  return applySuggestion("request_changes", reason);
                case "suggested-merge":
                  return applySuggestion("merge", quote);
                case "other":
                  return run(
                    [
                      projectId,
                      q.id,
                      "resolve",
                      DECISION_OTHER_OPTION,
                      values.text,
                    ],
                    (key) =>
                      client.recordDecision(
                        projectId,
                        q.id,
                        DECISION_OTHER_OPTION,
                        values.text,
                        key,
                      ),
                  );
                case "override":
                  return run(
                    [
                      projectId,
                      q.id,
                      "merge-override",
                      quote,
                      values.text,
                      !!values.followUp,
                    ],
                    (key) =>
                      values.followUp
                        ? client.recordDecision(
                            projectId,
                            q.id,
                            "merge",
                            quote,
                            key,
                            false,
                            undefined,
                            values.text,
                            true,
                          )
                        : client.recordDecision(
                            projectId,
                            q.id,
                            "merge",
                            quote,
                            key,
                            false,
                            undefined,
                            values.text,
                          ),
                  );
              }
            }}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}

const titles: Record<MergeDialogMode, string> = {
  hold: "暂不合并",
  return: "退回修改",
  "suggested-return": "退回修改",
  "suggested-merge": SUGGESTION_COPY.apply,
  other: decisionOtherOption.description,
  override: "仍要确认合并？",
};

function MergeDialogForm({
  mode,
  q,
  busy,
  cancel,
  reason,
  onReason,
  suggestion,
  blockers,
  feedback,
  submit,
}: {
  readonly mode: MergeDialogMode;
  readonly q: NeedsDecision;
  readonly busy: boolean;
  readonly cancel: RefObject<HTMLButtonElement | null>;
  readonly reason: string;
  readonly onReason: (value: string) => void;
  readonly suggestion: DecisionSuggestionView | undefined;
  readonly blockers: readonly string[];
  readonly feedback: ReactNode;
  readonly submit: (values: {
    text: string;
    until?: string;
    /** C-760: the open merge holds become follow-ups with the override. */
    followUp?: boolean;
  }) => void;
}) {
  const [text, setText] = useState("");
  const [until, setUntil] = useState("");
  const [followUp, setFollowUp] = useState(false);
  const holds =
    mode === "override"
      ? (q.merge_confirmation?.blocking_human_actions ?? [])
      : [];
  const overrideError =
    mode === "override" ? mergeOverrideReasonError(text) : undefined;
  const returning = mode === "return" || mode === "suggested-return";
  const progress = mode.startsWith("suggested-")
    ? suggestion?.progress
    : undefined;
  const valid = returning
    ? !!reason.trim()
    : mode === "hold"
      ? !!text.trim() && (!until || Number.isFinite(Date.parse(until)))
      : mode === "other"
        ? !!text.trim()
        : mode === "override"
          ? !overrideError && (holds.length === 0 || followUp)
          : true;
  const confirmLabel = {
    hold: "登记暂缓",
    return: "确认退回修改",
    "suggested-return": progress
      ? SUGGESTION_COPY.confirm
      : `按建议：${SUGGESTION_COPY.mergeOptions.request_changes}`,
    "suggested-merge": SUGGESTION_COPY.confirm,
    other: "提交",
    override: "确认仍要合并",
  }[mode];
  return (
    <form
      aria-label={`${q.id} ${titles[mode]}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || !valid) return;
        submit({
          text,
          ...(mode === "hold" && until
            ? { until: new Date(until).toISOString() }
            : {}),
          ...(holds.length > 0 ? { followUp } : {}),
        });
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {titles[mode]} <IdBadge id={q.id} />
        </DialogTitle>
      </DialogHeader>
      <DialogBody>
        {mode === "override" && (
          <>
            <p>
              以下条件尚未满足。请写明仍要确认的理由，系统会记录理由和当前缺项。
            </p>
            <ul>
              {blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          </>
        )}
        {progress && (
          <>
            <p>{SUGGESTION_COPY.confirmHint}</p>
            <SuggestionProgressEntries progress={progress} />
          </>
        )}
        <DialogFields>
          {returning && (
            <label>
              {mode === "suggested-return"
                ? SUGGESTION_COPY.returnReason
                : "退回原因（必填）"}
              <Textarea
                aria-label={
                  mode === "suggested-return"
                    ? `${q.id} 建议的退回原因`
                    : `${q.id} 退回原因`
                }
                required
                rows={4}
                value={reason}
                readOnly={busy}
                onChange={(e) => onReason(e.target.value)}
              />
            </label>
          )}
          {mode === "hold" && (
            <>
              <label>
                暂缓原因（必填）
                <Textarea
                  required
                  rows={3}
                  value={text}
                  readOnly={busy}
                  onChange={(e) => setText(e.target.value)}
                />
              </label>
              <label>
                暂缓到期时间（可选，不填按项目默认时长）
                <Input
                  type="datetime-local"
                  value={until}
                  readOnly={busy}
                  onChange={(e) => setUntil(e.target.value)}
                />
              </label>
            </>
          )}
          {mode === "other" && (
            <label>
              你的决定（必填，会作为你的原话记录）
              <Textarea
                aria-label={`${q.id} 其他决定`}
                required
                rows={4}
                value={text}
                readOnly={busy}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
          )}
          {mode === "override" && (
            <label>
              强行合并理由（必填）
              <Textarea
                rows={3}
                value={text}
                readOnly={busy}
                aria-invalid={!!text.trim() && !!overrideError}
                aria-describedby={
                  text.trim() && overrideError
                    ? `override-error-${q.id}`
                    : undefined
                }
                onChange={(e) => setText(e.target.value)}
              />
            </label>
          )}
          {holds.length > 0 && (
            <fieldset aria-label="挡合并的人工事项">
              <p>
                {`人工事项 ${holds.map((h) => h.id).join("、")} 未完成，会继续挡住合并。`}
              </p>
              <label>
                <Checkbox
                  checked={followUp}
                  disabled={busy}
                  onCheckedChange={(v) => setFollowUp(v === true)}
                />
                一并改为合并后跟进
              </label>
            </fieldset>
          )}
        </DialogFields>
        {mode === "override" && text.trim() && overrideError && (
          <p id={`override-error-${q.id}`} className="error" role="alert">
            {overrideError}
          </p>
        )}
        {feedback}
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button ref={cancel} size="regular" disabled={busy}>
            {mode === "override" ? "先不确认" : "取消"}
          </Button>
        </DialogClose>
        <Button
          type="submit"
          size="regular"
          variant={mode === "override" ? "destructive" : "emphasis"}
          disabled={busy || !valid}
        >
          {confirmLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
