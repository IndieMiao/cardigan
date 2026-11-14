import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  type CardDetail,
  type CardiganClient,
  type CardReadOptions,
  type PostedComment,
} from "../api.js";
import { AttachmentGrid } from "../components/AttachmentGrid.js";
import { CardActions } from "../components/CardActions.js";
import {
  CardRiskTags,
  CardSource,
  RecentConclusions,
} from "../components/CardIntro.js";
import { CardRecords } from "../components/CardRecords.js";
import { CardSectionNav } from "../components/CardSectionNav.js";
import { CardSidebar, CardWorkItems } from "../components/CardSidebar.js";
import { CardStatusLine } from "../components/CardStatusLine.js";
import { CardSuperseded } from "../components/CardSuperseded.js";
import { CardTemplate } from "../components/CardTemplate.js";
import {
  CommentBox,
  type CommentBoxHandle,
  type MentionOption,
} from "../components/CommentBox.js";
import {
  EmptyState,
  IdTag,
  LongContent,
  PageTitle,
  Time,
} from "../components/Foundation.js";
import { MergeBlockers } from "../components/MergeBlockers.js";
import { DecisionContext, PlainSummary } from "../components/PlainSummary.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { Timeline } from "../components/Timeline.js";
import { TimelineControls } from "../components/TimelineControls.js";
import { routeHash, useRouteFilters } from "../route.js";
import { SUGGESTION_COPY } from "../suggestion-copy.js";
import { useResource } from "../useResource.js";
import { MergeConfirmation, SuggestedDecision } from "./NeedsYouPage.js";

