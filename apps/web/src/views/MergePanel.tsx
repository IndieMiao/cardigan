import { decisionOtherOption, reviewImpactLabel } from "@cardigan/domain";
import { type ReactNode, useRef, useState } from "react";
import type { CardiganClient, NeedsDecision } from "../api.js";
import type { DockAction, DockFor } from "../components/CardNextStep.js";
import { DecisionAffectedCards } from "../components/DecisionAffectedCards.js";
import { DecisionAttachments } from "../components/DecisionAttachments.js";
import {
  SuggestionProgressEntries,
  usePrefilledReason,
} from "../components/DecisionSuggestion.js";
import { StatusTag } from "../components/Foundation.js";
import {
  DetailNextStep,
  DetailNextStepFacts,
  DetailNextStepLine,
  DetailNextStepMore,
} from "../components/layout/CardDetailLayout.js";
import { Menu, type MenuItem } from "../components/Menu.js";
import { MergeStatusFacts } from "../components/MergeStatusLine.js";
import { PlainSummaryRisk } from "../components/PlainSummary.js";
import { PmMergeTakeover } from "../components/PmMergeTakeover.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { SourceMergeSuggestion } from "../components/SourceMergeSuggestion.js";
import { Tooltip } from "../components/Tooltip.js";
import { Button } from "../components/ui/button.js";
import { MoreButton } from "../components/ui/more-button.js";
import { Textarea } from "../components/ui/textarea.js";
import { decisionTitle } from "../decision-labels.js";
import { PLAIN_SUMMARY_COPY } from "../plain-summary-copy.js";
import { SUGGESTION_COPY } from "../suggestion-copy.js";
import { type MergeDialogMode, MergeDialogs } from "./MergeDialogs.js";
import { MergeEvidence } from "./MergeEvidence.js";
import { useAction } from "./useAction.js";

/**
 * C-697: a merge confirmation in card details is the “下一步” panel itself
 * (C-687 §3.2). Facts on the left: the plain summary, the status facts with
 * “合并详情”, what still blocks, the suggestion and must-fix items. On the
 * right one emphasis button (确认合并; 重新检查 after a failed check; 按建议
 * when there is a fresh suggestion), the other actions and a ⋯ menu.
 * 暂不合并, 退回修改, 其他 and 仍要合并 open dialogs; the evidence Needs You
 * folds under its controls opens below behind “合并详情”. Writes use the same
 * client calls and idempotency rules as Needs You.
 */
