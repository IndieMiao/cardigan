import { useCallback, useRef, useState } from "react";
import {
  ApiError,
  type CardDetail,
  type CardiganClient,
  describeWriteError,
} from "../api.js";
import { routeHash } from "../route.js";
import { useResource } from "../useResource.js";
import { LongContent, StatusTag, Time } from "./Foundation.js";
import { IdBadge } from "./IdTag.js";
import {
  DetailCardList,
  DetailCardRow,
  DetailQuestion,
  DetailQuestionList,
} from "./layout/CardDetailLayout.js";
import { ChecklistActions, ChecklistAlert } from "./layout/ChecklistLayout.js";
import { DependencyGraphFacts } from "./layout/DependencyGraphLayout.js";
import { Markdown, MarkdownBody } from "./Operations.js";
import { RequestFeedback } from "./RequestFeedback.js";
import { STORY_RESOLUTION_LABELS } from "./StoryDiscussion.js";
import { StoryProposalSection } from "./StoryProposal.js";
import { Button } from "./ui/button.js";
import { Skeleton } from "./ui/skeleton.js";

type StoryProgress = NonNullable<CardDetail["card"]["story_progress"]>;

/**
 * C-505: the frame of a story card's overview. C-503 adds the current
 * decomposition proposal (confirm, change request) and the human's completion
 * confirmation after the summary.
 */
export function StoryOverview({
  detail,
  client,
  projectId,
  cardId,
  revision,
  onLocate,
  onSaved,
}: {
  detail: CardDetail;
  client: CardiganClient;
  projectId: string;
  cardId: string;
  revision: number;
  onLocate: ((anchor: string) => void) | undefined;
  /** Reread the card after a confirmation, change request or completion. */
  onSaved: () => void;
}) {
  const card = detail.card;
  // C-699: the request, then where its children stand; attachments live in
  // their own tab and empty sections do not render.
  return (
    <>
      <section className="card-purpose" aria-label="原始需求">
        <h2>原始需求</h2>
        <LongContent>
          <Markdown body={card.goal} />
        </LongContent>
      </section>
      {card.acceptance_criteria.length > 0 && (
        <section
          className="card-purpose acceptance-criteria"
          aria-label="验收标准"
        >
          <h2>验收标准（{card.acceptance_criteria.length}）</h2>
          <LongContent>
            <ul>
              {card.acceptance_criteria.map((criterion) => (
                <li key={criterion}>
                  <MarkdownBody body={criterion} />
                </li>
              ))}
            </ul>
          </LongContent>
        </section>
      )}
      <StoryChildren
        story={card}
        progress={card.story_progress}
        projectId={projectId}
      />
      <StoryProposalSection
        detail={detail}
        client={client}
        projectId={projectId}
        cardId={cardId}
        onSaved={onSaved}
      />
      <StoryQuestions detail={detail} />
      <StorySummary
        detail={detail}
        client={client}
        projectId={projectId}
        cardId={cardId}
        revision={revision}
        onLocate={onLocate}
        onSaved={onSaved}
      />
    </>
  );
}

/**
 * C-771: the children as a list (design Q-1320 §4.2): id, title and status of
 * each, in the order the story records them.
 */
function StoryChildren({
  story,
  progress,
  projectId,
}: {
  story: CardDetail["card"];
  progress: StoryProgress | undefined;
  projectId: string;
}) {
  const children = [
    ...new Map(
      (progress?.children ?? [])
        .filter((child) => child.id !== story.id)
        .map((child) => [child.id, child]),
    ).values(),
  ];
  if (!children.length) return null;
  return (
    <section className="card-purpose" aria-label="子卡进度">
      <h2>子卡进度</h2>
      <DetailCardList aria-label="子卡">
        {children.map((child) => (
          <DetailCardRow
            key={child.id}
            id={
              <a
                href={routeHash({
                  kind: "card",
                  projectId,
                  cardId: child.id,
                })}
              >
                <IdBadge id={child.id} />
              </a>
            }
            status={<StatusTag status={child.status} />}
          >
            {child.title}
          </DetailCardRow>
        ))}
      </DetailCardList>
    </section>
  );
}

/**
 * C-771: every question of the story's checklists, numbered as when
 * answering; an open one shows its recommended default, an answered one how
 * it was settled. Answering stays in 下一步 and the timeline.
 */
function StoryQuestions({ detail }: { detail: CardDetail }) {
  const groups = (detail.card.story?.question_groups ?? []).filter(
    (group) => group.questions.length > 0,
  );
  if (!groups.length) return null;
  return (
    <section className="card-purpose" aria-label="问题清单">
      <h2>问题清单</h2>
      {groups.map((group) => (
        <DetailQuestionList
          key={group.id}
          aria-label={groups.length > 1 ? `问题清单 ${group.id}` : "问题"}
        >
          {group.questions.map((q, i) => (
            <DetailQuestion
              // biome-ignore lint/suspicious/noArrayIndexKey: A question is its number within the checklist.
              key={i}
              note={
                q.resolution
                  ? `${STORY_RESOLUTION_LABELS[q.resolution.source]}：${q.resolution.value}`
                  : `建议：${q.recommended}`
              }
            >
              {q.question}
            </DetailQuestion>
          ))}
        </DetailQuestionList>
      ))}
    </section>
  );
}

