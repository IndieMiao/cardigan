import { useCallback, useState } from "react";
import type {
  AttachmentView,
  CardDetail,
  CardiganClient,
  CardListItem,
} from "../api.js";
import {
  dependencyStatusLabel,
  layoutDependencyGraph,
} from "../dependency-graph.js";
import { routeHash } from "../route.js";
import { BOARD_STATUSES, CARD_STATUS_LABELS } from "../status.js";
import { type StoryProgress, storyGraph } from "../story-graph.js";
import { useResource } from "../useResource.js";
import { AttachmentGrid } from "./AttachmentGrid.js";
import { DependencyPeek } from "./CardDependencies.js";
import { EmptyState, LongContent, StatusTag, Time } from "./Foundation.js";
import { IdBadge } from "./IdTag.js";
import {
  DependencyGraph,
  DependencyGraphFacts,
  DependencyGraphHelp,
  DependencyGraphNode,
  DependencyGraphNodeHead,
  DependencyGraphNodeTitle,
} from "./layout/DependencyGraphLayout.js";
import { Markdown, MarkdownBody } from "./Operations.js";
import { Button } from "./ui/button.js";
import { Skeleton } from "./ui/skeleton.js";

/** The server rejects larger `ids` reads; long stories read in slices. */
const ID_BATCH = 100;

/**
 * C-505: the read-only frame of a story card's overview. Decomposition
 * proposals, confirmation and change requests arrive with C-503; until then
 * their place shows an empty state and no control.
 */
