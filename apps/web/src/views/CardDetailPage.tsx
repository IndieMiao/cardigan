import { useCallback, useEffect, useRef } from "react";
import {
  ApiError,
  type CardDetail,
  type CardiganClient,
  type CardReadOptions,
} from "../api.js";
import { CardSidebar } from "../components/CardSidebar.js";
import { CommentBox, type MentionOption } from "../components/CommentBox.js";
import { FilterBar } from "../components/FilterBar.js";
import {
  EmptyState,
  IdTag,
  LongContent,
  PageTitle,
  StatusTag,
  Time,
} from "../components/Foundation.js";
import { Timeline } from "../components/Timeline.js";
import { routeHash, useRouteFilters } from "../route.js";
import { useResource } from "../useResource.js";

export interface CardDetailPageProps {
  readonly client: CardiganClient;
  readonly projectId: string;
  readonly cardId: string;
  readonly anchor?: string;
  /** Embedded in a drawer: do not auto-scroll to the latest timeline entry. */
  readonly inDrawer?: boolean;
  readonly revision?: number;
}
export function CardDetailPage(props: CardDetailPageProps) {
  const {
    client,
    projectId,
    cardId,
    anchor,
    inDrawer = false,
    revision = 0,
  } = props;
  const [routeFilters] = useRouteFilters({ kind: "card", projectId, cardId });
  const pageSize = [20, 50, 100].includes(Number(routeFilters.count))
    ? Number(routeFilters.count)
    : 20;
  const query = useRef<CardReadOptions>({
    limit: pageSize,
    ...(anchor ? { at: anchor } : {}),
  });
  const previousSize = useRef(pageSize);
  const load = useCallback(async () => {
    try {
      return await client.card(projectId, cardId, query.current);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }, [client, projectId, cardId]);
  const { data, error, reload, pending } = useResource(load, revision);
  useEffect(() => {
    if (query.current.at === anchor && previousSize.current === pageSize)
      return;
    query.current = {
      limit:
        previousSize.current === pageSize
          ? Math.max(
              query.current.limit ?? pageSize,
              data?.timeline.length ?? 0,
            )
          : pageSize,
      ...(anchor ? { at: anchor } : {}),
    };
    previousSize.current = pageSize;
    reload();
  }, [anchor, pageSize, data, reload]);
  const back = routeHash({ kind: "cards", projectId });
  if (data === null)
    return (
      <div>
        <EmptyState>找不到卡片 {cardId}。请核对编号或返回卡片。</EmptyState>
        <a href={back}>返回到卡片</a>
      </div>
    );
  if (!data)
    return error ? (
      <div role="alert" className="error-panel">
        {error}
        <button type="button" onClick={reload}>
          重试
        </button>
      </div>
    ) : (
      <p className="loading" role="status">
        正在加载卡片 {cardId}…
      </p>
    );
  return (
    <CardContent
      key={`${projectId}/${cardId}`}
      detail={data}
      client={client}
      projectId={projectId}
      cardId={cardId}
      anchor={anchor}
      inDrawer={inDrawer}
      error={error}
      reload={reload}
      pending={pending}
      anchorReady={!anchor || (query.current.at === anchor && !pending)}
      pageSize={pageSize}
      loadEarlier={() => {
        query.current = {
          ...query.current,
          limit:
            Math.max(query.current.limit ?? pageSize, data.timeline.length) +
            pageSize,
        };
        reload();
      }}
    />
  );
}

function CardContent({
  detail,
  client,
  projectId,
  cardId,
  anchor,
  inDrawer,
  error,
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
  error: string | undefined;
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
  const scroll = useRef<HTMLElement>(null),
    initialTimeline = useRef(detail.timeline),
    interacted = useRef(false),
    lastAnchor = useRef<string | undefined>(undefined);
  // Anchors may render before route filters settle. Follow their row while this
  // snapshot lays out, then stop on interaction or refresh; never move a reader
  // back to the latest entry on an unrelated SSE update.
  useEffect(() => {
    const region = scroll.current;
    if (!region) return;
    let position: () => void;
    if (anchor) {
      if (!anchorReady) return;
      const location = `${anchor}/${filters.type ?? ""}/${filters.author ?? ""}`;
      if (lastAnchor.current === location) return;
      interacted.current = true;
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
      if (inDrawer) return;
      lastAnchor.current = undefined;
      if (interacted.current || initialTimeline.current !== detail.timeline)
        return;
      position = () => {
        region
          .querySelector(".timeline > li:last-child")
          ?.scrollIntoView?.({ block: "end" });
      };
    }
    let following = true;
    const settle = () => {
      if (following) position();
    };
    settle();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(settle);
    observer?.observe(region.closest(".card-main") ?? region);
    const stop = () => {
      following = false;
      interacted.current = true;
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
  }, [
    anchor,
    anchorReady,
    detail.timeline,
    filters.type,
    filters.author,
    inDrawer,
  ]);
  const card = detail.card;
  const cardPageClass = inDrawer ? "card-page card-page-drawer" : "card-page";
  const completion = [...detail.deliveries]
    .reverse()
    .find((d) => d.kind === "card_completion" && d.status === "accepted");
  return (
    <article className={cardPageClass} aria-label={`卡片 ${cardId}`}>
      <div className="card-main">
        {error && (
          <p role="alert" className="error-panel">
            {error}
            <button type="button" onClick={reload}>
              重试
            </button>
          </p>
        )}
        <header className="card-header">
          <PageTitle
            title={
              <>
                <IdTag id={card.id} label="卡片" /> {card.title}
              </>
            }
            description={
              <>
                <StatusTag status={card.status} />
                <span>
                  更新于 <Time value={detail.updated_at ?? card.created_at} />
                </span>
              </>
            }
          />
        </header>
        <section className="card-purpose" aria-label="目标和验收标准">
          <h2>目标</h2>
          <LongContent>
            <p>{card.goal}</p>
          </LongContent>
          <details className="acceptance-criteria" open>
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
        </section>
        <section className="card-section card-timeline" aria-label="时间线">
          <h2>时间线</h2>
          <FilterBar
            fields={[
              {
                key: "type",
                label: "条目类型",
                options: [
                  { value: "delivery", label: "交付" },
                  { value: "review", label: "审核" },
                  { value: "decision", label: "拍板" },
                  { value: "comment", label: "评论" },
                  { value: "instruction", label: "指令" },
                  { value: "human_action", label: "待你执行" },
                  { value: "handoff", label: "交接" },
                  { value: "system", label: "系统" },
                ],
              },
              {
                key: "author",
                label: "发言方",
                options: [
                  { value: "human", label: "人" },
                  { value: "pm", label: "PM" },
                  { value: "agent", label: "Agent" },
                  { value: "system", label: "系统" },
                ],
              },
            ]}
            values={filters}
            onChange={setFilters}
          />
          {anchor && (filters.type || filters.author) && (
            <p className="hint">
              已保留链接指向的条目，便于定位；重新筛选后恢复只显示匹配项。
            </p>
          )}
          <div className="timeline-controls">
            <label>
              每次加载{" "}
              <select
                value={pageSize}
                onChange={(e) =>
                  setFilters({ ...filters, count: e.target.value })
                }
              >
                {[20, 50, 100].map((size) => (
                  <option value={size} key={size}>
                    {size} 条
                  </option>
                ))}
              </select>
            </label>
            <span>
              已加载 {detail.timeline.length} / {detail.counts.timeline} 条
            </span>
            {detail.counts.timeline > detail.timeline.length && (
              <button
                type="button"
                className="quiet"
                disabled={pending}
                onClick={loadEarlier}
              >
                {pending ? "正在加载…" : "加载更早的记录"}
              </button>
            )}
          </div>
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
          <CommentBox
            client={client}
            projectId={projectId}
            cardId={cardId}
            mentions={mentionOptions(detail)}
            onPosted={reload}
          />
        </section>
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