function StorySummary({
  detail,
  client,
  projectId,
  cardId,
  revision,
  onLocate,
  onSaved,
}: {
  detail: CardDetail;
  client: CardiganClient;
  projectId: string;
  cardId: string;
  revision: number;
  onLocate: ((anchor: string) => void) | undefined;
  onSaved: () => void;
}) {
  const id = detail.card.story?.summary_entry_id;
  const anchor = `entry-${id}`;
  const loaded = id
    ? detail.timeline.find((e) => e.id === id && !e.retracted)
    : undefined;
  // An older summary sits outside the loaded timeline window: read just that
  // entry by its anchor, apart from the page's own timeline and position.
  const load = useCallback(async () => {
    const read = await client.card(projectId, cardId, {
      at: anchor,
      limit: 1,
      ...(client.cardPanel ? { section: "overview" as const } : {}),
    });
    return read.timeline.find((e) => e.id === id && !e.retracted) ?? null;
  }, [client, projectId, cardId, anchor, id]);
  const read = useResource(load, revision, !!id && !loaded);
  const entry = loaded ?? read.data ?? undefined;
  if (!id) return null;
  return (
    <section className="card-purpose" aria-label="对照总结">
      <h2>对照总结</h2>
      <DependencyGraphFacts>
        {entry && (
          <>
            <span>{entry.author_display ?? "常驻 Office"}</span>
            <Time value={entry.created_at} />
          </>
        )}
        <span>
          <a
            href={routeHash({ kind: "card", projectId, cardId, anchor })}
            onClick={
              onLocate
                ? (event) => {
                    event.preventDefault();
                    onLocate(anchor);
                  }
                : undefined
            }
          >
            <IdBadge id={id} />
          </a>
        </span>
      </DependencyGraphFacts>
      {!loaded && read.error && (
        <RetryLine
          message={`读取总结失败：${read.error}`}
          retry={read.reload}
        />
      )}
      {entry ? (
        <Markdown body={entry.body} />
      ) : (
        !read.error && read.pending && <Skeleton />
      )}
      {/* Only a summary the person can read may be confirmed against. */}
      {entry && (
        <StoryCompletion
          // Each summary has its own confirmation state and retry key: a
          // refusal of an older summary never locks out the newer one.
          key={id}
          detail={detail}
          client={client}
          projectId={projectId}
          cardId={cardId}
          summaryId={id}
          onSaved={onSaved}
        />
      )}
    </section>
  );
}

/**
 * C-503: once every child has ended and the Office summarized, the human
 * confirms the story done through the existing mark-done command.
 */
function StoryCompletion({
  detail,
  client,
  projectId,
  cardId,
  summaryId,
  onSaved,
}: {
  detail: CardDetail;
  client: CardiganClient;
  projectId: string;
  cardId: string;
  summaryId: string;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; stale: boolean }>();
  const [message, setMessage] = useState("");
  const sending = useRef(false);
  const key = useRef(crypto.randomUUID());
  const progress = detail.card.story_progress;
  const ready =
    !["done", "cancelled"].includes(detail.card.status) &&
    !!progress?.total &&
    progress.finished === progress.total &&
    detail.mark_done?.allowed === true;
  if (!ready) return <RequestFeedback message={message} />;
  return (
    <>
      {error && (
        <ChecklistAlert>
          <span>{error.message}</span>
          {error.stale && (
            <Button
              variant="outline"
              onClick={() => {
                setError(undefined);
                onSaved();
              }}
            >
              刷新
            </Button>
          )}
        </ChecklistAlert>
      )}
      <ChecklistActions>
        <Button
          variant="primary"
          // Stays focusable while busy, so a refusal does not drop focus.
          aria-disabled={busy || error?.stale}
          onClick={async () => {
            if (sending.current || error?.stale) return;
            sending.current = true;
            setBusy(true);
            setError(undefined);
            try {
              await client.markCardDone(
                projectId,
                cardId,
                `已对照总结 ${summaryId} 确认需求完成`,
                [],
                key.current,
                summaryId,
              );
              setMessage("需求卡已确认完成");
              onSaved();
            } catch (cause) {
              const stale =
                cause instanceof ApiError && cause.code === "stale_target";
              setError({
                stale,
                message: stale
                  ? "对照总结已更新，请刷新后再确认"
                  : `确认完成失败：${describeWriteError(cause).replace(/^请求失败：/u, "")}`,
              });
            } finally {
              sending.current = false;
              setBusy(false);
            }
          }}
        >
          确认完成
        </Button>
      </ChecklistActions>
      <RequestFeedback message={message} />
    </>
  );
}

/** A failed read: what failed and a retry, beside whatever was shown before. */
function RetryLine({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <DependencyGraphFacts>
      <span role="alert">{message}</span>
      <Button variant="secondary" onClick={retry}>
        重试
      </Button>
    </DependencyGraphFacts>
  );
}
