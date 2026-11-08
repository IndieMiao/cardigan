import { useCallback, useEffect, useRef } from "react";
import { ApiError, type CardDetail, type CardiganClient } from "../api.js";
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
  readonly revision?: number;
}
export function CardDetailPage({
  client,
  projectId,
  cardId,
  anchor,
  revision = 0,
}: CardDetailPageProps) {
  const load = useCallback(async () => {
    try {
      return await client.card(projectId, cardId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }, [client, projectId, cardId]);
  const { data, error, reload } = useResource(load, revision);
  const back = routeHash({ kind: "board", projectId });
  if (data === null)
    return (
      <div>
        <EmptyState>找不到卡片 {cardId}。请核对编号或返回看板。</EmptyState>
        <a href={back}>返回到看板</a>
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
      error={error}
      reload={reload}
    />
  );
}

function CardContent({
  detail,
  client,
  projectId,
  cardId,
  anchor,
  error,
  reload,
}: {
  detail: CardDetail;
  client: CardiganClient;
  projectId: string;
  cardId: string;
  anchor: string | undefined;
  error: string | undefined;
  reload: () => void;
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
      const location = `${anchor}/${filters.type ?? ""}/${filters.author ?? ""}`;
      if (lastAnchor.current === location) return;
      lastAnchor.current = location;
      interacted.current = true;
      position = () => {
        const target = document.getElementById(anchor);
        if (!target) return;
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
      lastAnchor.current = undefined;
      if (interacted.current || initialTimeline.current !== detail.timeline)
        return;
      position = () => {
        region.scrollTop = region.scrollHeight;
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
    if (region.firstElementChild) observer?.observe(region.firstElementChild);
    const stop = () => {
      following = false;
      interacted.current = true;
      observer?.disconnect();
    };
    for (const event of ["wheel", "pointerdown", "keydown"])
      region.addEventListener(event, stop, { once: true });
    return () => {
      following = false;
      observer?.disconnect();
      for (const event of ["wheel", "pointerdown", "keydown"])
        region.removeEventListener(event, stop);
    };
  }, [anchor, detail.timeline, filters.type, filters.author]);
  const card = detail.card;
  const completion = [...detail.deliveries]
    .reverse()
    .find((d) => d.kind === "card_completion" && d.status === "accepted");
  return (
    <article className="card-page" aria-label={`卡片 ${cardId}`}>
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
          {detail.counts.timeline > detail.timeline.length && (
            <p className="hint">
              显示最近 {detail.timeline.length} 条，共 {detail.counts.timeline}{" "}
              条。
            </p>
          )}
          <section
            className="timeline-scroll"
            ref={scroll}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to scroll this region.
            tabIndex={0}
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