export function StoryOverview({
  detail,
  attachments,
  client,
  projectId,
  cardId,
  revision,
  onLocate,
  onShowTimeline,
}: {
  detail: CardDetail;
  /** Undefined while the overview has only the count; see `StoryAttachments`. */
  attachments: StoryAttachmentsState;
  client: CardiganClient;
  projectId: string;
  cardId: string;
  revision: number;
  onLocate: ((anchor: string) => void) | undefined;
  onShowTimeline: () => void;
}) {
  const card = detail.card;
  return (
    <>
      <section className="card-purpose" aria-label="原始需求">
        <h2>原始需求</h2>
        <Markdown body={card.goal} />
        {card.acceptance_criteria.length > 0 && (
          <section className="acceptance-criteria">
            <h3>验收标准（{card.acceptance_criteria.length} 项）</h3>
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
        <section aria-label="需求附件">
          <h3>
            附件
            {attachments.count ? `（${attachments.count}）` : ""}
          </h3>
          <StoryAttachments state={attachments} />
        </section>
      </section>
      <StoryChildren
        story={card}
        progress={card.story_progress}
        client={client}
        projectId={projectId}
        revision={revision}
      />
      <section className="card-purpose" aria-label="拆解方案">
        <h2>拆解方案</h2>
        <EmptyState>没有拆解方案</EmptyState>
      </section>
      <StoryDiscussionFacts detail={detail} onShowTimeline={onShowTimeline} />
      <StorySummary
        detail={detail}
        client={client}
        projectId={projectId}
        cardId={cardId}
        revision={revision}
        onLocate={onLocate}
      />
    </>
  );
}

export type StoryAttachmentsState = {
  readonly count: number;
  readonly attachments?: readonly AttachmentView[];
  readonly error?: string;
  readonly retry?: () => void;
};

function StoryAttachments({ state }: { state: StoryAttachmentsState }) {
  if (!state.count) return <EmptyState>没有附件</EmptyState>;
  return (
    <>
      {state.error && (
        <RetryLine
          message={`读取附件失败：${state.error}`}
          {...(state.retry ? { retry: state.retry } : {})}
        />
      )}
      {state.attachments ? (
        <AttachmentGrid attachments={state.attachments} />
      ) : (
        !state.error && <Skeleton />
      )}
    </>
  );
}

/**
 * The overview read carries only the attachment count; the story reads the
 * attachments panel itself, the same request the 附件 tab makes.
 */
export function useStoryAttachments({
  detail,
  client,
  projectId,
  cardId,
  revision,
}: {
  detail: CardDetail;
  client: CardiganClient;
  projectId: string;
  cardId: string;
  revision: number;
}): StoryAttachmentsState {
  const count = detail.overview?.attachment_count ?? detail.attachments.length;
  const needed = !!detail.card.story && !!detail.overview && count > 0;
  const load = useCallback(
    async () =>
      client.cardPanel
        ? ((await client.cardPanel(projectId, cardId, "attachments"))
            .attachments ?? [])
        : [],
    [client, projectId, cardId],
  );
  const read = useResource(load, revision, needed);
  if (!detail.overview) return { count, attachments: detail.attachments };
  return {
    count,
    ...(read.data ? { attachments: read.data } : {}),
    ...(read.error ? { error: read.error, retry: read.reload } : {}),
  };
}

function StoryChildren({
  story,
  progress,
  client,
  projectId,
  revision,
}: {
  story: CardDetail["card"];
  progress: StoryProgress | undefined;
  client: CardiganClient;
  projectId: string;
  revision: number;
}) {
  const ids = (progress?.children ?? []).map((child) => child.id);
  const key = ids.join(",");
  const load = useCallback(async () => {
    const list = key ? key.split(",") : [];
    const pages = await Promise.all(
      Array.from({ length: Math.ceil(list.length / ID_BATCH) }, (_, i) =>
        client.cards(projectId, "all", {
          ids: list.slice(i * ID_BATCH, (i + 1) * ID_BATCH).join(","),
        }),
      ),
    );
    return pages.flatMap((page) => page.cards) as readonly CardListItem[];
  }, [client, projectId, key]);
  const rows = useResource(load, revision, ids.length > 0);
  const [opened, setOpened] = useState<string>();
  const total = progress?.total ?? 0;
  const counts = BOARD_STATUSES.filter(
    (status) => (progress?.counts[status] ?? 0) > 0,
  ).map(
    (status) => `${CARD_STATUS_LABELS[status]} ${progress?.counts[status]}`,
  );
  return (
    <section className="card-section card-dependencies" aria-label="子卡进度">
      <h2>子卡进度</h2>
      {!progress || !total ? (
        <EmptyState>没有子卡</EmptyState>
      ) : (
        <>
          <DependencyGraphFacts>
            <span>
              已结束 {progress.finished}/{total}
            </span>
            {counts.map((fact) => (
              <span key={fact}>{fact}</span>
            ))}
            <DependencyGraphHelp label="怎么看子卡进度图">
              图中除需求卡外都是它的子卡。虚线从需求卡连到最先开始的子卡；带箭头的实线是子卡之间的依赖，箭头指向后做的卡。
            </DependencyGraphHelp>
          </DependencyGraphFacts>
          {rows.error && (
            <RetryLine
              message={`读取子卡依赖失败：${rows.error}`}
              retry={rows.reload}
            />
          )}
          {rows.data || rows.error ? (
            <StoryChildGraph
              story={story}
              progress={progress}
              rows={rows.data ?? []}
              projectId={projectId}
              client={client}
              opened={opened}
              setOpened={setOpened}
            />
          ) : (
            <Skeleton />
          )}
        </>
      )}
    </section>
  );
}

function StoryChildGraph({
  story,
  progress,
  rows,
  projectId,
  client,
  opened,
  setOpened,
}: {
  story: CardDetail["card"];
  progress: StoryProgress;
  rows: readonly CardListItem[];
  projectId: string;
  client: CardiganClient;
  opened: string | undefined;
  setOpened: (update: (was: string | undefined) => string | undefined) => void;
}) {
  const { graph, isParentEdge, before, after } = storyGraph(
    story,
    progress,
    rows,
  );
  const layout = layoutDependencyGraph(graph, story.id);
  const muted = new Set(
    layout.nodes.filter((n) => n.muted).map((n) => n.card.id),
  );
  const children = graph.nodes.slice(1).map((n) => n.id);
  return (
    <DependencyGraph
      label="子卡进度图"
      edges={layout.edges.map((edge) => {
        const parent = isParentEdge(edge);
        return {
          ...edge,
          kind: parent ? "parent" : "dependency",
          // A finished child no longer needs attention, nor does its line.
          muted: muted.has(parent ? edge.to : edge.from),
        };
      })}
    >
      {layout.nodes.map(({ card: node, column, row, current, muted }) => {
        const status = dependencyStatusLabel(node);
        const relation = [
          "子卡",
          before.get(node.id)?.length
            ? `前置 ${before.get(node.id)?.join("、")}`
            : "",
          after.get(node.id)?.length
            ? `后续 ${after.get(node.id)?.join("、")}`
            : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <DependencyGraphNode
            key={node.id}
            id={node.id}
            column={column}
            row={row}
            current={current}
            muted={muted}
            open={opened === node.id}
            onOpenChange={(value) =>
              // A late close from the previous node must not shut this one.
              setOpened((was) =>
                value ? node.id : was === node.id ? undefined : was,
              )
            }
            peek={
              current ? undefined : (
                <DependencyPeek
                  node={node}
                  status={status}
                  relation={relation}
                  projectId={projectId}
                  client={client}
                  onLeave={() => setOpened(() => undefined)}
                />
              )
            }
            tooltip={`${node.id} ${node.title} · ${status}`}
            childOf={current ? undefined : story.id}
            parentOf={current ? children : undefined}
            before={before.get(node.id)}
            after={after.get(node.id)}
          >
            <DependencyGraphNodeHead>
              <IdBadge id={node.id} titled={false} />
              <StatusTag status={node.status} label={status} subdued={muted} />
            </DependencyGraphNodeHead>
            <DependencyGraphNodeTitle>{node.title}</DependencyGraphNodeTitle>
          </DependencyGraphNode>
        );
      })}
    </DependencyGraph>
  );
}

function StoryDiscussionFacts({
  detail,
  onShowTimeline,
}: {
  detail: CardDetail;
  onShowTimeline: () => void;
}) {
  const story = detail.card.story;
  const groups = story?.question_groups ?? [];
  const open = groups.reduce(
    (n, group) => n + group.questions.filter((q) => !q.resolution).length,
    0,
  );
  const facts = groups.length
    ? [
        `需求澄清 ${story?.discussion_rounds ?? 0} 轮`,
        `问题清单 ${groups.length} 组`,
        open ? `${open} 题待答` : "问题已全部处理",
      ]
    : [];
  return (
    <section className="card-purpose" aria-label="讨论">
      <h2>讨论</h2>
      <DependencyGraphFacts>
        {facts.length ? (
          facts.map((fact) => <span key={fact}>{fact}</span>)
        ) : (
          <span>没有问题清单</span>
        )}
        <Button variant="secondary" onClick={onShowTimeline}>
          查看讨论
        </Button>
      </DependencyGraphFacts>
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
}: {
  detail: CardDetail;
  client: CardiganClient;
  projectId: string;
  cardId: string;
  revision: number;
  onLocate: ((anchor: string) => void) | undefined;
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
  return (
    <section className="card-purpose" aria-label="对照总结">
      <h2>对照总结</h2>
      {!id ? (
        <EmptyState>没有总结</EmptyState>
      ) : (
        <>
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
        </>
      )}
    </section>
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
