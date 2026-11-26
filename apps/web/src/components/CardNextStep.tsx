import { storyProposalConfirmable } from "@cardigan/domain";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  CardDetail,
  CardiganClient,
  DecisionView,
  NeedsDecision,
  WaitingOnItem,
} from "../api.js";
import {
  cardChecking,
  MERGE_CHECK_LABEL,
  PRECHECK_LABEL,
} from "../card-checking.js";
import { routeHash } from "../route.js";
import { useCardDecision } from "./CardDecision.js";
import { CardFormOutlet } from "./CardFormOutlet.js";
import { useCardResume } from "./CardHold.js";
import { NextOwners } from "./EmployeeIdentity.js";
import { IdBadge, IdTag } from "./IdTag.js";
import {
  CardActionDock,
  CardDetailInlineOwner,
  DetailNextStep,
  DetailNextStepLine,
} from "./layout/CardDetailLayout.js";
import { MergeStatusFacts } from "./MergeStatusLine.js";
import { PlainSummaryRisk } from "./PlainSummary.js";
import { Button } from "./ui/button.js";

/** Where a panel action leads when the action itself still lives elsewhere. */
export type NextStepTarget = "merge" | "proposal" | "questions" | "comment";

/** C-695: what the card waits for, most urgent first (C-687 §3.2). */
export type NextStepState =
  | { readonly kind: "closed" }
  | { readonly kind: "hold" }
  | {
      readonly kind: "merge";
      readonly q: NeedsDecision;
      readonly failed: boolean;
    }
  | { readonly kind: "merge-pm"; readonly q: NeedsDecision }
  | {
      readonly kind: "decision";
      readonly ref: string;
      readonly q: DecisionView | undefined;
    }
  | { readonly kind: "human-action"; readonly item: WaitingOnItem }
  | { readonly kind: "questions"; readonly open: number }
  | { readonly kind: "proposal" }
  | { readonly kind: "mark-done" }
  | { readonly kind: "children" }
  | { readonly kind: "blocked"; readonly items: readonly WaitingOnItem[] }
  | { readonly kind: "dependency"; readonly ids: readonly string[] }
  | { readonly kind: "others"; readonly step: string }
  | { readonly kind: "idle" };

const otherStep = {
  decision: "处理拍板",
  human_action: "处理人工事项",
  review: "完成审核",
  blocked: "解除阻塞",
} as const;

const failedCheck = (q: NeedsDecision) => {
  const merge = q.merge_confirmation;
  return (
    !!merge?.merge_gate_enabled &&
    !merge.merge_noop &&
    ["failed", "timed_out"].includes(merge.merge_check?.status ?? "")
  );
};

/**
 * Everything on this card that waits on you, in the order the panel picks
 * from: merge confirmation, decision, human action, questions, the split
 * proposal, marking done. The panel shows the first; the rest are counted.
 */