export function MergePanel({
  q,
  client,
  projectId,
  done,
  title,
  mine,
  dockFor,
}: {
  readonly q: NeedsDecision;
  readonly client: CardiganClient;
  readonly projectId: string;
  readonly done: () => void;
  readonly title: ReactNode;
  /** Waits on you: the panel's wait border and an emphasis button. */
  readonly mine: boolean;
  /** C-701: the bar that repeats the emphasis button once scrolled away. */
  readonly dockFor?: DockFor | undefined;
}) {
  const [quote, setQuote] = useState("");
  const [dialog, setDialog] = useState<{
    mode: MergeDialogMode;
    /** Suggested writes are for one suggestion version and its news. */
    suggestion?: string;
  }>();
  const opener = useRef<HTMLElement | null>(null);
  const menuOpensDialog = useRef(false);
  const more = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const [showDetails, setShowDetails] = useState(false);
  const detailsId = `merge-details-${q.id}`;
  // C-192: once confirmed, only a return is still possible (failed check).
  const suggestion =
    q.status === "resolved" && q.suggestion?.option !== "request_changes"
      ? undefined
      : q.suggestion;
  const fresh = suggestion && !suggestion.stale ? suggestion : undefined;
  const [reason, setReason] = usePrefilledReason(suggestion);
  const action = useAction(done);
  const merge = q.merge_confirmation;
  const check = merge?.merge_check;
  const confirmed = q.status === "resolved";
  const [acceptedTakeover, setAcceptedTakeover] = useState<string>();
  const takeoverKey = JSON.stringify([
    projectId,
    q.id,
    merge?.completion?.id,
    merge?.completion?.subject.value,
  ]);
  // As in Needs You, a PM's confirmation opens after an explicit takeover.
  const pmTakeover = q.decider === "role:pm" && !confirmed;
  const needsTakeover = pmTakeover && acceptedTakeover !== takeoverKey;
  const blockers = merge?.blockers ?? ["检查状态尚未读取，请刷新"];
  const mergeBlocked = blockers.length > 0;
  const cardId = q.card_id ?? q.related_cards[0]?.id ?? null;
  const failed =
    !!merge?.merge_gate_enabled &&
    !merge.merge_noop &&
    !!check &&
    ["failed", "timed_out"].includes(check.status);
  const suggestionKey = JSON.stringify([
    suggestion?.version,
    suggestion?.progress?.token,
  ]);
  // A dialog closes once what it would write no longer applies.
  const dialogMode =
    dialog &&
    !needsTakeover &&
    (dialog.mode === "return" || !confirmed) &&
    (dialog.suggestion === undefined ||
      (dialog.suggestion === suggestionKey && !!fresh))
      ? dialog.mode
      : undefined;
  const openDialog = (mode: MergeDialogMode, from: HTMLElement | null) => {
    opener.current = from;
    setDialog({
      mode,
      ...(mode.startsWith("suggested-") ? { suggestion: suggestionKey } : {}),
    });
  };
  const fromMenu = (mode: MergeDialogMode) => () => {
    menuOpensDialog.current = true;
    openDialog(mode, more.current);
  };
  const decide = (viaSuggestion = false) =>
    action.run(
      [
        projectId,
        q.id,
        "resolve",
        "merge",
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
              "merge",
              quote,
              key,
              suggestion?.progress?.token,
              suggestion?.version,
            )
          : client.recordDecision(projectId, q.id, "merge", quote, key),
    );
  const recheck =
    failed && cardId && check
      ? () =>
          void action.run(
            [
              projectId,
              cardId,
              "recheck",
              check.completion_id,
              check.attempt_id,
            ],
            (key) =>
              client.recheckMerge(projectId, cardId, check.completion_id, key),
          )
      : undefined;
  const follow = (button: HTMLElement) => {
    if (!fresh) return;
    if (fresh.option === "request_changes")
      openDialog("suggested-return", button);
    else if (mergeBlocked) return;
    else if (fresh.progress) openDialog("suggested-merge", button);
    else void decide(true);
  };
  const suggestionLabel =
    suggestion &&
    (SUGGESTION_COPY.mergeOptions[suggestion.option] ?? suggestion.option);
  // Emphasis only where the panel waits on you, or after you took it over.
  const main = mine || pmTakeover ? "emphasis" : "default";
  const menu: MenuItem[] = confirmed
    ? []
    : [
        ...(recheck
          ? [{ id: "hold", label: "暂不合并…", onSelect: fromMenu("hold") }]
          : []),
        ...(mergeBlocked
          ? [
              {
                id: "override",
                label: "仍要合并…",
                onSelect: fromMenu("override"),
              },
            ]
          : recheck
            ? // 重新检查 leads; confirming stays reachable.
              [
                {
                  id: "merge",
                  label: "确认合并",
                  onSelect: () => void decide(),
                },
              ]
            : []),
        {
          id: "other",
          label: `${decisionOtherOption.description}…`,
          onSelect: fromMenu("other"),
        },
      ];
  const takeover = pmTakeover && (
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
      controls={actionsRef}
      regular
    />
  );
  // The emphasis button the dock repeats; it is the first of the actions.
  // Before a takeover that is 接手处理, which opens the takeover dialog.
  const primary: DockAction | undefined = needsTakeover
    ? { label: "接手处理" }
    : main !== "emphasis"
      ? undefined
      : fresh
        ? {
            label: `按建议：${suggestionLabel}`,
            disabled: action.busy || (fresh.option === "merge" && mergeBlocked),
          }
        : recheck
          ? { label: "重新检查", disabled: action.busy }
          : confirmed
            ? undefined
            : {
                label:
                  check?.level === "card"
                    ? "确认合并（批次检查通过后生效）"
                    : "确认合并",
                disabled: action.busy || mergeBlocked,
              };
  const actions = needsTakeover ? (
    takeover
  ) : (
    <>
      {takeover}
      {fresh ? (
        <Button
          size="regular"
          variant={main}
          disabled={action.busy || (fresh.option === "merge" && mergeBlocked)}
          onClick={(event) => follow(event.currentTarget)}
        >
          按建议：{suggestionLabel}
        </Button>
      ) : (
        recheck && (
          <Button
            size="regular"
            variant={main}
            disabled={action.busy}
            onClick={recheck}
          >
            重新检查
          </Button>
        )
      )}
      {fresh && recheck && (
        <Button size="regular" disabled={action.busy} onClick={recheck}>
          重新检查
        </Button>
      )}
      {!confirmed && !recheck && (
        <Button
          size="regular"
          variant={fresh ? "default" : main}
          disabled={action.busy || mergeBlocked}
          onClick={() => void decide()}
        >
          {check?.level === "card"
            ? "确认合并（批次检查通过后生效）"
            : "确认合并"}
        </Button>
      )}
      {!confirmed && !recheck && (
        <Button
          size="regular"
          disabled={action.busy}
          onClick={(event) => openDialog("hold", event.currentTarget)}
        >
          暂不合并
        </Button>
      )}
      <Button
        size="regular"
        disabled={action.busy}
        onClick={(event) => openDialog("return", event.currentTarget)}
      >
        退回修改
      </Button>
      {menu.length > 0 && (
        <Menu
          label="更多合并操作"
          onCloseAutoFocus={(event) => {
            // The dialog being opened takes focus; it returns it to ⋯.
            if (menuOpensDialog.current) {
              event.preventDefault();
              menuOpensDialog.current = false;
            }
          }}
          trigger={
            <MoreButton
              ref={more}
              label="更多合并操作"
              size="regular"
              variant="default"
              disabled={action.busy}
            />
          }
          items={menu}
        />
      )}
    </>
  );
  const summary = q.plain_summary;
  return (
    <>
      <DetailNextStep
        ref={panel}
        title={title}
        mine={mine}
        actions={actions}
        actionsLabel="合并处理操作"
        actionsRef={actionsRef}
        more={
          <DetailNextStepMore id={detailsId} hidden={!showDetails}>
            {!confirmed && !needsTakeover && (
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
            <MergeEvidence q={q} projectId={projectId} cardId={cardId} />
            <DecisionAttachments attachments={q.attachments} />
          </DetailNextStepMore>
        }
      >
        {summary ? (
          <section aria-label={`${q.id} ${PLAIN_SUMMARY_COPY.region}`}>
            <DetailNextStepFacts>
              <div>
                <dt>{PLAIN_SUMMARY_COPY.changed}</dt>
                <dd>{summary.changed}</dd>
              </div>
              <div>
                <dt>{PLAIN_SUMMARY_COPY.impact}</dt>
                <dd>{summary.impact}</dd>
              </div>
              <PlainSummaryRisk risk={summary.risk} />
            </DetailNextStepFacts>
          </section>
        ) : (
          <DetailNextStepLine>
            尚未提供改动概述 / 风险尚未说明
          </DetailNextStepLine>
        )}
        {q.human_required_reason && (
          <DetailNextStepLine>
            须由你亲自决定：{q.human_required_reason}
          </DetailNextStepLine>
        )}
        {q.status === "snoozed" && q.snooze && (
          <DetailNextStepLine role="status" aria-label="已暂缓">
            暂缓原因：{q.snooze.reason}
          </DetailNextStepLine>
        )}
        <DetailNextStepLine>
          <MergeStatusFacts q={q} />
          <Button
            variant="link"
            aria-expanded={showDetails}
            aria-controls={detailsId}
            onClick={() => setShowDetails((open) => !open)}
          >
            合并详情
          </Button>
        </DetailNextStepLine>
        {!confirmed &&
          (mergeBlocked ? (
            <DetailNextStepLine role="status" aria-label="合并前置条件">
              等待中：
              {blockers.map((blocker) => (
                <span key={blocker}>{blocker}</span>
              ))}
            </DetailNextStepLine>
          ) : (
            // Announced, not shown twice: the facts above already say so.
            <div
              role="status"
              aria-label="合并前置条件"
              className="visually-hidden"
            >
              检查都已通过
            </div>
          ))}
        {suggestion && (
          <DetailNextStepLine
            role="note"
            aria-label={`${q.id} ${SUGGESTION_COPY.region}`}
          >
            <span>
              {SUGGESTION_COPY.line(
                suggestionLabel ?? "",
                suggestion.rationale,
              )}
            </span>
            {suggestion.stale && (
              <Tooltip content={SUGGESTION_COPY.staleHint}>
                <span>
                  <StatusTag
                    status="superseded"
                    label={SUGGESTION_COPY.stale}
                  />
                </span>
              </Tooltip>
            )}
            {fresh?.progress && (
              <details>
                <summary>
                  {SUGGESTION_COPY.progress(fresh.progress.count)}
                </summary>
                <SuggestionProgressEntries progress={fresh.progress} />
              </details>
            )}
          </DetailNextStepLine>
        )}
        <MergeFacts q={q} />
        <DecisionAffectedCards decision={q} projectId={projectId} />
        <SourceMergeSuggestion
          client={client}
          projectId={projectId}
          decision={q}
          done={done}
        />
      </DetailNextStep>
      {dockFor?.(panel, primary)}
      <MergeDialogs
        mode={dialogMode}
        q={q}
        client={client}
        projectId={projectId}
        quote={quote}
        reason={reason}
        onReason={setReason}
        suggestion={suggestion}
        blockers={blockers}
        done={done}
        close={() => setDialog(undefined)}
        restoreFocus={() => {
          const target = opener.current;
          (target?.isConnected ? target : more.current)?.focus();
        }}
      />
      <RequestFeedback
        interactive
        pending={action.busy}
        pendingMessage="提交中…"
        error={action.error}
        message={action.message}
      />
    </>
  );
}

/**
 * Facts that must stay visible however the evidence is folded (C-205):
 * must-fix items, gap preconditions, the failed check's summary and the
 * host's notes on the gate.
 */
function MergeFacts({ q }: { readonly q: NeedsDecision }) {
  const merge = q.merge_confirmation;
  const check = merge?.merge_check;
  return (
    <>
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
            <DetailNextStepLine
              tone="danger"
              key={`${review.id}/${issue.description}`}
            >
              必须修复：{issue.description}
              {issue.impact && ` · ${reviewImpactLabel[issue.impact]}`}
            </DetailNextStepLine>
          )),
      )}
      {merge?.known_gaps
        ?.filter((gap) => gap.precondition)
        .map((gap) => (
          <DetailNextStepLine key={`${gap.description}/${gap.precondition}`}>
            {gap.description} · 前置条件：{gap.precondition}
          </DetailNextStepLine>
        ))}
      {check?.summary &&
        ["failed", "timed_out", "interrupted", "executor_unreachable"].includes(
          check.status,
        ) && (
          <DetailNextStepLine tone="danger">{check.summary}</DetailNextStepLine>
        )}
      {merge?.merge_gate_invalid && (
        <DetailNextStepLine tone="danger">
          合并闸门配置无效，请查看 server 启动日志
        </DetailNextStepLine>
      )}
      {merge?.merge_noop && (
        <DetailNextStepLine>
          主机已验证交付均在基线中，无需合并检查；请确认是否完成此次合并。
        </DetailNextStepLine>
      )}
      {q.decider === "role:pm" &&
        !!merge?.decision_evidence_required?.length && (
          <DetailNextStepLine>
            你已批准相关范围或权限改动。PM
            确认合并前仍须逐项核对当前交付与拍板一致；超出批准的内容会交给你。
          </DetailNextStepLine>
        )}
    </>
  );
}
