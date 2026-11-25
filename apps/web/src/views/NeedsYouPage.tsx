import {
  DECISION_OTHER_OPTION,
  decisionOptionOf,
  decisionOtherOption,
  humanDecisionOptions,
  reviewImpactLabel,
} from "@cardigan/domain";
import { mergeOverrideReasonError } from "@cardigan/domain/merge-override";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CardiganClient,
  type DecisionView,
  describeError,
  describeWriteError,
  type IncidentHandling,
  type MergeConfirmationReview,
  type NeedsAction,
  type NeedsDecision,
  type NeedsPage,
  type NeedsStoryProposal,
  type NoticeView,
  type PreMergeCheckView,
} from "../api.js";
import { DecisionAffectedCards } from "../components/DecisionAffectedCards.js";
import { DecisionAttachments } from "../components/DecisionAttachments.js";
import { DecisionRouting } from "../components/DecisionRouting.js";
import {
  DecisionSuggestion,
  usePrefilledReason,
} from "../components/DecisionSuggestion.js";
import { EmployeeIdentity } from "../components/EmployeeIdentity.js";
import {
  EmptyState,
  IdTag,
  PageTitle,
  StatusTag,
  Time,
} from "../components/Foundation.js";
import { IdentityRow } from "../components/IdentityRow.js";
import {
  NeedsList,
  NeedsListFooter,
  NeedsNotice,
  NeedsOpenAction,
  NeedsRow,
} from "../components/layout/NeedsRowLayout.js";
import { MergeCheck } from "../components/MergeCheck.js";
import { MergeStatusLine } from "../components/MergeStatusLine.js";
import {
  type NeedsCountsResource,
  NeedsYouTabs,
} from "../components/NeedsYouTabs.js";
import {
  CardLink,
  CopyCommand,
  cliCommand,
  Feedback,
  Markdown,
  quote,
  TakeoverWarning,
} from "../components/Operations.js";
import { DecisionContext, PlainSummary } from "../components/PlainSummary.js";
import { PmMergeTakeover } from "../components/PmMergeTakeover.js";
import { PriorityBadge } from "../components/Priority.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { SourceMergeSuggestion } from "../components/SourceMergeSuggestion.js";
import {
  type StoryRefusal,
  storyRefusal,
} from "../components/StoryProposal.js";
import { Button } from "../components/ui/button.js";
import * as Dialog from "../components/ui/dialog.js";
import { SelectControl } from "../components/ui/select-control.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Textarea } from "../components/ui/textarea.js";
import { decisionTitle, delegableCategories } from "../decision-labels.js";
import { PRE_MERGE_COPY } from "../pre-merge-copy.js";
import { routeHash } from "../route.js";
import { statusLabel } from "../status.js";
import { SUGGESTION_COPY } from "../suggestion-copy.js";
import { useResource } from "../useResource.js";

const waitLabel = (ms: number | null, elapsed = 0) => {
  const age = (ms ?? 0) + elapsed;
  return ms === null
    ? "等待时长未知"
    : age < 60000
      ? "刚刚发起"
      : age < 3600000
        ? `已等待 ${Math.floor(age / 60000)} 分钟`
        : `已等待 ${Math.floor(age / 3600000)} 小时`;
};
const isMergeConfirmation = (q: NeedsDecision) =>
  q.trigger === "merge_confirmation";
const isPausedReview = (q: NeedsDecision) =>
  q.trigger === "review_limit" && q.status === "provisional";