export function cardNextSteps(detail: CardDetail): {
  readonly current: NextStepState;
  readonly more: number;
  /** Marking done also waits on you, behind a more urgent item. */
  readonly markDoneLater?: boolean;
} {
  const { card } = detail;
  if (card.status === "done" || card.status === "cancelled")
    return { current: { kind: "closed" }, more: 0 };
  if (card.hold) return { current: { kind: "hold" }, more: 0 };
  const confirmations = detail.merge_confirmations ?? [];
  const { waiting, precheckWait } = cardChecking(card);
  const humanOwner = card.next_owners.some((owner) => owner.kind === "human");
  const generalDone =
    detail.template?.completion.mode === "human_mark_done" && !card.story;
  const mine: NextStepState[] = [];
  for (const q of confirmations) {
    if (q.decider === "human" && (q.status !== "resolved" || failedCheck(q)))
      mine.push({ kind: "merge", q, failed: failedCheck(q) });
  }
  for (const item of waiting) {
    if (
      item.kind !== "decision" ||
      confirmations.some((q) => q.id === item.ref)
    )
      continue;
    const q = detail.decisions.find((d) => d.id === item.ref);
    if (q ? q.decider === "human" : humanOwner)
      mine.push({ kind: "decision", ref: item.ref, q });
  }
  // C-698: a non-blocking decision is not in waiting_on but still waits on
  // you; it used to be answered in the overview's “待你拍板” section.
  for (const q of detail.decisions)
    if (
      q.decider === "human" &&
      q.trigger !== "merge_confirmation" &&
      ["open", "provisional", "snoozed"].includes(q.status) &&
      !mine.some((step) => step.kind === "decision" && step.ref === q.id) &&
      !confirmations.some((merge) => merge.id === q.id)
    )
      mine.push({ kind: "decision", ref: q.id, q });
  if (!generalDone)
    for (const item of waiting)
      if (item.kind === "human_action")
        mine.push({ kind: "human-action", item });
  const open = (card.story?.question_groups ?? []).reduce(
    (n, group) => n + group.questions.filter((q) => !q.resolution).length,
    0,
  );
  if (card.story && open) mine.push({ kind: "questions", open });
  if (card.story && storyProposalConfirmable(card))
    mine.push({ kind: "proposal" });
  const progress = card.story_progress;
  const childrenOpen = !!progress && progress.finished < progress.total;
  if (detail.template?.completion.mode === "human_mark_done")
    if (!card.story || !childrenOpen) mine.push({ kind: "mark-done" });
  const [first, ...rest] = mine;
  if (first)
    return {
      current: first,
      more: rest.length,
      markDoneLater: rest.some((step) => step.kind === "mark-done"),
    };
  const pm = confirmations.find(
    (q) => q.decider === "role:pm" && q.status !== "resolved",
  );
  if (pm) return { current: { kind: "merge-pm", q: pm }, more: 0 };
  const blocked = waiting.filter(
    (item) => item.kind === "blocked" && !precheckWait(item),
  );
  if (blocked.length)
    return { current: { kind: "blocked", items: blocked }, more: 0 };
  if (card.story && childrenOpen)
    return { current: { kind: "children" }, more: 0 };
  const prerequisites = card.dependency?.waiting_on ?? [];
  if (prerequisites.length && !card.early_start)
    return { current: { kind: "dependency", ids: prerequisites }, more: 0 };
  if (!card.next_owners.length) return { current: { kind: "idle" }, more: 0 };
  // The wording the status line used before C-695 (C-205, C-567).
  const steps = [
    ...new Set(
      waiting
        .filter((item) => !precheckWait(item))
        .map((item) =>
          item.review_phase
            ? item.review_phase
            : item.kind === "review" &&
                (detail.overview?.waiting_delivery.includes(item.ref) ||
                  detail.work_items.some(
                    (w) =>
                      w.id === item.ref &&
                      w.verification_activity?.status === "waiting_delivery",
                  ))
              ? "提交新交付"
              : otherStep[item.kind],
        ),
    ),
  ];
  const step = steps.length
    ? steps.join("、")
    : card.status === "review"
      ? "完成审核"
      : "处理工作项";
  return { current: { kind: "others", step }, more: 0 };
}