export interface CardDetailPageProps {
  readonly client: CardiganClient;
  readonly projectId: string;
  readonly cardId: string;
  readonly anchor?: string;
  /** Embedded in a drawer: do not auto-scroll to the latest timeline entry. */
  readonly inDrawer?: boolean;
  readonly revision?: number;
  /** Include the displayed decision impact in the shared project's live revision. */
  readonly cardRevision?: (
    id: string,
    affectedCards: readonly string[],
  ) => number;
}
export function CardDetailPage(props: CardDetailPageProps) {
  const {
    client,
    projectId,
    cardId,
    anchor: routeAnchor,
    inDrawer = false,
    revision = 0,
    cardRevision,
  } = props;
  const [affectedCards, setAffectedCards] = useState<readonly string[]>([]);
  const [routeFilters] = useRouteFilters({ kind: "card", projectId, cardId });
  const routeLocation = `${projectId}/${cardId}/${routeAnchor ?? ""}/${routeFilters.type ?? ""}/${routeFilters.author ?? ""}`;
  const [localAnchor, setLocalAnchor] = useState<{
    id: string | undefined;
    routeLocation: string;
  }>();
  const anchor =
    localAnchor?.routeLocation === routeLocation ? localAnchor.id : routeAnchor;
  useEffect(() => {
    setLocalAnchor((current) =>
      current?.routeLocation === routeLocation ? current : undefined,
    );
  }, [routeLocation]);
  const locate = (id: string | undefined) =>
    setLocalAnchor({ id, routeLocation });
  const pageSize = [20, 50, 100].includes(Number(routeFilters.count))
    ? Number(routeFilters.count)
    : 20;
  const query = useRef<CardReadOptions>({
    limit: pageSize,
    ...(anchor ? { at: anchor } : {}),
    ...(routeFilters.type ? { type: routeFilters.type } : {}),
    ...(routeFilters.author ? { author: routeFilters.author } : {}),
  });
  const history = useRef<{ key: string; detail: CardDetail } | undefined>(
    undefined,
  );
  const loadGeneration = useRef(0);
  const previousSize = useRef(pageSize);
  const previousFilters = useRef(
    `${routeFilters.type ?? ""}/${routeFilters.author ?? ""}`,
  );
  const load = useCallback(async () => {
    try {
      const request = ++loadGeneration.current;
      const options = { ...query.current };
      const key = JSON.stringify([
        projectId,
        cardId,
        options.at,
        options.type,
        options.author,
        options.limit,
      ]);
      const detail = await client.card(projectId, cardId, options);
      const previous =
        history.current?.key === key ? history.current.detail : undefined;
      const merged =
        previous && detail.timeline_next_cursor !== undefined
          ? {
              ...detail,
              timeline: [
                ...new Map(
                  [...previous.timeline, ...detail.timeline].map((entry) => [
                    entry.id,
                    entry,
                  ]),
                ).values(),
              ].sort((a, b) => b.event_seq - a.event_seq),
              timeline_next_cursor: options.before
                ? detail.timeline_next_cursor
                : (previous.timeline_next_cursor ?? null),
            }
          : detail;
      if (request === loadGeneration.current) {
        history.current = { key, detail: merged };
        const { before: _before, ...current } = query.current;
        query.current = current;
      }
      return merged;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }, [client, projectId, cardId]);
  const { data, error, reload, pending, interactive } = useResource(
    load,
    cardRevision ? cardRevision(cardId, affectedCards) : revision,
  );
  useEffect(() => {
    if (!data) return;
    const ids = [
      ...new Set(
        [...data.decisions, ...(data.merge_confirmations ?? [])].flatMap(
          (decision) =>
            (decision.affected_card_views ?? [])
              .filter((card) => card.id !== decision.card_id)
              .map((card) => card.id),
        ),
      ),
    ].sort();
    setAffectedCards((current) =>
      current.length === ids.length && current.every((id, i) => id === ids[i])
        ? current
        : ids,
    );
  }, [data]);
  useEffect(() => {
    const filterKey = `${routeFilters.type ?? ""}/${routeFilters.author ?? ""}`;
    if (
      query.current.at === anchor &&
      previousSize.current === pageSize &&
      previousFilters.current === filterKey
    )
      return;
    query.current = {
      limit: pageSize,
      ...(anchor ? { at: anchor } : {}),
      ...(routeFilters.type ? { type: routeFilters.type } : {}),
      ...(routeFilters.author ? { author: routeFilters.author } : {}),
    };
    previousSize.current = pageSize;
    previousFilters.current = filterKey;
    history.current = undefined;
    reload();
  }, [anchor, pageSize, routeFilters.type, routeFilters.author, reload]);
  const back = routeHash({ kind: "cards", projectId });
  if (data === null)
    return (
      <div>
        <EmptyState>找不到卡片 {cardId}。请核对编号或返回卡片。</EmptyState>
        <a href={back}>返回到卡片</a>
      </div>
    );
  return (
    <>
      <RequestFeedback
        pending={pending}
        interactive={interactive}
        error={error}
        retry={reload}
        pendingMessage={`正在加载卡片 ${cardId}…`}
      />
      {data && (
        <CardContent
          key={`${projectId}/${cardId}`}
          detail={data}
          client={client}
          projectId={projectId}
          cardId={cardId}
          anchor={anchor}
          inDrawer={inDrawer}
          onLocate={inDrawer ? locate : undefined}
          onPosted={(comment) => {
            const id = `entry-${comment.id}`;
            locate(id);
            if (!inDrawer)
              window.location.hash = routeHash({
                kind: "card",
                projectId,
                cardId,
                anchor: id,
                filters: routeFilters,
              });
          }}
          onCommentConflict={() => {
            locate(undefined);
            query.current = { limit: pageSize };
            if (!inDrawer)
              window.location.hash = routeHash({
                kind: "card",
                projectId,
                cardId,
                filters: routeFilters,
              });
            reload();
          }}
          reload={reload}
          pending={pending}
          anchorReady={!anchor || (query.current.at === anchor && !pending)}
          pageSize={pageSize}
          loadEarlier={() => {
            if (data.timeline_next_cursor) {
              query.current = {
                ...query.current,
                before: data.timeline_next_cursor,
                limit: pageSize,
              };
            } else if (data.timeline_next_cursor === undefined) {
              query.current = {
                ...query.current,
                limit:
                  Math.max(
                    query.current.limit ?? pageSize,
                    data.timeline.length,
                  ) + pageSize,
              };
            } else return;
            reload();
          }}
        />
      )}
    </>
  );
}

function CardContent({
  detail,
  client,
  projectId,
  cardId,
  anchor,
  inDrawer,
  onLocate,
  onPosted,
  onCommentConflict,
  reload,
  pending,
  pageSize,
  loadEarlier,
  anchorReady,
}: {
  detail: CardDetail;
  client: CardiganClient;
  projectId: string;
  cardId: string;
  anchor: string | undefined;
  inDrawer: boolean;
  onLocate: ((anchor: string) => void) | undefined;
  onPosted: (comment: PostedComment) => void;
  onCommentConflict: () => void;
  reload: () => void;
  anchorReady: boolean;
  pending: boolean;
  pageSize: number;
  loadEarlier: () => void;
}) {
  const [filters, setFilters] = useRouteFilters({
    kind: "card",
    projectId,
    cardId,
  });
  const article = useRef<HTMLElement>(null);
  const commentBox = useRef<CommentBoxHandle>(null);
  const scroll = useRef<HTMLElement>(null),
    lastAnchor = useRef<string | undefined>(undefined);
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    if (anchor) return;
    const root = inDrawer
      ? article.current?.closest<HTMLElement>(".drawer-body")
      : (document.scrollingElement ?? document.documentElement);
    if (root) root.scrollTop = 0;
  }, [anchor, inDrawer]);
  // Anchors may render before route filters settle. Follow their row while this
  // snapshot lays out, then stop on interaction or refresh; never move a reader
  // back to the latest entry on an unrelated SSE update.
  useEffect(() => {
    const region = scroll.current;
    if (!region) return;
    let position: () => void;
    let initial = true;
    if (anchor) {
      if (!anchorReady) return;
      const location = `${anchor}/${filters.type ?? ""}/${filters.author ?? ""}`;
      initial = lastAnchor.current !== location;
      position = () => {
        const target = document.getElementById(anchor);
        if (!target) return;
        lastAnchor.current = location;
        for (
          let parent = target.parentElement;
          parent;
          parent = parent.parentElement
        )
          if (parent.tagName === "DETAILS")
            (parent as HTMLDetailsElement).open = true;
        (target.closest(".timeline-entry") ?? target).scrollIntoView?.({
          block: "nearest",
        });
      };
    } else {
      // C-205: start at the decision summary; explicit timeline anchors still win.
      lastAnchor.current = undefined;
      return;
    }
    let following = true;
    const settle = () => {
      if (following) position();
    };
    if (initial) settle();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(settle);
    observer?.observe(article.current ?? region);
    const stop = () => {
      following = false;
      observer?.disconnect();
    };
    for (const event of ["wheel", "pointerdown", "keydown"])
      window.addEventListener(event, stop, { once: true });
    return () => {
      following = false;
      observer?.disconnect();
      for (const event of ["wheel", "pointerdown", "keydown"])
        window.removeEventListener(event, stop);
    };
  }, [anchor, anchorReady, filters.type, filters.author]);
  const card = detail.card;
  const cardPageClass = inDrawer ? "card-page card-page-drawer" : "card-page";
  const completion = [...detail.deliveries]
    .reverse()
    .find((d) => d.kind === "card_completion" && d.status === "accepted");
  const sectionId = (name: string) => `card-${cardId}-${name}`;
  // C-192: open human decisions (other than merge confirmations) carrying a
  // suggestion can be handled here in one click, like in Needs You.
  const suggested = detail.decisions.filter(
    (q) =>
      q.suggestion &&
      q.decider === "human" &&
      q.trigger !== "merge_confirmation" &&
      ["open", "provisional", "snoozed"].includes(q.status),
  );
  const sections = [
    ...(detail.merge_confirmations?.length || card.merge_check_blockers?.length
      ? [{ id: sectionId("merge"), label: "合并处理" }]
      : []),
    ...(suggested.length
      ? [{ id: sectionId("suggested"), label: SUGGESTION_COPY.cardSection }]
      : []),
    { id: sectionId("overview"), label: "概览" },
    ...(detail.work_items.length
      ? [
          {
            id: sectionId("work"),
            label: "工作项",
            count: detail.work_items.length,
          },
        ]
      : []),
    ...(detail.deliveries.length || detail.reviews.length
      ? [
          {
            id: sectionId("records"),
            label: "交付与审核",
            count: detail.deliveries.length + detail.reviews.length,
          },
        ]
      : []),
    ...(detail.counts.timeline
      ? [
          {
            id: sectionId("timeline"),
            label: "时间线",
            count: detail.counts.timeline,
          },
        ]
      : []),
    ...(detail.attachments.length
      ? [
          {
            id: sectionId("attachments"),
            label: "附件",
            count: detail.attachments.length,
          },
        ]
      : []),
  ];
  return (
    <article
      ref={article}
      className={cardPageClass}
      aria-label={`卡片 ${cardId}`}
    >
      <div className="card-main">
        <header className="card-header">
          <CardSource detail={detail} projectId={projectId} />
          <PageTitle
            title={
              <>
                <IdTag id={card.id} label="卡片" /> {card.title}
              </>
            }
            description={
              <>
                <CardSuperseded card={card} projectId={projectId} />
                <span>
                  更新于 <Time value={detail.updated_at ?? card.created_at} />
                </span>
              </>
            }
          />
          <CardStatusLine detail={detail} />
          <CardRiskTags tags={card.risk_tags} />
          <CardTemplate
            key={card.id}
            detail={detail}
            client={client}
            projectId={projectId}
            onSaved={reload}
          />
          <CardActions
            card={card}
            client={client}
            projectId={projectId}
            onSaved={reload}
          />
        </header>
        <CardSectionNav
          article={article}
          sections={sections}
          cardId={card.id}
          title={card.title}
          commentBox={commentBox}
          inDrawer={inDrawer}
        />
        {!!(
          detail.merge_confirmations?.length ||
          card.merge_check_blockers?.length
        ) && (
          <section
            id={sectionId("merge")}
            className="card-section card-merge"
            aria-label="合并处理"
          >
            <h2 className="visually-hidden">合并处理</h2>
            <MergeBlockers blockers={card.merge_check_blockers ?? []} />
            {detail.merge_confirmations?.map((q) => (
              <MergeConfirmation
                key={q.id}
                q={q}
                client={client}
                projectId={projectId}
                done={reload}
                elapsed={0}
                inCardHeader
              />
            ))}
          </section>
        )}
        {suggested.length > 0 && (
          <section
            id={sectionId("suggested")}
            className="card-section"
            aria-label={SUGGESTION_COPY.cardSection}
          >
            <h2>{SUGGESTION_COPY.cardSection}</h2>
            {suggested.map((q) => (
              <article
                key={q.id}
                className="needs-item"
                aria-label={`拍板 ${q.id}`}
              >
                <h3 className="needs-question">{q.question}</h3>
                <PlainSummary id={q.id} summary={q.plain_summary} />
                <DecisionContext
                  context={q.context}
                  summary={q.plain_summary}
                  legacy={null}
                />
                <SuggestedDecision
                  q={q}
                  client={client}
                  projectId={projectId}
                  done={reload}
                />
                <p className="hint">
                  {SUGGESTION_COPY.otherOptions}
                  <a href={routeHash({ kind: "needs-you", projectId })}>
                    Needs You
                  </a>
                </p>
              </article>
            ))}
          </section>
        )}
        <details
          id={sectionId("overview")}
          className="card-purpose"
          aria-label="目标和验收标准"
        >
          <summary>目标和验收标准</summary>
          <LongContent>
            <p>{card.goal}</p>
          </LongContent>
          <details className="acceptance-criteria">
            <summary>验收标准（{card.acceptance_criteria.length} 项）</summary>
            <LongContent>
              <ul>
                {card.acceptance_criteria.map((criterion) => (
                  <li key={criterion}>{criterion}</li>
                ))}
              </ul>
            </LongContent>
            <p className="hint">
              尚无逐条验收证据映射，仅列出标准，不推测通过状态。
            </p>
            {completion && (
              <p>
                整体完成申请已通过：
                <IdTag
                  id={completion.id}
                  label="完成申请"
                  href={routeHash({
                    kind: "card",
                    projectId,
                    cardId,
                    anchor: `delivery-${completion.id}`,
                  })}
                />
              </p>
            )}
          </details>
          <RecentConclusions
            detail={detail}
            projectId={projectId}
            onLocate={onLocate}
          />
        </details>
        {!!detail.work_items.length && (
          <div id={sectionId("work")}>
            <CardWorkItems
              client={client}
              changed={reload}
              detail={detail}
              projectId={projectId}
              cardId={cardId}
            />
          </div>
        )}
        {!!(detail.deliveries.length || detail.reviews.length) && (
          <details
            id={sectionId("records")}
            className="card-records-disclosure"
          >
            <summary>
              交付与审核（{detail.deliveries.length + detail.reviews.length}{" "}
              条）
            </summary>
            <CardRecords
              detail={detail}
              projectId={projectId}
              onLocate={onLocate}
            />
          </details>
        )}
        <section
          id={sectionId("timeline")}
          className="card-section card-timeline"
          aria-label="时间线"
        >
          <h2>时间线</h2>
          <TimelineControls
            filters={filters}
            onChange={setFilters}
            loaded={detail.timeline.length}
            total={detail.counts.timeline}
            hasMore={
              detail.timeline_next_cursor === undefined
                ? detail.timeline.length < detail.counts.timeline
                : detail.timeline_next_cursor !== null
            }
            pageSize={pageSize}
            pending={pending}
            loadEarlier={loadEarlier}
          />
          <CommentBox
            ref={commentBox}
            client={client}
            projectId={projectId}
            cardId={cardId}
            mentions={mentionOptions(detail)}
            hasPmOps={detail.has_pm_ops}
            onPosted={onPosted}
            onConflict={onCommentConflict}
          />
          {anchor && (filters.type || filters.author) && (
            <p className="hint">
              已保留链接指向的条目，便于定位；重新筛选后恢复只显示匹配项。
            </p>
          )}
          <section
            className="timeline-records"
            ref={scroll}
            aria-label="时间线记录"
          >
            <Timeline
              projectId={projectId}
              cardId={cardId}
              entries={detail.timeline}
              attachments={detail.attachments}
              detail={detail}
              typeFilter={filters.type ?? ""}
              authorFilter={filters.author ?? ""}
              anchor={anchor}
            />
          </section>
        </section>
        {!!detail.attachments.length && (
          <details
            id={sectionId("attachments")}
            className="card-section"
            aria-label="附件"
          >
            <summary>附件（{detail.attachments.length}）</summary>
            <AttachmentGrid attachments={detail.attachments} />
          </details>
        )}
      </div>
      <CardSidebar detail={detail} projectId={projectId} cardId={cardId} />
    </article>
  );
}

/** `@` suggestions: the roles and Assignments this card already knows. */
export function mentionOptions(detail: CardDetail): MentionOption[] {
  const options = new Map<string, MentionOption>();
  for (const item of detail.work_items) {
    options.set(item.role_id, {
      value: item.role_id,
      label: `角色 ${item.role_id}`,
    });
    if (item.assignment_id !== undefined) {
      options.set(item.assignment_id, {
        value: item.assignment_id,
        label: `Assignment ${item.assignment_id}`,
      });
    }
  }
  for (const owner of detail.card.next_owners) {
    if (owner.kind === "role") {
      options.set(owner.ref, { value: owner.ref, label: `角色 ${owner.ref}` });
    }
    if (owner.kind === "assignment") {
      options.set(owner.ref, {
        value: owner.ref,
        label: `Assignment ${owner.ref}`,
      });
    }
  }
  return [...options.values()];
}