const reworkOptionLabels: Record<string, string> = {
  return_for_rework: "退回作者修改",
  keep: "保留当前产出",
};
const reviewOptionLabels: Record<string, string> = {
  pause: "暂停",
  raise_limit: "增加轮数",
  change_approach: "换做法",
  narrow_scope: "收窄范围",
  split_card: "拆卡",
};
type Props = { client: CardiganClient; projectId: string; revision?: number };
function useAction(done: () => void) {
  const keys = useRef(new Map<string, string>());
  const sending = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>(),
    [message, setMessage] = useState("");
  return {
    busy,
    error,
    message,
    clearFeedback: () => {
      if (sending.current) return;
      setError(undefined);
      setMessage("");
    },
    run: async (
      input: readonly unknown[],
      action: (key: string) => Promise<void>,
    ) => {
      if (sending.current) return;
      sending.current = true;
      const request = JSON.stringify(input);
      const key = keys.current.get(request) ?? crypto.randomUUID();
      keys.current.set(request, key);
      setBusy(true);
      setError(undefined);
      setMessage("");
      try {
        await action(key);
        keys.current.delete(request);
        setMessage("已提交");
        done();
      } catch (e) {
        setError(describeWriteError(e));
      } finally {
        sending.current = false;
        setBusy(false);
      }
    },
  };
}
function DecisionMeta({
  q,
  projectId,
  elapsed,
  hideCard = false,
}: {
  readonly q: NeedsDecision;
  readonly projectId: string;
  readonly elapsed: number;
  readonly hideCard?: boolean;
}) {
  return (
    <>
      <IdentityRow as="header" className="needs-meta">
        <EmployeeIdentity {...q} showTitle={false} />
        <IdTag id={q.id} label={isMergeConfirmation(q) ? "合并确认" : "拍板"} />
        {q.blocking && !q.followup_notice && !isMergeConfirmation(q) && (
          <StatusTag status="blocked" />
        )}
        {isPausedReview(q) && (
          <StatusTag status="suspended" label="已暂停（临时决定）" />
        )}
        {q.handed_over_from_pm && (
          <span className="hint" title={q.handed_over_from_pm.reason}>
            由 PM 转交
          </span>
        )}
        <span className="hint">{waitLabel(q.waited_ms, elapsed)}</span>
        {q.auto_merge && !isMergeConfirmation(q) && (
          <span className="hint">
            将于{" "}
            {new Date(q.auto_merge.due_at).toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}{" "}
            自动合并（偏好设置：{q.auto_merge.minutes} 分钟）
            {q.auto_merge.remaining_ms !== undefined
              ? ` · 剩余 ${Math.max(0, Math.ceil((q.auto_merge.remaining_ms - elapsed) / 60_000))} 分钟`
              : q.waited_ms !== null &&
                ` · 剩余 ${Math.max(0, Math.ceil((q.auto_merge.minutes * 60_000 - q.waited_ms - elapsed) / 60_000))} 分钟`}
          </span>
        )}
        {!hideCard && (
          <span className="needs-cards">
            {!q.card_id ? (
              <span>项目级事项</span>
            ) : (
              <CardLink
                projectId={projectId}
                id={q.card_id}
                label={
                  q.related_cards.find((card) => card.id === q.card_id)
                    ?.title ?? "卡片"
                }
              />
            )}
          </span>
        )}
      </IdentityRow>
      <DecisionAffectedCards decision={q} projectId={projectId} />
    </>
  );
}
function cardTitle(q: NeedsDecision, id = q.card_id) {
  return q.related_cards.find((card) => card.id === id)?.title;
}
/** C-459: the card reference that leads every Needs You row. */
function RowCard({
  projectId,
  id,
  label,
}: {
  readonly projectId: string;
  readonly id: string | null;
  readonly label?: string | undefined;
}) {
  return <CardLink projectId={projectId} id={id} label={label ?? ""} />;
}
function autoMergeHint(q: NeedsDecision, elapsed: number) {
  if (!q.auto_merge || isMergeConfirmation(q)) return null;
  return (
    <span className="hint">
      将于{" "}
      {new Date(q.auto_merge.due_at).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })}{" "}
      自动合并（偏好设置：{q.auto_merge.minutes} 分钟）
      {q.auto_merge.remaining_ms !== undefined
        ? ` · 剩余 ${Math.max(0, Math.ceil((q.auto_merge.remaining_ms - elapsed) / 60_000))} 分钟`
        : q.waited_ms !== null &&
          ` · 剩余 ${Math.max(0, Math.ceil((q.auto_merge.minutes * 60_000 - q.waited_ms - elapsed) / 60_000))} 分钟`}
    </span>
  );
}
function DecisionStatus({ q }: { readonly q: NeedsDecision }) {
  return (
    <>
      {q.blocking && !q.followup_notice && !isMergeConfirmation(q) && (
        <StatusTag status="blocked" />
      )}
      {isPausedReview(q) && (
        <StatusTag status="suspended" label="已暂停（临时决定）" />
      )}
    </>
  );
}
/** Secondary facts of a decision row, first inside its folded details. */
function DecisionDetailsMeta({
  q,
  projectId,
  elapsed,
}: {
  readonly q: NeedsDecision;
  readonly projectId: string;
  readonly elapsed: number;
}) {
  return (
    <>
      <IdentityRow className="needs-meta">
        <EmployeeIdentity {...q} showTitle={false} />
        {q.handed_over_from_pm && (
          <span className="hint" title={q.handed_over_from_pm.reason}>
            由 PM 转交
          </span>
        )}
        {autoMergeHint(q, elapsed)}
      </IdentityRow>
      <DecisionAffectedCards decision={q} projectId={projectId} />
    </>
  );
}
function Decision({
  q,
  client,
  projectId,
  done,
  elapsed,
}: Props & { q: NeedsDecision; done: () => void; elapsed: number }) {
  const [option, setOption] = useState(""),
    [quote, setQuote] = useState("");
  const action = useAction(done);
  const [delegateFuture, setDelegateFuture] = useState(false);
  const independentLimit =
    q.trigger === "review_limit" ? q.independent_review_limit : undefined;
  const canDelegate =
    q.trigger !== "merge_confirmation" &&
    q.trigger !== "accepted_delivery_rework" &&
    !q.human_required_reason &&
    !independentLimit &&
    delegableCategories.includes(q.category);
  const paused = isPausedReview(q);
  const raised = paused
    ? q.options.filter((o) => o.key !== "pause")
    : q.options;
  const options = humanDecisionOptions(raised);
  const otherChosen = option === DECISION_OTHER_OPTION;
  const resumeOnly =
    paused && raised.length === 1 && raised[0]?.key === "raise_limit";
  const selected = resumeOnly && !otherChosen ? "raise_limit" : option;
  const grantCategory = canDelegate && delegateFuture && !otherChosen;
  const scopeRequired =
    q.trigger === "review_limit" &&
    ["split_card", "narrow_scope"].includes(selected);
  const noteRequired = scopeRequired || otherChosen;
  const rowHead = {
    ids: (
      <>
        <RowCard projectId={projectId} id={q.card_id} label={cardTitle(q)} />
        <IdTag id={q.id} label="拍板" />
      </>
    ),
    title: q.question,
    time: waitLabel(q.waited_ms, elapsed),
    status: <DecisionStatus q={q} />,
  };
  if (q.followup_notice)
    return (
      <NeedsRow {...rowHead} label={`拍板落实 ${q.id}`} muted>
        <DecisionDetailsMeta q={q} projectId={projectId} elapsed={elapsed} />
        <p>{q.followup_notice}</p>
        <p>
          已选方案：
          {decisionOptionOf(q, q.resolution?.option)?.description ??
            q.resolution?.option}
        </p>
        <p>影响：{decisionOptionOf(q, q.resolution?.option)?.impact}</p>
        <p>请安排落实，并在卡片时间线引用 {q.id} 记录执行结果。</p>
      </NeedsRow>
    );
  return (
    <NeedsRow
      {...rowHead}
      label={`拍板 ${q.id}`}
      urgent={q.blocking}
      summary={q.plain_summary?.changed}
      action={<NeedsOpenAction name={`处理 ${q.id}`} />}
      bodyClassName="needs-decision"
    >
      <DecisionDetailsMeta q={q} projectId={projectId} elapsed={elapsed} />
      <PlainSummary id={q.id} summary={q.plain_summary} />
      <DecisionRouting decision={q} />
      {q.grouped_decisions ? (
        <section className="needs-decision-group" aria-label="同类待处理事项">
          <p>本次只回答 {q.id}，其余事项仍待处理。</p>
          {q.grouped_decisions.map((item) => (
            <details className="needs-context" key={item.id}>
              <summary className="needs-decision-group-summary">
                {item.id} · {item.question}
                {" · "}
                {item.blocking ? "阻塞工作" : "不阻塞工作"}
              </summary>
              <EmployeeIdentity {...item} showTitle={false} />
              <StatusTag status={item.status} />
              <PlainSummary id={item.id} summary={item.plain_summary} />
              <DecisionRouting decision={item} />
              <DecisionContext
                context={item.context}
                summary={item.plain_summary}
                legacy="背景"
              />
              {item.approval_target && <p>审批版本：{item.approval_target}</p>}
              <DecisionAttachments attachments={item.attachments} />
              <ul>
                {item.options.map((option) => (
                  <li key={option.key}>
                    {option.description}：{option.impact}
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </section>
      ) : (
        <>
          <DecisionContext
            context={q.context}
            summary={q.plain_summary}
            legacy="背景"
          />
          <DecisionAttachments attachments={q.attachments} />
        </>
      )}
      {q.grouped_decisions && (
        <p className="needs-answer-target">
          当前回答 {q.id} ·{" "}
          {q.grouped_decisions.find((item) => item.id === q.id)?.question}
        </p>
      )}
      {!paused && (
        <SuggestedDecision
          q={q}
          client={client}
          projectId={projectId}
          done={done}
          quote={quote}
          action={action}
        />
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (selected === "" || (noteRequired && !quote.trim())) return;
          void action.run(
            [projectId, q.id, "resolve", selected, quote, grantCategory],
            (key) =>
              grantCategory
                ? client.recordDecision(
                    projectId,
                    q.id,
                    selected,
                    quote,
                    key,
                    true,
                  )
                : client.recordDecision(projectId, q.id, selected, quote, key),
          );
        }}
      >
        <fieldset className="needs-options" data-needs-focus="">
          <legend>
            {q.grouped_decisions ? `回答 ${q.id}：选择方案` : "选择方案"}
          </legend>
          {options.map((o) => (
            <label
              key={o.key}
              className={`needs-option${selected === o.key ? " selected" : ""}`}
            >
              <input
                type="radio"
                name={`decision-${q.id}`}
                value={o.key}
                checked={selected === o.key}
                onChange={() => setOption(o.key)}
              />
              <span>
                <span className="needs-option-head">
                  <strong>
                    {o.key === DECISION_OTHER_OPTION
                      ? o.description
                      : q.trigger === "review_limit"
                        ? (reviewOptionLabels[o.key] ?? o.key)
                        : q.trigger === "accepted_delivery_rework"
                          ? (reworkOptionLabels[o.key] ?? o.description)
                          : o.key}
                  </strong>
                  {o.key !== DECISION_OTHER_OPTION && (
                    <span>
                      {q.trigger === "review_limit" && o.key === "raise_limit"
                        ? "增加一轮审核额度"
                        : o.description}
                    </span>
                  )}
                  {q.recommended === o.key && (
                    <span className="needs-recommended">推荐</span>
                  )}
                </span>
                <span className="needs-option-impact">
                  影响：
                  {q.trigger === "review_limit" && o.key === "raise_limit"
                    ? "审核上限加 1；没有其他阻塞且额度可用时自动恢复审核。"
                    : o.impact}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        {canDelegate && !otherChosen && (
          <label>
            <input
              type="checkbox"
              checked={delegateFuture}
              disabled={action.busy}
              onChange={(e) => setDelegateFuture(e.target.checked)}
            />
            此类问题以后由 PM 代拍
          </label>
        )}
        {independentLimit && (
          <p className="hint">
            本次加轮由你确认，不会开启常驻授权。请在设置的“授权”中
            <a
              href={routeHash({
                kind: "settings",
                projectId,
                filters: { tab: "authorization" },
              })}
            >
              管理独立复核加轮授权
            </a>
            ，每项累计最多代批 {independentLimit.max_delegated_raises} 次。
            没有新版本或触发强制交人条件时仍须你确认；重新开启也不接回已交人的事项。
          </p>
        )}
        <label>
          {scopeRequired
            ? "本轮移出的范围（必填）"
            : otherChosen
              ? "你的决定（必填，会作为你的原话记录）"
              : "补充说明（可选，会作为你的原话记录）"}
          <Textarea
            required={noteRequired}
            aria-label={`${q.id} 原话或补充说明`}
            value={quote}
            onChange={(e) => setQuote(e.target.value)}
          />
        </label>
        <div className="action-row">
          <button type="submit" disabled={action.busy || selected === ""}>
            {q.grouped_decisions
              ? resumeOnly && !otherChosen
                ? `为 ${q.id} 增加一轮审核额度`
                : `按所选回答 ${q.id}`
              : resumeOnly && !otherChosen
                ? "增加一轮审核额度"
                : "按所选拍板"}
          </button>
          {!paused &&
            (["request_information", "explain"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                className="quiet"
                disabled={action.busy || !q.card_id}
                onClick={() =>
                  void action.run(
                    [projectId, q.id, "comments", kind, quote],
                    (key) =>
                      client.decisionComment(projectId, q.id, kind, quote, key),
                  )
                }
              >
                {kind === "request_information" ? "要求补充信息" : "请 PM 解释"}
              </button>
            ))}
        </div>
      </form>
      {!q.card_id && <p className="hint">项目级事项请在 PM 对话中补充说明。</p>}
      {q.trigger === "worktree_cleanup" && q.assignment_id && (
        <CopyCommand
          label="查看 Diff"
          command={cliCommand(projectId, "worktree diff", q.assignment_id)}
        />
      )}
      <RequestFeedback
        interactive
        pending={action.busy}
        pendingMessage="提交中…"
        error={action.error}
        message={action.message}
      />
    </NeedsRow>
  );
}
/**
 * C-192: one-click handling of a (non-merge) decision's suggestion. Needs You
 * and card details share it; a suggested return keeps its editable reason.
 */
export function SuggestedDecision({
  q,
  client,
  projectId,
  done,
  quote = "",
  action: shared,
}: Props & {
  q: Pick<DecisionView, "id" | "suggestion" | "options">;
  done: () => void;
  /** Supplementary words the human typed elsewhere on the same card. */
  quote?: string;
  /** Share the surrounding form's busy and feedback state. */
  action?: ReturnType<typeof useAction>;
}) {
  const own = useAction(done);
  const action = shared ?? own;
  const [reason, setReason] = usePrefilledReason(q.suggestion);
  const suggestion = q.suggestion;
  if (!suggestion) return null;
  return (
    <>
      <DecisionSuggestion
        id={q.id}
        suggestion={suggestion}
        label={
          q.options.find((o) => o.key === suggestion.option)?.description ??
          suggestion.option
        }
        busy={action.busy}
        reason={reason}
        onReason={setReason}
        onApply={() => {
          const said = suggestion.option === "request_changes" ? reason : quote;
          void action.run(
            [
              projectId,
              q.id,
              "suggestion",
              suggestion.option,
              said,
              suggestion.progress?.token,
              suggestion.version,
            ],
            (key) =>
              client.applySuggestion(
                projectId,
                q.id,
                suggestion.option,
                said,
                key,
                suggestion.progress?.token,
                suggestion.version,
              ),
          );
        }}
      />
      {!shared && (
        <RequestFeedback
          interactive
          pending={action.busy}
          pendingMessage="提交中…"
          error={action.error}
          message={action.message}
        />
      )}
    </>
  );
}
function ReviewLine({ review }: { readonly review: MergeConfirmationReview }) {
  const label =
    [review.work_item_title, review.role_id].filter(Boolean).join(" ") ||
    "验证";
  return (
    <li>
      <IdentityRow className="needs-review-head">
        <EmployeeIdentity {...review} showTitle={false} />
        <IdTag id={review.work_item_id} label={label} />
        <StatusTag status={review.verdict} />
        {review.followup_card_id && (
          <IdTag id={review.followup_card_id} label="后续卡" />
        )}
      </IdentityRow>
      {review.issues.length > 0 && (
        <details className="needs-review-issues">
          <summary>问题（{review.issues.length}）</summary>
          <ul>
            {review.issues.map((issue) => (
              <li key={`${review.id}-${issue.severity}-${issue.description}`}>
                <strong>
                  {issue.must_fix ? "必须修" : "非阻塞"} · {issue.severity}
                  {issue.impact && ` · ${reviewImpactLabel[issue.impact]}`}
                </strong>
                <span>{issue.description}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}
function PreMergeCheckList({
  checks,
}: {
  checks: readonly PreMergeCheckView[];
}) {
  return (
    <ul className="pre-merge-check-list">
      {checks.map((c) => (
        <li key={c.label}>
          <strong>{c.label}</strong>：{PRE_MERGE_COPY.status[c.status]}
          {c.stale && (
            <span className="hint">（{PRE_MERGE_COPY.staleNote}）</span>
          )}
          {c.note && <span className="hint">（{c.note}）</span>}
        </li>
      ))}
    </ul>
  );
}
/**
 * C-160: checks the human wants done before confirming (e.g. an independent
 * security review). Advisory: the confirm button stays available.
 */
function PreMergeChecks({ checks }: { checks: readonly PreMergeCheckView[] }) {
  if (checks.length === 0) return null;
  const open = checks.filter((c) => c.status !== "passed");
  if (open.length > 0)
    return (
      <section
        className="pre-merge-checks pre-merge-waiting"
        role="status"
        aria-label={PRE_MERGE_COPY.region}
      >
        <p className="pre-merge-title">
          {PRE_MERGE_COPY.waitingTitle(open.map((c) => c.label))}
        </p>
        <p>{PRE_MERGE_COPY.missingHeading}</p>
        <PreMergeCheckList checks={open} />
        <p className="hint">{PRE_MERGE_COPY.waitingHint}</p>
      </section>
    );
  return null;
}
/** Shared by Needs You and card details so human writes use the same controls. */
export function MergeConfirmation({
  q,
  client,
  projectId,
  done,
  elapsed,
  inCardHeader = false,
  confirmPmTakeover = false,
}: Props & {
  q: NeedsDecision;
  done: () => void;
  elapsed: number;
  inCardHeader?: boolean;
  confirmPmTakeover?: boolean;
}) {
  const [quote, setQuote] = useState("");
  const [returning, setReturning] = useState(false);
  const [holding, setHolding] = useState(false);
  const [holdReason, setHoldReason] = useState("");
  const [holdUntil, setHoldUntil] = useState("");
  const [overriding, setOverriding] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [answeringOther, setAnsweringOther] = useState(false);
  const [otherWords, setOtherWords] = useState("");
  const overrideError = mergeOverrideReasonError(overrideReason);
  const overrideTrigger = useRef<HTMLButtonElement>(null);
  const overrideCancel = useRef<HTMLButtonElement>(null);
  // C-192: once confirmed, only a return is still possible (failed check).
  const suggestion =
    q.status === "resolved" && q.suggestion?.option !== "request_changes"
      ? undefined
      : q.suggestion;
  const [reason, setReason] = usePrefilledReason(suggestion);
  const action = useAction(done);
  const merge = q.merge_confirmation;
  const check = merge?.merge_check;
  const confirmed = q.status === "resolved";
  const controls = useRef<HTMLFormElement>(null);
  const [acceptedTakeover, setAcceptedTakeover] = useState<string>();
  const takeoverKey = JSON.stringify([
    projectId,
    q.id,
    merge?.completion?.id,
    merge?.completion?.subject.value,
  ]);
  const pmTakeover = confirmPmTakeover && q.decider === "role:pm" && !confirmed;
  const needsTakeover = pmTakeover && acceptedTakeover !== takeoverKey;
  const preChecks = merge?.pre_merge_checks ?? [];
  const blockers = merge?.blockers ?? ["检查状态尚未读取，请刷新"];
  const mergeBlocked = blockers.length > 0;
  const cardId = q.card_id ?? q.related_cards[0]?.id ?? null;
  const decide = (option: "merge", viaSuggestion = false) =>
    action.run(
      [
        projectId,
        q.id,
        "resolve",
        option,
        quote,
        viaSuggestion,
        viaSuggestion ? suggestion?.progress?.token : undefined,
        viaSuggestion ? suggestion?.version : undefined,
      ],
      (key) =>
        viaSuggestion
          ? client.applySuggestion(
              projectId,
              q.id,
              option,
              quote,
              key,
              suggestion?.progress?.token,
              suggestion?.version,
            )
          : client.recordDecision(projectId, q.id, option, quote, key),
    );
  const directActions = (
    <>
      {q.decider === "role:pm" &&
        !!merge?.decision_evidence_required?.length && (
          <p className="hint">
            你已批准相关范围或权限改动。PM
            确认合并前仍须逐项核对当前交付与拍板一致；超出批准的内容会交给你。
          </p>
        )}
      {!confirmed && (
        <button
          type="submit"
          form={`merge-${q.id}`}
          className={suggestion && !suggestion.stale ? "quiet" : undefined}
          disabled={action.busy || mergeBlocked}
        >
          {merge?.merge_check?.level === "card"
            ? "确认合并（批次检查通过后生效）"
            : "确认合并"}
        </button>
      )}
      {!confirmed && mergeBlocked && (
        <button
          ref={overrideTrigger}
          type="button"
          className="quiet"
          disabled={action.busy}
          onClick={() => {
            setOverrideReason("");
            setOverriding(true);
          }}
        >
          仍要合并
        </button>
      )}
      {merge?.merge_gate_enabled &&
        !merge.merge_noop &&
        check &&
        ["failed", "timed_out"].includes(check.status) &&
        cardId && (
          <button
            type="button"
            className="quiet"
            disabled={action.busy}
            onClick={() =>
              void action.run(
                [
                  projectId,
                  cardId,
                  "recheck",
                  check.completion_id,
                  check.attempt_id,
                ],
                (key) =>
                  client.recheckMerge(
                    projectId,
                    cardId,
                    check.completion_id,
                    key,
                  ),
              )
            }
          >
            重新检查
          </button>
        )}
      {!confirmed && (
        <button
          type="button"
          className="quiet"
          disabled={action.busy}
          onClick={() => setHolding(true)}
        >
          暂不合并
        </button>
      )}
      <button
        type="button"
        className="quiet"
        disabled={action.busy}
        onClick={() => setReturning(true)}
      >
        退回修改
      </button>
      {!confirmed && (
        <Button
          variant="ghost"
          disabled={action.busy}
          onClick={() => setAnsweringOther(true)}
        >
          {decisionOtherOption.description}
        </Button>
      )}
    </>
  );
  const content = (
    <>
      {q.plain_summary ? (
        <PlainSummary
          id={q.id}
          summary={q.plain_summary}
          omitRisk={inCardHeader}
        />
      ) : (
        <p className="hint">尚未提供改动概述 / 风险尚未说明</p>
      )}
      <DecisionRouting decision={q} />
      {q.status === "snoozed" && q.snooze && (
        <p role="status" aria-label="已暂缓">
          暂缓原因：{q.snooze.reason}
        </p>
      )}
      <SourceMergeSuggestion
        client={client}
        projectId={projectId}
        decision={q}
        done={done}
      />
      {!confirmed && <PreMergeChecks checks={preChecks} />}
      {merge?.reviews.flatMap((review) =>
        review.issues
          .filter(
            (issue) =>
              issue.must_fix &&
              !(
                review.verdict === "conditional" &&
                review.followup_card_id &&
                issue.impact === "ux_only"
              ),
          )
          .map((issue) => (
            <p className="error" key={`${review.id}/${issue.description}`}>
              必须修复：{issue.description}
              {issue.impact && ` · ${reviewImpactLabel[issue.impact]}`}
            </p>
          )),
      )}
      {merge?.known_gaps
        ?.filter((gap) => gap.precondition)
        .map((gap) => (
          <p
            className="merge-exception"
            key={`${gap.description}/${gap.precondition}`}
          >
            {gap.description} · 前置条件：{gap.precondition}
          </p>
        ))}
      {check?.summary &&
        ["failed", "timed_out", "interrupted", "executor_unreachable"].includes(
          check.status,
        ) && <p className="merge-check-summary">{check.summary}</p>}
      <DecisionAttachments attachments={q.attachments} />
      {merge?.merge_gate_invalid && (
        <p className="error">合并闸门配置无效，请查看 server 启动日志</p>
      )}
      {merge?.merge_noop && (
        <p className="hint">
          主机已验证交付均在基线中，无需合并检查；请确认是否完成此次合并。
        </p>
      )}
      {merge?.merge_gate_enabled &&
        !merge.merge_noop &&
        check &&
        ["failed", "timed_out"].includes(check.status) && (
          <p className="hint" role="note">
            合并检查：未通过。检查不会自己变成通过，请退回修改；确认是偶发失败的，可以重新检查。
          </p>
        )}
      {merge?.merge_gate_enabled &&
        !merge.merge_noop &&
        check &&
        ["interrupted", "executor_unreachable"].includes(check.status) && (
          <p className="hint" role="note">
            合并检查：已中断。主机恢复后会自动重新排队；也可以先退回修改或暂不合并。
          </p>
        )}
      {!confirmed && (
        <div role="status" aria-label="合并前置条件">
          {mergeBlocked ? (
            <>
              <p>等待中：</p>
              <ul>
                {blockers.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>检查都已通过</p>
          )}
        </div>
      )}
      {pmTakeover && (
        <div data-needs-focus={needsTakeover ? "" : undefined}>
          <PmMergeTakeover
            key={takeoverKey}
            title={
              q.related_cards.find((card) => card.id === cardId)?.title ??
              decisionTitle(q)
            }
            waitingForCheck={
              !!merge?.merge_gate_enabled &&
              !merge.merge_noop &&
              (!check || ["queued", "running"].includes(check.status))
            }
            accepted={!needsTakeover}
            onAccept={() => setAcceptedTakeover(takeoverKey)}
            controls={controls}
          />
        </div>
      )}
      {!needsTakeover && suggestion && (
        <div data-needs-focus="">
          <DecisionSuggestion
            id={q.id}
            suggestion={suggestion}
            explicitAction
            actions={directActions}
            label={
              SUGGESTION_COPY.mergeOptions[suggestion.option] ??
              suggestion.option
            }
            busy={
              action.busy || (suggestion.option === "merge" && mergeBlocked)
            }
            reason={reason}
            onReason={setReason}
            onApply={() => {
              if (suggestion.option === "request_changes")
                void action.run(
                  [
                    projectId,
                    q.id,
                    "suggestion",
                    "request_changes",
                    reason,
                    suggestion.progress?.token,
                    suggestion.version,
                  ],
                  (key) =>
                    client.applySuggestion(
                      projectId,
                      q.id,
                      "request_changes",
                      reason,
                      key,
                      suggestion.progress?.token,
                      suggestion.version,
                    ),
                );
              else if (!mergeBlocked) void decide("merge", true);
            }}
          />
        </div>
      )}
      <form
        ref={controls}
        tabIndex={-1}
        aria-label="合并处理操作"
        hidden={needsTakeover}
        id={`merge-${q.id}`}
        onSubmit={(e) => {
          e.preventDefault();
          if (needsTakeover || confirmed || mergeBlocked) return;
          void decide("merge");
        }}
      >
        {confirmed ? (
          <p className="hint">{q.why}</p>
        ) : (
          <details className="merge-quote">
            <summary>补充说明</summary>
            <label>
              补充说明（可选，会作为你的原话记录）
              <Textarea
                aria-label={`${q.id} 原话或补充说明`}
                value={quote}
                onChange={(e) => setQuote(e.target.value)}
              />
            </label>
          </details>
        )}
        {(!suggestion || suggestion.stale) && (
          <div className="action-row" data-needs-focus="">
            {directActions}
          </div>
        )}
      </form>
      {holding && !confirmed && !needsTakeover && (
        <form
          aria-label="暂缓合并"
          onSubmit={(event) => {
            event.preventDefault();
            if (
              !holdReason.trim() ||
              (holdUntil && !Number.isFinite(Date.parse(holdUntil)))
            )
              return;
            const until = holdUntil
              ? new Date(holdUntil).toISOString()
              : undefined;
            void action.run(
              [projectId, q.id, "hold", holdReason, until],
              async (key) => {
                await client.recordDecision(
                  projectId,
                  q.id,
                  "hold",
                  holdReason,
                  key,
                  false,
                  until,
                );
                setHolding(false);
                setHoldReason("");
                setHoldUntil("");
              },
            );
          }}
        >
          <label>
            暂缓原因（必填）
            <Textarea
              required
              value={holdReason}
              onChange={(e) => setHoldReason(e.target.value)}
            />
          </label>
          <label>
            暂缓到期时间（可选）
            <input
              type="datetime-local"
              value={holdUntil}
              onChange={(e) => setHoldUntil(e.target.value)}
            />
          </label>
          <p className="hint">
            不填到期时间时使用项目默认暂缓时长，到期后自动放回待处理。
          </p>
          <button type="submit" disabled={action.busy || !holdReason.trim()}>
            登记暂缓
          </button>
          <button
            type="button"
            className="quiet"
            disabled={action.busy}
            onClick={() => setHolding(false)}
          >
            取消暂缓
          </button>
        </form>
      )}
      <Dialog.Root
        open={overriding && !confirmed && !needsTakeover}
        onOpenChange={setOverriding}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="pre-merge-overlay" />
          <Dialog.Content
            role="alertdialog"
            aria-modal="true"
            className="pre-merge-dialog pre-merge-checks pre-merge-waiting"
            aria-describedby={undefined}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              overrideCancel.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              overrideTrigger.current?.focus();
            }}
          >
            <Dialog.Title>仍要确认合并？</Dialog.Title>
            <p>
              以下条件尚未满足。请写明仍要确认的理由，系统会记录理由和当前缺项。
            </p>
            <ul>
              {blockers.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            <label>
              强行合并理由（必填）
              <Textarea
                value={overrideReason}
                aria-invalid={!!overrideReason.trim() && !!overrideError}
                aria-describedby={
                  overrideReason.trim() && overrideError
                    ? `override-error-${q.id}`
                    : undefined
                }
                onChange={(event) => setOverrideReason(event.target.value)}
              />
            </label>
            {overrideReason.trim() && overrideError && (
              <p id={`override-error-${q.id}`} className="error" role="alert">
                {overrideError}
              </p>
            )}
            {action.error && (
              <p className="error" role="alert">
                {action.error}
              </p>
            )}
            <div className="action-row">
              <Dialog.Close asChild>
                <button ref={overrideCancel} type="button">
                  先不确认
                </button>
              </Dialog.Close>
              <button
                type="button"
                className="quiet"
                disabled={action.busy || !!overrideError}
                onClick={() => {
                  if (overrideError) return;
                  void action.run(
                    [projectId, q.id, "merge-override", quote, overrideReason],
                    async (key) => {
                      await client.recordDecision(
                        projectId,
                        q.id,
                        "merge",
                        quote,
                        key,
                        false,
                        undefined,
                        overrideReason,
                      );
                      setOverriding(false);
                    },
                  );
                }}
              >
                确认仍要合并
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {answeringOther && !confirmed && !needsTakeover && (
        <form
          aria-label={`${q.id} ${decisionOtherOption.description}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (!otherWords.trim()) return;
            void action.run(
              [projectId, q.id, "resolve", DECISION_OTHER_OPTION, otherWords],
              (key) =>
                client.recordDecision(
                  projectId,
                  q.id,
                  DECISION_OTHER_OPTION,
                  otherWords,
                  key,
                ),
            );
          }}
        >
          <label>
            你的决定（必填，会作为你的原话记录）
            <Textarea
              aria-label={`${q.id} 其他决定`}
              required
              value={otherWords}
              onChange={(e) => setOtherWords(e.target.value)}
            />
          </label>
          <div className="action-row">
            <Button
              type="submit"
              variant="primary"
              disabled={action.busy || !otherWords.trim()}
            >
              提交
            </Button>
            <Button
              variant="ghost"
              disabled={action.busy}
              onClick={() => setAnsweringOther(false)}
            >
              取消
            </Button>
          </div>
        </form>
      )}
      {returning && !needsTakeover && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!reason.trim()) return;
            void action.run(
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
          }}
        >
          <label>
            退回原因（必填）
            <Textarea
              aria-label={`${q.id} 退回原因`}
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="action-row">
            <button type="submit" disabled={action.busy || !reason.trim()}>
              确认退回修改
            </button>
            <button
              type="button"
              className="quiet"
              disabled={action.busy}
              onClick={() => setReturning(false)}
            >
              取消
            </button>
          </div>
        </form>
      )}
      <div className="merge-evidence">
        <details
          className="needs-merge-section"
          aria-label="要合并的交付"
          open={!q.plain_summary}
        >
          <summary>要合并的交付（{merge?.deliveries.length ?? 0} 项）</summary>
          {!merge || merge.deliveries.length === 0 ? (
            <p className="hint">还没有可合并的交付。</p>
          ) : (
            <ul className="needs-delivery-list">
              {merge.deliveries.map((delivery) => (
                <li key={delivery.id}>
                  <IdentityRow className="needs-delivery-head">
                    <EmployeeIdentity {...delivery} showTitle={false} />
                    <IdTag
                      id={delivery.work_item_id}
                      label={delivery.work_item_title}
                    />
                    <code title={delivery.subject.value}>
                      {delivery.subject.value.slice(0, 12)}
                    </code>
                    {cardId && (
                      <a
                        href={routeHash({
                          kind: "card",
                          projectId,
                          cardId,
                          anchor: `delivery-${delivery.id}`,
                        })}
                      >
                        查看改动
                      </a>
                    )}
                  </IdentityRow>
                  <p>{delivery.summary}</p>
                </li>
              ))}
            </ul>
          )}
        </details>
        <details className="needs-merge-section" aria-label="审核与验收">
          <summary>审核与验收（{merge?.reviews.length ?? 0} 项）</summary>
          {!merge || merge.reviews.length === 0 ? (
            <p className="hint">还没有审核或验收结论。</p>
          ) : (
            <ul className="needs-review-list">
              {merge.reviews.map((review) => (
                <ReviewLine key={review.id} review={review} />
              ))}
            </ul>
          )}
        </details>
        <details
          className="needs-merge-section"
          aria-label="已知遗留"
          open={!merge?.known_gaps || merge.known_gaps.length > 0}
        >
          <summary>
            已知遗留{" "}
            {merge?.known_gaps ? `${merge.known_gaps.length} 项` : "资料未提供"}
          </summary>
          {!merge?.known_gaps ? (
            <p>遗留资料未提供，不能视为无遗留</p>
          ) : merge.known_gaps.length === 0 ? (
            <p className="hint">没有已知遗留。</p>
          ) : (
            <ul className="needs-gap-list">
              {merge.known_gaps.map((gap) => (
                <li
                  key={`${gap.description}-${gap.followup_card_id ?? ""}-${gap.precondition ?? ""}`}
                >
                  <span>{gap.description}</span>
                  {gap.followup_card_id && (
                    <CardLink
                      projectId={projectId}
                      id={gap.followup_card_id}
                      label="后续卡"
                    />
                  )}
                  {gap.precondition && (
                    <span className="hint">前置条件：{gap.precondition}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </details>
        {merge?.merge_gate_enabled &&
          !merge.merge_noop &&
          !merge.merge_gate_invalid && (
            <details className="needs-merge-section">
              <summary>合并检查详情</summary>
              <MergeCheck
                check={check ?? null}
                projectId={projectId}
                live
                detailsOnly
              />
            </details>
          )}
        {!!preChecks.length && (
          <details className="needs-merge-section">
            <summary>合并前核对（{preChecks.length} 项）</summary>
            <PreMergeCheckList checks={preChecks} />
          </details>
        )}
        <DecisionContext
          context={q.context}
          summary={q.plain_summary}
          legacy="上下文原文"
        />
        <details className="needs-merge-section">
          <summary>操作说明</summary>
          <ol className="pre-merge-steps">
            {PRE_MERGE_COPY.readySteps(
              !!merge?.merge_gate_enabled && !merge.merge_noop,
            ).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p>两种确认都会记录你的合并决定，“按建议”另记为采纳建议。</p>
        </details>
      </div>
      <RequestFeedback
        interactive
        pending={action.busy}
        pendingMessage="提交中…"
        error={action.error}
        message={action.message}
      />
    </>
  );
  const title = (
    <>
      <PriorityBadge value={q.card_priority ?? 0} />
      {decisionTitle(q)}
    </>
  );
  if (inCardHeader)
    return (
      <article
        className="needs-item needs-merge"
        aria-label={`合并确认 ${q.id}`}
      >
        <DecisionMeta q={q} projectId={projectId} elapsed={elapsed} hideCard />
        <h3 className="needs-question">{title}</h3>
        {content}
      </article>
    );
  return (
    <NeedsRow
      label={`合并确认 ${q.id}`}
      ids={
        <>
          <RowCard
            projectId={projectId}
            id={cardId}
            label={cardTitle(q, cardId)}
          />
          <IdTag id={q.id} label="合并确认" />
        </>
      }
      title={title}
      summary={q.plain_summary?.changed}
      time={waitLabel(q.waited_ms, elapsed)}
      status={
        confirmed ? (
          <StatusTag status="resolved" label="已确认" />
        ) : q.status === "snoozed" ? (
          <StatusTag status="snoozed" />
        ) : mergeBlocked ? (
          <StatusTag status="open" label="未就绪" />
        ) : (
          <StatusTag status="passed" label="可合并" />
        )
      }
      action={
        pmTakeover ? (
          <NeedsOpenAction name={`查看 ${q.id}`} secondary>
            查看
          </NeedsOpenAction>
        ) : (
          <NeedsOpenAction name={`处理 ${q.id}`} />
        )
      }
      bodyClassName="needs-merge"
    >
      <DecisionDetailsMeta q={q} projectId={projectId} elapsed={elapsed} />
      <MergeStatusLine q={q} elapsed={elapsed} />
      {content}
    </NeedsRow>
  );
}
function CloseLaterAction({
  item,
  client,
  projectId,
  closed,
  opened,
}: Props & {
  opened: () => void;
  item: { id: string; title: string };
  closed: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const finished = useRef(false);
  const reasonInput = useRef<HTMLTextAreaElement>(null);
  const action = useAction(() => {
    finished.current = true;
    setOpen(false);
    closed(item.id);
  });
  useEffect(() => {
    if (action.error) reasonInput.current?.focus({ preventScroll: true });
  }, [action.error]);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (action.busy) return;
        if (next) {
          finished.current = false;
          action.clearFeedback();
          opened();
        }
        setOpen(next);
      }}
    >
      <Dialog.Trigger asChild>
        <Button
          data-close-action={item.id}
          aria-label={`关闭 ${item.id}（不再需要）`}
        >
          关闭（不再需要）
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="pre-merge-overlay" />
        <Dialog.Content
          className="pre-merge-dialog needs-close-dialog"
          onCloseAutoFocus={(event) => {
            if (finished.current) event.preventDefault();
          }}
        >
          <Dialog.Title>关闭待办 {item.id}</Dialog.Title>
          <Dialog.Description>
            只关闭这条待办，不记为完成。其它等待事项保持原状。
          </Dialog.Description>
          <p>{item.title}</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!reason.trim()) return;
              void action.run([projectId, item.id, "cancel", reason], (key) =>
                client.cancelAction(projectId, item.id, reason, key),
              );
            }}
          >
            <label>
              关闭理由（必填）
              <Textarea
                ref={reasonInput}
                required
                value={reason}
                disabled={action.busy}
                onChange={(event) => {
                  setReason(event.target.value);
                  action.clearFeedback();
                }}
              />
            </label>
            <div className="action-row">
              <button type="submit" disabled={action.busy || !reason.trim()}>
                确认关闭
              </button>
              <Dialog.Close asChild>
                <button type="button" className="quiet" disabled={action.busy}>
                  暂不关闭
                </button>
              </Dialog.Close>
            </div>
          </form>
          <RequestFeedback
            interactive
            pending={action.busy}
            pendingMessage="正在关闭…"
            error={action.error}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * C-503: a story's current proposal. "确认开卡" opens every child in one step;
 * a change request is written on the story card itself.
 */
function StoryProposalRow({
  item,
  client,
  projectId,
  done,
  elapsed,
}: Props & {
  item: NeedsStoryProposal;
  done: () => void;
  elapsed: number;
}) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<StoryRefusal>();
  const [message, setMessage] = useState("");
  const sending = useRef(false);
  const refreshButton = useRef<HTMLButtonElement>(null);
  // Same version, same key: a retry after a lost reply opens nothing twice.
  const key = useRef(crypto.randomUUID());
  const cardHref = (anchor?: string) =>
    routeHash({
      kind: "card",
      projectId,
      cardId: item.card_id,
      ...(anchor ? { anchor } : {}),
    });
  return (
    <NeedsRow
      label={`确认拆解 ${item.card_id}`}
      ids={
        <>
          <RowCard
            projectId={projectId}
            id={item.card_id}
            label={item.card_title}
          />
          <IdTag
            id={item.entry_id}
            label="拆解方案"
            href={cardHref(`entry-${item.entry_id}`)}
          />
        </>
      }
      title={`确认拆解：第 ${item.version} 版，${item.children.length} 张子卡`}
      summary={noticeLine(item.children.map((c) => c.title).join("、"))}
      alert={
        refusal && (
          <>
            <span>{refusal.message}</span>
            {refusal.stale && (
              <Button ref={refreshButton} variant="outline" onClick={done}>
                刷新
              </Button>
            )}
          </>
        )
      }
      time={waitLabel(item.waited_ms, elapsed)}
      status={<StatusTag status="open" label="待确认" />}
      action={
        <Button
          variant="primary"
          aria-disabled={busy || undefined}
          disabled={refusal?.stale}
          aria-label={`确认开卡 ${item.card_id} 第 ${item.version} 版`}
          onClick={async () => {
            if (sending.current) return;
            sending.current = true;
            setBusy(true);
            setRefusal(undefined);
            try {
              const result = await client.confirmStoryProposal(
                projectId,
                item.card_id,
                item.version,
                key.current,
              );
              setMessage(
                `${item.card_id} 已开出 ${result.card_ids.length} 张子卡`,
              );
              done();
            } catch (cause) {
              const refused = storyRefusal(cause);
              setRefusal(refused);
              if (refused.stale)
                requestAnimationFrame(() => refreshButton.current?.focus());
            } finally {
              sending.current = false;
              setBusy(false);
            }
          }}
        >
          确认开卡
        </Button>
      }
    >
      <ol aria-label={`${item.card_id} 第 ${item.version} 版子卡`}>
        {item.children
          .map((child, i) => ({ ...child, number: i + 1 }))
          .map((child) => (
            <li key={child.number}>
              {child.title}（模板 {child.template_id} · 负责 {child.owner_role}
              ）
            </li>
          ))}
      </ol>
      <p>
        <a href={cardHref()}>回到需求卡提修改意见</a>
      </p>
      <RequestFeedback message={message} />
    </NeedsRow>
  );
}
function HumanAction({
  item,
  client,
  projectId,
  done,
  elapsed,
}: Props & { item: NeedsAction; done: () => void; elapsed: number }) {
  const [text, setText] = useState("");
  const [conclusion, setConclusion] = useState<
    "exited" | "false_alarm" | "unconfirmed" | ""
  >("");
  const action = useAction(done);
  // C-742: 张良's actions can be viewed and taken back, never completed here.
  const operator = item.executor === "operator";
  if (item.completion_notice !== undefined)
    return (
      <NeedsRow
        label={`执行结果待接手 ${item.id}`}
        ids={
          <>
            {item.card_id && (
              <RowCard projectId={projectId} id={item.card_id} />
            )}
            <IdTag id={item.id} label="执行结果" />
          </>
        }
        title={item.why}
        status={<StatusTag status="completed" />}
        muted
      >
        <Markdown body={item.completion_notice} />
        <p>请恢复发起方或启动项目的 PM Ops，继续处理这项执行结果。</p>
      </NeedsRow>
    );
  return (
    <NeedsRow
      label={`执行 ${item.id}`}
      ids={
        <>
          <RowCard projectId={projectId} id={item.card_id} />
          <IdTag id={item.id} label="操作" />
        </>
      }
      title={
        <>
          {item.triage === "host" ? "主机操作：" : ""}
          {item.handoff?.title ?? item.triage_rationale ?? item.why}
        </>
      }
      time={
        <>
          {item.last_loss_observation && (
            <>
              最近核对：
              <Time value={item.last_loss_observation.at} />
              {" · "}
            </>
          )}
          {waitLabel(item.waited_ms, elapsed)}
          {item.due && (
            <>
              {" · 截止："}
              <Time value={item.due} />
            </>
          )}
        </>
      }
      status={
        <StatusTag
          status="todo"
          label={
            item.last_loss_observation
              ? "已记录：无法确认"
              : operator
                ? "待张良执行"
                : item.triage === "host"
                  ? item.host_operator === "external"
                    ? "待外接操作员"
                    : "待主机操作"
                  : "待你执行"
          }
        />
      }
      action={
        item.triage === "host" || operator ? (
          <NeedsOpenAction name={`查看 ${item.id}`} secondary>
            查看
          </NeedsOpenAction>
        ) : (
          <NeedsOpenAction name={`处理 ${item.id}`} />
        )
      }
    >
      <IdentityRow className="needs-meta">
        <EmployeeIdentity {...item} showTitle={false} />
      </IdentityRow>
      {item.pre_merge_check_reminder && item.card_id && (
        <p
          className="needs-reminder"
          role="note"
          aria-label={`${item.id} 核对项提醒`}
        >
          <StatusTag status="passed" label={PRE_MERGE_COPY.reminderTag} />{" "}
          {item.pre_merge_check_reminder.text}（
          <Time value={item.pre_merge_check_reminder.at} />）{" "}
          <a
            href={routeHash({
              kind: "card",
              projectId,
              cardId: item.card_id,
              anchor: `human-action-${item.id}`,
            })}
          >
            {PRE_MERGE_COPY.reminderLink}
          </a>
        </p>
      )}
      {/* C-212: by default only what to do; explanations are folded. */}
      {item.handoff?.todo && (
        <p
          className="needs-todo"
          role="note"
          aria-label={`${item.id} 你要做什么`}
        >
          {item.handoff.todo}
        </p>
      )}
      <section className="needs-steps" aria-label={`${item.id} 步骤`}>
        <Markdown body={item.instructions} />
        {item.terminal && (
          <>
            <p>执行目标：{item.terminal.target}</p>
            <p>登录方式：{item.terminal.login}</p>
            <CopyCommand
              block
              label="执行命令"
              command={item.terminal.command}
            />
            <p>预期输出：{item.terminal.expected_output}</p>
            <p>失败处理：{item.terminal.on_failure}</p>
          </>
        )}
        {item.helper_checks && (
          <dl aria-label="升级核验结果">
            {(["worker", "machine"] as const).map((kind) => (
              <div key={kind}>
                <dt>{kind} check</dt>
                <dd>
                  {item.helper_checks?.[kind].status === "passed"
                    ? "通过"
                    : `未通过：${item.helper_checks?.[kind].failed_steps.join("、")}`}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>
      <details className="needs-context">
        <summary>说明与回传要求</summary>
        {item.handoff && (
          <>
            <p className="hint">
              <StatusTag status="completed" label="项目经理已改写" /> ·{" "}
              <Time value={item.handoff.rewritten_at} />
            </p>
            <h4>这是什么</h4>
            <Markdown body={item.handoff.summary} />
            <h4>为什么需要你</h4>
            <Markdown body={item.handoff.why_human} />
            <h4>做完会怎样</h4>
            <Markdown body={item.handoff.expected_outcome} />
          </>
        )}
        <h4>回传要求</h4>
        <Markdown body={item.expected_return} />
      </details>
      {item.original_request && (
        <details className="needs-context">
          <summary>查看改写前的内容</summary>
          <Markdown body={item.original_request.instructions} />
          <p>原请求原因：{item.original_request.why_human}</p>
          <p>原期望返回：{item.original_request.expected_return}</p>
        </details>
      )}
      {operator ? (
        <Button
          data-needs-focus=""
          disabled={action.busy}
          onClick={() =>
            void action.run([projectId, item.id, "reassign"], (key) =>
              client.reassignAction(
                projectId,
                item.id,
                "owner",
                "所有者改为自己处理",
                key,
              ),
            )
          }
        >
          改由我处理
        </Button>
      ) : (
        <form
          data-needs-focus=""
          onSubmit={(e) => {
            e.preventDefault();
            if (item.requires_loss_conclusion && !conclusion) return;
            void action.run(
              [projectId, item.id, "complete", text, conclusion],
              async (key) => {
                if (!conclusion)
                  return client.completeAction(projectId, item.id, text, key);
                await client.completeAction(
                  projectId,
                  item.id,
                  text,
                  key,
                  conclusion,
                );
                if (conclusion === "unconfirmed") {
                  setText((draft) => (draft === text ? "" : draft));
                }
              },
            );
          }}
        >
          {item.requires_loss_conclusion && (
            <label>
              失联结论
              <SelectControl
                required
                aria-label={`${item.id} 失联结论`}
                value={conclusion}
                onValueChange={(v) =>
                  setConclusion(
                    v === "exited" || v === "false_alarm" || v === "unconfirmed"
                      ? v
                      : "",
                  )
                }
              >
                <option value="">请选择</option>
                <option value="exited">已退出</option>
                <option value="false_alarm">仍在运行（误报）</option>
                <option value="unconfirmed">无法确认</option>
              </SelectControl>
            </label>
          )}
          <label>
            执行结果
            <Textarea
              aria-label={`${item.id} 执行结果`}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <button type="submit" disabled={action.busy || !text.trim()}>
            {conclusion === "unconfirmed" ? "记录核对结果" : "确认已完成"}
          </button>
        </form>
      )}
      <RequestFeedback
        interactive
        pending={action.busy}
        pendingMessage="提交中…"
        error={action.error}
        message={action.message}
      />
    </NeedsRow>
  );
}
const incidentSituation: Record<string, string> = {
  lost: "这个 Agent 的运行环境失联了，它手上的工作暂停了。",
  unknown: "主机暂时确认不了这个 Agent 是否还在运行。",
};
/** C-153: plain-language guidance first; commands are for host operators. */
function Incident({
  incident,
  handling,
  projectId,
  elapsed,
}: {
  readonly incident: NeedsPage["incidents"][number];
  readonly handling: IncidentHandling | undefined;
  readonly projectId: string;
  readonly elapsed: number;
}) {
  const hostOps = handling?.host_ops ?? null;
  const office = handling?.pm_office ?? null;
  const minutes = hostOps
    ? Math.max(1, Math.round(hostOps.patrol_interval_ms / 60000))
    : null;
  const overdue =
    hostOps === null ||
    (incident.waited_ms !== null &&
      incident.waited_ms + elapsed >= hostOps.patrol_interval_ms);
  // Without a PM Office or a card to comment on, the platform owner is next.
  const viaCard = office !== null && incident.card_id !== null;
  const contact = viaCard
    ? ` PM Office${office.name ? `（${office.name}）` : " "}`
    : "平台负责人";
  const message = `${viaCard ? `@${office.mention} ` : ""}${incident.id} 运行异常${
    minutes === null ? "" : `超过 ${minutes} 分钟`
  }仍未恢复，请处理。`;
  // C-153: name the hc session the server registered, never a guessed default.
  const session = handling?.hc_session;
  const attach = `${cliCommand(projectId, "assignment attach", incident.id)}${
    session ? ` --hc-session ${quote(session)}` : ""
  }`;
  return (
    <NeedsRow
      label={`运行异常 ${incident.id}`}
      urgent
      ids={
        <>
          <RowCard projectId={projectId} id={incident.card_id} />
          <IdTag id={incident.id} label={incident.role_id} />
        </>
      }
      title={overdue ? "运行异常，需要你联系处理" : "运行异常"}
      time={waitLabel(incident.waited_ms, elapsed)}
      status={<StatusTag status={incident.runtime_state} />}
      action={<NeedsOpenAction name={`处理 ${incident.id}`} />}
    >
      <IdentityRow className="needs-meta">
        <EmployeeIdentity
          {...incident}
          author_role={incident.role_id}
          showTitle={false}
        />
      </IdentityRow>
      <div>
        <p>
          {incidentSituation[incident.runtime_state] ??
            "这个 Agent 的运行状态异常。"}
          {hostOps
            ? `主机运维 ${hostOps.name ?? hostOps.assignment_id} 每 ${minutes} 分钟巡检一次，会自动取消、重排或重启卡住、失联的 Run。`
            : "这个项目没有配置主机运维，不会自动恢复。"}{" "}
          {overdue ? (
            <strong>需要你操作：请按下面的步骤联系{contact}。</strong>
          ) : (
            <strong>你现在不需要操作。</strong>
          )}
        </p>
        <p>
          {waitLabel(incident.waited_ms, elapsed)}。
          {hostOps &&
            (overdue
              ? `已超过 ${minutes} 分钟仍未恢复：`
              : `超过 ${minutes} 分钟仍未恢复时，请这样做：`)}
        </p>
        <ol className="incident-steps">
          {viaCard ? (
            <>
              <li>
                打开卡片{" "}
                <a
                  href={routeHash({
                    kind: "card",
                    projectId,
                    cardId: incident.card_id ?? "",
                  })}
                >
                  {incident.card_id}
                </a>
                。
              </li>
              <li>
                在卡片页底部的“评论正文”框里填写：<code>{message}</code>
              </li>
              <li>点“发表评论”。</li>
            </>
          ) : (
            <li>
              直接联系{contact}，告诉对方：<code>{message}</code>
            </li>
          )}
          <li>
            等{contact}回复。只有 PM Office
            或主机运维明确请你接管时，才展开下面的“需要接管输入？”。
          </li>
        </ol>
      </div>
      {incident.disconnected_at && (
        <p>
          失联时间：
          <Time value={incident.disconnected_at} />
        </p>
      )}
      {incident.last_run && (
        <p>
          最近 Run：
          <IdTag id={incident.last_run.id} label="执行" />{" "}
          {incident.last_run.summary}
        </p>
      )}
      <details>
        <summary>需要接管输入？</summary>
        <TakeoverWarning />
        <CopyCommand label="接管输入" command={`${attach} --interactive`} />
      </details>
      <details>
        <summary>主机操作员用</summary>
        <p className="hint">
          以下命令需要在主机上、加载了运行环境的 shell 里执行；用
          deploy/install-cli.sh 安装的 cardigan 命令会自动加载。
          {session &&
            `hc 会话 ${session} 取自 server 登记的运行时（runtime.json）。`}
        </p>
        <CopyCommand label="查看终端（只看不动）" command={attach} />
        <CopyCommand
          label="检查异常"
          command={cliCommand(projectId, "attention")}
        />
      </details>
    </NeedsRow>
  );
}
type NeedsResource = ReturnType<typeof useResource<NeedsPage>>;
export function NeedsYouPage(
  props: Props & { counts?: NeedsCountsResource; invalidation?: string },
) {
  return (
    <NeedsYouTabs
      {...props}
      renderPanel={(resource) => (
        <NeedsContent {...props} resource={resource} embedded />
      )}
    />
  );
}
/** The item panel is tested independently of tab selection and network loading. */
export function NeedsYouPanel(props: Props & { resource?: NeedsResource }) {
  return props.resource ? (
    <NeedsContent {...props} resource={props.resource} />
  ) : (
    <NeedsLoader {...props} />
  );
}
function NeedsLoader({ client, projectId, revision = 0 }: Props) {
  const load = useCallback(
    () => client.needsYou(projectId),
    [client, projectId],
  );
  const resource = useResource(load, revision);
  return (
    <NeedsContent client={client} projectId={projectId} resource={resource} />
  );
}
function NeedsContent({
  client,
  projectId,
  resource,
  embedded = false,
}: Props & { resource: NeedsResource; embedded?: boolean }) {
  const { data, pending, error, reload, interactive } = resource;
  const [elapsed, setElapsed] = useState(0);
  const [closedMessage, setClosedMessage] = useState("");
  const [closedActions, setClosedActions] = useState<readonly string[]>([]);
  const laterHeading = useRef<HTMLHeadingElement>(null);
  const closedProject = useRef(projectId);
  const nextCloseFocus = useRef<string | null | undefined>(undefined);
  const later = (data?.later ?? []).filter(
    (item) => !closedActions.includes(item.id),
  );
  useEffect(() => {
    if (closedProject.current === projectId) return;
    closedProject.current = projectId;
    setClosedMessage("");
    setClosedActions([]);
  }, [projectId]);
  useEffect(() => {
    if (!closedActions.length || nextCloseFocus.current === undefined) return;
    const target = [
      ...(laterHeading.current
        ?.closest("section")
        ?.querySelectorAll<HTMLButtonElement>("button[data-close-action]") ??
        []),
    ].find((button) => button.dataset.closeAction === nextCloseFocus.current);
    (target ?? laterHeading.current)?.focus({ preventScroll: true });
    nextCloseFocus.current = undefined;
  }, [closedActions]);
  const closed = (id: string) => {
    nextCloseFocus.current =
      later
        .slice(later.findIndex((item) => item.id === id) + 1)
        .find((item) => item.kind === "human_action")?.id ?? null;
    setClosedActions((ids) => [...ids, id]);
    setClosedMessage(`${id} 已关闭（不再需要），未记为完成。`);
    reload();
  };
  useEffect(() => {
    setElapsed(0);
    if (!data) return;
    const sampled = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - sampled), 60000);
    return () => clearInterval(timer);
  }, [data]);
  const props = { client, projectId, done: reload, elapsed };
  // C-212: host actions are for the host operator; they sit in their own
  // folded group and never count as waiting on the human.
  // C-742: 张良's actions are listed apart and never count as the owner's.
  const operator = (data?.human_actions ?? []).filter(
    (a) => a.executor === "operator",
  );
  const mine = (data?.human_actions ?? []).filter(
    (a) => a.triage !== "host" && a.executor !== "operator",
  );
  const host = (data?.human_actions ?? []).filter(
    (a) => a.triage === "host" && a.executor !== "operator",
  );
  const proposals = data?.story_proposals ?? [];
  const total = data
    ? data.decisions.length +
      proposals.length +
      mine.length +
      data.incidents.length +
      (data.attention?.length ?? 0)
    : 0;
  const blocking = (data?.decisions ?? []).filter(
    (q) => q.blocking && !q.followup_notice && !isMergeConfirmation(q),
  );
  const followups = (data?.decisions ?? []).filter((q) => q.followup_notice);
  const merges = (data?.decisions ?? []).filter(
    (q) => !q.followup_notice && isMergeConfirmation(q),
  );
  const other = (data?.decisions ?? []).filter(
    (q) => !q.blocking && !q.followup_notice && !isMergeConfirmation(q),
  );
  return (
    <section
      aria-label={embedded ? "当前标签内容" : "Needs You"}
      className={embedded ? "needs-tab-content" : "needs-page"}
    >
      {!embedded && (
        <PageTitle
          title="Needs You"
          count={total > 0 ? `${total} 件事等你处理` : undefined}
        />
      )}
      <Feedback
        pending={pending}
        interactive={interactive}
        error={error}
        retry={reload}
      />
      {embedded && pending && !data && <Skeleton />}
      {data && (
        <>
          {data.auto_merge_pause?.paused && (
            <aside
              className="auto-merge-pause-banner"
              role="status"
              aria-label="自动合并暂停"
            >
              <strong>
                自动合并已暂停（{data.auto_merge_pause.waiting_count} 张等待）
              </strong>
              <p>
                人亲自确认的合并、检查和检查失败退回继续按原流程处理。恢复后系统会继续处理符合条件的合并。
              </p>
              <a href={routeHash({ kind: "settings", projectId })}>
                前往设置管理暂停
              </a>
            </aside>
          )}
          {!!data.waiting_merge_checks_count && (
            <NeedsNotice className="hint" role="status">
              <p>
                还有 {data.waiting_merge_checks_count}{" "}
                条合并确认的检查在排队或运行中，检查结束后会出现在这里；也可以先到卡片详情处理：
              </p>
              {!!data.waiting_merge_check_items?.length && (
                <ul aria-label="等检查的合并确认">
                  {data.waiting_merge_check_items.map((item) => (
                    <li key={item.decision_id}>
                      {item.card_id ? (
                        <a
                          href={routeHash({
                            kind: "card",
                            projectId,
                            cardId: item.card_id,
                            anchor: `decision-${item.decision_id}`,
                          })}
                        >
                          {item.card_id} · {item.decision_id}
                        </a>
                      ) : (
                        <span>{item.decision_id}</span>
                      )}
                      {item.check_status && (
                        <span>（{statusLabel(item.check_status)}）</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </NeedsNotice>
          )}
          {data.provider_incidents?.map(({ profile, paused }) => (
            <NeedsNotice key={profile} role="status">
              模型服务不可用：{profile}
              {paused ? "（已暂停派发）" : "（等待重试）"}
            </NeedsNotice>
          ))}
          {total === 0 &&
            !data.pm_held_merges?.length &&
            !later.length &&
            !closedMessage &&
            !data.notices?.length &&
            !host.length &&
            !data.system_rule_attention?.length && (
              <EmptyState>没有需要你处理的事</EmptyState>
            )}
          {!!data.incidents.length && (
            <NeedsList
              label="运行异常"
              title={`运行异常（${data.incidents.length}）`}
            >
              {data.incidents.map((incident) => (
                <Incident
                  key={incident.id}
                  incident={incident}
                  handling={data.incident_handling}
                  projectId={projectId}
                  elapsed={elapsed}
                />
              ))}
            </NeedsList>
          )}
          {!!data.system_rule_attention?.length && (
            <NeedsList
              label="指派与催办待处理"
              title={`指派与催办待处理（${data.system_rule_attention.length}）`}
            >
              {data.system_rule_attention.map((finding) => (
                <NeedsRow
                  key={finding.event_id}
                  label={`指派与催办 ${finding.card_id}`}
                  urgent
                  ids={<RowCard projectId={projectId} id={finding.card_id} />}
                  title={finding.detail}
                  summary="当前没有后台项目经理接手，请安排处理。"
                  time={waitLabel(finding.waited_ms, elapsed)}
                />
              ))}
            </NeedsList>
          )}
          {!!data.attention?.length && (
            <NeedsList
              label="审核恢复异常"
              title={`审核恢复异常（${data.attention.length}）`}
            >
              {data.attention.map((finding) => (
                <NeedsRow
                  key={`${finding.event_id ?? finding.decision_id}/${finding.work_item_id}`}
                  label={`审核恢复异常 ${finding.work_item_id}`}
                  urgent
                  ids={
                    <>
                      <RowCard projectId={projectId} id={finding.card_id} />
                      <IdTag id={finding.work_item_id} label="审核工作项" />
                    </>
                  }
                  title={finding.detail}
                  time={waitLabel(finding.waited_ms, elapsed)}
                />
              ))}
            </NeedsList>
          )}
          {!!blocking.length && (
            <NeedsList
              label="阻塞拍板"
              title={`阻塞拍板（${blocking.length}）`}
            >
              {blocking.map((q) => (
                <Decision key={q.id} q={q} {...props} />
              ))}
            </NeedsList>
          )}
          {!!proposals.length && (
            <NeedsList
              label="确认拆解"
              title={`确认拆解（${proposals.length}）`}
            >
              {proposals.map((item) => (
                <StoryProposalRow
                  key={`${item.card_id}@${item.version}`}
                  item={item}
                  {...props}
                />
              ))}
            </NeedsList>
          )}
          {!!merges.length && (
            <NeedsList label="合并确认" title={`合并确认（${merges.length}）`}>
              {merges.map((q) => (
                <MergeConfirmation key={q.id} q={q} {...props} />
              ))}
            </NeedsList>
          )}
          {!!data.pm_held_merges?.length && (
            <NeedsList
              label="PM 代确认中的合并"
              title={`PM 代确认中的合并（${data.pm_held_merges.length}）`}
            >
              {data.pm_held_merges.map((q) => (
                <MergeConfirmation
                  key={q.id}
                  q={q}
                  {...props}
                  confirmPmTakeover
                />
              ))}
            </NeedsList>
          )}
          {!!other.length && (
            <NeedsList label="其他拍板" title={`其他拍板（${other.length}）`}>
              {other.map((q) => (
                <Decision key={q.id} q={q} {...props} />
              ))}
            </NeedsList>
          )}
          {!!followups.length && (
            <NeedsList
              label="拍板落实"
              title={`拍板落实（${followups.length}）`}
            >
              {followups.map((q) => (
                <Decision key={q.id} q={q} {...props} />
              ))}
            </NeedsList>
          )}
          {!!mine.length && (
            <NeedsList label="待你执行" title={`待你执行（${mine.length}）`}>
              {mine.map((item) => (
                <HumanAction key={item.id} item={item} {...props} />
              ))}
            </NeedsList>
          )}
          {!!operator.length && (
            <NeedsList
              label="交给张良"
              title={`交给张良（${operator.length}）`}
            >
              {operator.map((item) => (
                <HumanAction key={item.id} item={item} {...props} />
              ))}
            </NeedsList>
          )}
          {!!host.length && (
            <NeedsList
              label="待主机操作"
              title={`待主机操作（${host.length}）`}
            >
              {host.map((item) => (
                <HumanAction key={item.id} item={item} {...props} />
              ))}
            </NeedsList>
          )}
          {(!!later.length || !!closedMessage) && (
            <NeedsList
              label="稍后"
              title={`稍后（${later.length}）`}
              headingRef={laterHeading}
            >
              {closedMessage && (
                <NeedsListFooter>
                  <p role="status">{closedMessage}</p>
                </NeedsListFooter>
              )}
              {!later.length && (
                <NeedsListFooter>
                  <EmptyState>没有需要你处理的事</EmptyState>
                </NeedsListFooter>
              )}
              {later.map((item) => (
                <NeedsRow
                  key={item.id}
                  label={`稍后 ${item.id}`}
                  muted
                  ids={
                    <>
                      <RowCard projectId={projectId} id={item.card_id} />
                      <IdTag
                        id={item.id}
                        label={item.kind === "decision" ? "拍板" : "操作"}
                        href={
                          item.card_id
                            ? routeHash({
                                kind: "card",
                                projectId,
                                cardId: item.card_id,
                                anchor: `${item.kind === "decision" ? "decision" : "human-action"}-${item.id}`,
                              })
                            : undefined
                        }
                      />
                    </>
                  }
                  title={
                    <>
                      {item.triage === "host" ? "主机操作：" : ""}
                      {item.title}
                    </>
                  }
                  status={
                    <StatusTag status="snoozed" label={item.waiting_for} />
                  }
                  action={
                    item.kind === "human_action" && (
                      <CloseLaterAction
                        item={item}
                        client={client}
                        projectId={projectId}
                        closed={closed}
                        opened={() => setClosedMessage("")}
                      />
                    )
                  }
                />
              ))}
            </NeedsList>
          )}
          {!!data.notices?.length && (
            <Notices
              key={projectId}
              notices={data.notices}
              nextCursor={data.notices_next_cursor ?? null}
              {...props}
            />
          )}
        </>
      )}
    </section>
  );
}

function mergeNotices(...pages: readonly (readonly NoticeView[])[]) {
  return [...new Map(pages.flat().map((n) => [n.id, n])).values()].sort(
    (a, b) =>
      Number(a.read) - Number(b.read) ||
      Date.parse(b.at) - Date.parse(a.at) ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
}

/** §7.4 知会: delegated merges and decisions; informational, never blocking. */
function Notices({
  notices,
  nextCursor,
  client,
  projectId,
  done,
}: {
  notices: readonly NoticeView[];
  nextCursor: string | null;
  client: CardiganClient;
  projectId: string;
  done: () => void;
}) {
  const unread = notices.filter((n) => !n.read);
  const [history, setHistory] = useState<{
    items: readonly NoticeView[];
    cursor: string | null;
  }>({ items: notices, cursor: nextCursor });
  // The first page always contains every unread notice. Keep expanded history
  // across refreshes, updating read status even when an item leaves that page.
  // Its pagination boundary is retained from the first render too: marking
  // unread items read can move the refreshed first page back over visible rows.
  const unreadIds = new Set(unread.map((n) => n.id));
  const visible = mergeNotices(
    history.items.map((n) => ({ ...n, read: !unreadIds.has(n.id) })),
    notices,
  );
  useEffect(() => {
    setHistory((old) => ({ ...old, items: mergeNotices(old.items, notices) }));
  }, [notices]);
  const cursor = history.cursor;
  const loading = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState("");
  const more = async () => {
    if (loading.current || !cursor) return;
    loading.current = true;
    setLoadingMore(true);
    setLoadError("");
    try {
      const page = await client.notices(projectId, cursor);
      setHistory((old) => ({
        items: mergeNotices(old.items, page.notices),
        cursor: page.next_cursor,
      }));
    } catch (cause) {
      setLoadError(describeError(cause));
    } finally {
      loading.current = false;
      setLoadingMore(false);
    }
  };
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const mark = async (ids: readonly string[]) => {
    if (busy || !ids.length) return;
    setBusy(true);
    setError("");
    try {
      await client.markNoticesRead(projectId, ids);
      done();
    } catch (cause) {
      setError(describeWriteError(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <NeedsList
        label="知会"
        title={`知会（未读 ${unread.length}）`}
        className="needs-notices"
        actions={
          unread.length > 1 && (
            <Button
              disabled={busy}
              onClick={() => mark(unread.map((n) => n.id))}
            >
              全部标为已读
            </Button>
          )
        }
      >
        {visible.map((n) => (
          <NeedsRow
            key={n.id}
            label={`知会 ${n.decision_id ?? n.id}`}
            muted={n.read}
            className={n.read ? "read" : undefined}
            ids={
              <>
                <RowCard projectId={projectId} id={n.card_id} />
                {n.decision_id && <IdTag id={n.decision_id} label="拍板" />}
              </>
            }
            title={n.question || noticeLine(n.body) || noticeMethod(n)}
            summary={n.question ? noticeLine(n.body) : undefined}
            time={<Time value={n.at} />}
            status={
              <>
                <StatusTag
                  status={
                    n.kind === "external_message"
                      ? "failed"
                      : n.read
                        ? "done"
                        : "active"
                  }
                  label={noticeMethod(n)}
                />
                <span className="hint">{n.read ? "已读" : "未读"}</span>
              </>
            }
            action={
              !n.read && (
                <Button
                  variant="primary"
                  disabled={busy}
                  aria-label={`标为已读 ${n.decision_id ?? n.id}`}
                  onClick={() => mark([n.id])}
                >
                  标为已读
                </Button>
              )
            }
          >
            <IdentityRow className="needs-meta">
              <EmployeeIdentity {...n} showTitle={false} />
            </IdentityRow>
            <Markdown body={n.body} />
            {n.decision_id && n.kind !== "external_message" && (
              <footer>
                <a
                  href={routeHash({
                    kind: "decision-history",
                    projectId,
                    ...(n.card_id ? { filters: { card_id: n.card_id } } : {}),
                  })}
                >
                  查看拍板记录
                </a>
              </footer>
            )}
          </NeedsRow>
        ))}
        {cursor && (
          <NeedsListFooter>
            <Button disabled={loadingMore} onClick={more}>
              显示更多
            </Button>
          </NeedsListFooter>
        )}
      </NeedsList>
      <RequestFeedback
        interactive
        pending={busy}
        pendingMessage="正在标记已读…"
        error={error}
      />
      <RequestFeedback
        interactive
        pending={loadingMore}
        pendingMessage="正在加载更多知会…"
        error={loadError}
        retry={more}
      />
    </>
  );
}
/** C-459: first line of a notice body as plain text, for the folded row. */
function noticeLine(body: string) {
  const line = (body.split("\n").find((l) => l.trim()) ?? "")
    .replace(/^\s*(?:#{1,6}|[-*+>]|\d+\.)\s+/u, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/[*_`~]/gu, "")
    .trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
function noticeMethod(n: NoticeView) {
  return n.kind === "external_message"
    ? "外部提醒未送达"
    : n.kind === "human_action"
      ? n.resolved_by === "system"
        ? "系统已核销"
        : "后台已完成"
      : n.option === "stalled"
        ? "PM 合并确认停留"
        : n.kind === "merge"
          ? n.source === "auto_merge"
            ? "自动合并（auto_merge）"
            : n.source === "timed_merge"
              ? "超时自动合并"
              : n.source === "system_merge"
                ? "系统自动合并"
                : n.resolved_by === "system"
                  ? "系统"
                  : n.option === "request_changes"
                    ? "PM 退回修改"
                    : n.option === "recheck"
                      ? "PM 重新检查"
                      : "PM 代确认合并"
          : n.resolved_by === "system"
            ? "系统"
            : "PM 代拍";
}