export function CardNextStep({
  detail,
  client,
  projectId,
  onSaved,
  onReveal,
  markDone,
  completionId,
  busy = false,
  inDrawer = false,
  dock,
}: {
  readonly detail: CardDetail;
  readonly client: CardiganClient;
  readonly projectId: string;
  readonly onSaved: () => void;
  readonly onReveal: (target: NextStepTarget) => void;
  /** The existing “标记完成” action; emphasised when it is the main one. */
  readonly markDone: (emphasis: boolean) => ReactNode;
  readonly completionId?: string | undefined;
  /** Another card form (edit, mark done) is open: panel writes wait. */
  readonly busy?: boolean;
  /** The drawer has the card in its own title: the dock names the step. */
  readonly inDrawer?: boolean;
  /** C-701: where the main-action dock renders (CardActionDockSlot). */
  readonly dock?: HTMLElement | null;
}) {
  const { card } = detail;
  const { current, more, markDoneLater } = cardNextSteps(detail);
  const panel = useRef<HTMLElement>(null);
  const docked = usePanelScrolledAway(panel);
  const resume = useCardResume({ card, client, projectId, onSaved });
  const decision = useCardDecision({
    q: current.kind === "decision" ? current.q : undefined,
    client,
    projectId,
    onSaved,
    busy,
  });
  const needsYou = routeHash({ kind: "needs-you", projectId });
  const checks = cardChecking(card);
  const precheckLog = card.prechecks?.find(
    (check) =>
      card.checking?.precheck?.attempt_ids.includes(check.attempt_id) &&
      check.log_ref === `${check.attempt_id}.log` &&
      /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(check.attempt_id),
  );
  const comment = (
    <Button size="regular" onClick={() => onReveal("comment")}>
      写评论
    </Button>
  );
  const reveal = (target: NextStepTarget, label: string) => (
    <Button size="regular" variant="emphasis" onClick={() => onReveal(target)}>
      {label}
    </Button>
  );
  const openNeedsYou = (label: string) => (
    <Button asChild size="regular" variant="emphasis">
      <a href={needsYou}>{label}</a>
    </Button>
  );
  const owners = (
    <CardDetailInlineOwner>
      <NextOwners owners={card.next_owners} avatarSize={24} />
    </CardDetailInlineOwner>
  );
  const humanActions = card.waiting_on.filter(
    (item) => item.kind === "human_action",
  );
  const actionTitle = (id: string) =>
    detail.human_actions.find((action) => action.id === id)?.instructions;
  const humanActionLine = humanActions.length > 0 && (
    <DetailNextStepLine>
      等你执行
      {humanActions.map((item) => (
        <IdTag
          key={item.ref}
          id={item.ref}
          label={actionTitle(item.ref)}
          href={needsYou}
        />
      ))}
    </DetailNextStepLine>
  );
  const checkLine = (checks.precheck || checks.mergeCheck) && (
    <DetailNextStepLine>
      {checks.precheck &&
        (precheckLog ? (
          <a
            href={`/api/projects/${encodeURIComponent(projectId)}/prechecks/${encodeURIComponent(precheckLog.attempt_id)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {PRECHECK_LABEL}
          </a>
        ) : (
          <span>{PRECHECK_LABEL}</span>
        ))}
      {checks.mergeCheck && <span>{MERGE_CHECK_LABEL}</span>}
    </DetailNextStepLine>
  );
  const moreLink = more > 0 && <a href={needsYou}>还有 {more} 件</a>;
  let title: ReactNode;
  let mine = true;
  let lines: ReactNode = null;
  let actions: ReactNode = null;
  // The emphasis action, which the dock repeats once the panel scrolls away.
  let primary:
    | { readonly label: string; readonly disabled?: boolean }
    | undefined;
  switch (current.kind) {
    case "closed":
      mine = false;
      title =
        card.status === "cancelled"
          ? "已取消"
          : card.resolution === "superseded"
            ? "已被取代"
            : "已完成";
      lines = completionId && (
        <DetailNextStepLine>
          <IdTag
            id={completionId}
            label="完成申请"
            href={routeHash({
              kind: "card",
              projectId,
              cardId: card.id,
              anchor: `delivery-${completionId}`,
            })}
          />
        </DetailNextStepLine>
      );
      break;
    case "hold":
      title = `已暂停：${card.hold?.reason ?? ""}`;
      primary = { label: "恢复卡片", disabled: resume.pending || busy };
      lines = (
        <DetailNextStepLine>
          恢复条件：{card.hold?.resume_condition}
        </DetailNextStepLine>
      );
      actions = (
        <>
          <Button
            size="regular"
            variant="emphasis"
            disabled={resume.pending || busy}
            onClick={() => void resume.resume()}
          >
            恢复卡片
          </Button>
          {comment}
          {resume.feedback}
        </>
      );
      break;
    case "merge": {
      const { q } = current;
      title = (
        <>
          {current.failed ? "合并检查未通过" : "等你确认合并"}
          <IdBadge id={q.id} />
        </>
      );
      lines = (
        <>
          <DetailNextStepLine>
            <MergeStatusFacts q={q} />
          </DetailNextStepLine>
          <DetailNextStepLine>
            <dl>
              <PlainSummaryRisk
                risk={q.plain_summary?.risk ?? "风险尚未说明"}
              />
            </dl>
          </DetailNextStepLine>
        </>
      );
      primary = { label: "处理合并确认" };
      actions = reveal("merge", primary.label);
      break;
    }
    case "merge-pm":
      mine = false;
      title = (
        <>
          等 PM 确认合并
          <IdBadge id={current.q.id} />
        </>
      );
      lines = (
        <DetailNextStepLine>
          <MergeStatusFacts q={current.q} />
        </DetailNextStepLine>
      );
      actions = (
        <Button size="regular" onClick={() => onReveal("merge")}>
          查看合并详情
        </Button>
      );
      break;
    case "decision": {
      const { q } = current;
      title = (
        <>
          等你拍板
          <IdBadge id={current.ref} />
        </>
      );
      // C-698: answered right here; special decisions keep Needs You.
      if (decision) {
        lines = decision.body;
        primary = { label: "确认选择", disabled: decision.disabled };
        actions = decision.action;
      } else {
        lines = q && <DetailNextStepLine>{q.question}</DetailNextStepLine>;
        primary = { label: "处理拍板" };
        actions = openNeedsYou(primary.label);
      }
      break;
    }
    case "human-action":
      title = (
        <>
          等你执行
          <IdBadge id={current.item.ref} />
        </>
      );
      lines = actionTitle(current.item.ref) && (
        <DetailNextStepLine>{actionTitle(current.item.ref)}</DetailNextStepLine>
      );
      primary = { label: "处理人工事项" };
      actions = (
        <>
          {openNeedsYou(primary.label)}
          {comment}
        </>
      );
      break;
    case "questions":
      title = <>等你回答 {current.open} 个问题</>;
      lines = card.story_progress && (
        <DetailNextStepLine>
          子卡已结束 {card.story_progress.finished}/{card.story_progress.total}
        </DetailNextStepLine>
      );
      primary = { label: "回答问题" };
      actions = (
        <>
          {reveal("questions", primary.label)}
          {markDone(false)}
        </>
      );
      break;
    case "proposal":
      title = <>等你确认拆解方案</>;
      primary = { label: "查看拆解方案" };
      actions = reveal("proposal", primary.label);
      break;
    case "mark-done":
      title = "等你标记完成";
      // A refused mark is a plain button with its reason: no main action.
      if (detail.mark_done?.allowed === true)
        primary = { label: "标记完成", disabled: busy };
      lines = humanActionLine;
      actions = (
        <>
          {markDone(true)}
          {comment}
        </>
      );
      break;
    case "children":
      mine = false;
      title = "等子卡结束";
      lines = card.story_progress && (
        <DetailNextStepLine>
          子卡已结束 {card.story_progress.finished}/{card.story_progress.total}
        </DetailNextStepLine>
      );
      actions = (
        <>
          {markDone(false)}
          {comment}
        </>
      );
      break;
    case "blocked":
      mine = false;
      title = "被阻塞";
      lines = (
        <DetailNextStepLine>
          {current.items.map((item) => (
            <span key={item.ref}>{item.label}</span>
          ))}
        </DetailNextStepLine>
      );
      actions = comment;
      break;
    case "dependency":
      mine = false;
      title = (
        <>
          等
          {current.ids.map((id) => (
            <IdTag
              key={id}
              id={id}
              label=""
              href={routeHash({ kind: "card", projectId, cardId: id })}
            />
          ))}
          完成
        </>
      );
      actions = comment;
      break;
    case "others":
      mine = false;
      title = (
        <>
          等{owners}
          {current.step}
        </>
      );
      lines = <ProgressLine detail={detail} />;
      actions = comment;
      break;
    case "idle":
      mine = false;
      title = "等待开始";
      actions = comment;
      break;
  }
  // Still reachable while a more urgent item has the panel; never emphasised.
  if (markDoneLater && current.kind !== "questions")
    actions = (
      <>
        {actions}
        {markDone(false)}
      </>
    );
  return (
    <>
      <DetailNextStep
        ref={panel}
        title={
          <>
            {title}
            {moreLink}
          </>
        }
        mine={mine}
        actions={actions}
      >
        {lines}
        {checkLine}
      </DetailNextStep>
      {docked && primary && dock && (
        <CardFormOutlet container={dock}>
          <CardActionDock
            title={
              inDrawer ? (
                title
              ) : (
                <>
                  <IdBadge id={card.id} /> {card.title}
                </>
              )
            }
          >
            <Button
              size="regular"
              variant="emphasis"
              disabled={primary.disabled}
              // The panel's first action is the main one; the dock runs it,
              // so its forms, focus and feedback stay where they were. The
              // panel comes back into view first for its feedback (恢复卡片);
              // actions that lead elsewhere scroll there after.
              onClick={() => {
                const element = panel.current;
                element?.scrollIntoView?.({ block: "nearest" });
                element
                  ?.querySelector<HTMLElement>(
                    "[data-next-actions] [data-ui='button']",
                  )
                  ?.click();
              }}
            >
              {primary.label}
            </Button>
          </CardActionDock>
        </CardFormOutlet>
      )}
    </>
  );
}

/**
 * C-701: true once the panel has scrolled out above its scroller (the drawer
 * body or the viewport); false while it is in view or below.
 */
function usePanelScrolledAway(panel: RefObject<HTMLElement | null>) {
  const [away, setAway] = useState(false);
  useEffect(() => {
    const element = panel.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        const top = entry.rootBounds?.top ?? 0;
        setAway(
          !entry.isIntersecting && entry.boundingClientRect.bottom <= top,
        );
      },
      { root: element.closest<HTMLElement>(".drawer-body") },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [panel]);
  return away;
}

/** Work items in progress and how many are done (as in the overview). */
function ProgressLine({ detail }: { readonly detail: CardDetail }) {
  const { overview, work_items } = detail;
  const active = work_items.filter((w) => w.status === "in_progress");
  const total = overview?.work_count ?? work_items.length;
  const completed =
    overview?.completed_work_count ??
    work_items.filter((w) => ["accepted", "passed"].includes(w.status)).length;
  if (!active.length && !total) return null;
  return (
    <DetailNextStepLine>
      {active.map((w) => (
        <IdTag key={w.id} id={w.id} label={w.title} />
      ))}
      {total > 0 && (
        <span>
          工作项 {completed}/{total}
        </span>
      )}
    </DetailNextStepLine>
  );
}
