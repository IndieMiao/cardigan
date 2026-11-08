import { useCallback } from "react";
import type { CardiganClient, CardView } from "../api.js";
import {
  EmptyState,
  IdTag,
  PageTitle,
  StatusTag,
} from "../components/Foundation.js";
import { CardLink, Feedback } from "../components/Operations.js";
import { nextOwnersLabel } from "../status.js";
import { useResource } from "../useResource.js";

function Cards({
  title,
  cards,
  projectId,
}: {
  title: string;
  cards: readonly CardView[];
  projectId: string;
}) {
  if (!cards.length) return null;
  return (
    <section aria-label={title}>
      <h2>
        {title}（{cards.length}）
      </h2>
      <ul className="overview-list">
        {cards.map((c) => (
          <li key={c.id}>
            <CardLink projectId={projectId} id={c.id} label={c.title} />{" "}
            <StatusTag status={c.status} />
            <p>
              <span>下一步：{nextOwnersLabel(c.next_owners)}</span>{" "}
              <span>原因：{c.why}</span>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
export function SnapshotPage({
  client,
  projectId,
  revision = 0,
}: {
  client: CardiganClient;
  projectId: string;
  revision?: number;
}) {
  const load = useCallback(
    () => client.snapshot(projectId),
    [client, projectId],
  );
  const { data, pending, error, reload } = useResource(load, revision);
  const hasItems =
    data &&
    data.waiting.human.length +
      data.waiting.agent.length +
      data.in_progress.length +
      data.in_review.length +
      data.blocked.length +
      data.recent_deliveries.length >
      0;
  return (
    <section aria-label="项目快照">
      <PageTitle
        title="项目快照"
        description="查看当前进度、等待事项与最近交付。"
      />
      <Feedback pending={pending} error={error} retry={reload} />
      {data &&
        (!data.cards.length ? (
          <EmptyState>
            这个项目还没有卡片。向 PM 描述目标后，卡片会出现在这里。
          </EmptyState>
        ) : (
          <>
            {!hasItems && (
              <EmptyState>
                目前没有进行中、待审核或阻塞的工作。新进展会出现在这里。
              </EmptyState>
            )}
            <div className="overview-grid">
              <Cards
                title="等你处理"
                cards={data.cards.filter((c) =>
                  data.waiting.human.includes(c.id),
                )}
                projectId={projectId}
              />
              <Cards
                title="等 Agent 处理"
                cards={data.cards.filter((c) =>
                  data.waiting.agent.includes(c.id),
                )}
                projectId={projectId}
              />
            </div>
            <div className="overview-grid">
              <Cards
                title="进行中"
                cards={data.in_progress}
                projectId={projectId}
              />
              <Cards
                title="审核与待合并"
                cards={data.in_review}
                projectId={projectId}
              />
            </div>
            {!!data.blocked.length && (
              <section aria-label="阻塞事项">
                <h2>阻塞事项（{data.blocked.length}）</h2>
                <ul>
                  {data.blocked.map((b) => (
                    <li key={`${b.card_id}/${b.work_item_id}/${b.label}`}>
                      <CardLink projectId={projectId} id={b.card_id} />{" "}
                      {b.label}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {!!data.recent_deliveries.length && (
              <section aria-label="最近交付">
                <h2>最近交付</h2>
                <ul>
                  {data.recent_deliveries.map((d) => (
                    <li key={d.id}>
                      <CardLink projectId={projectId} id={d.card_id} />{" "}
                      <IdTag id={d.id} label="交付" detail={d.summary} />
                      <span>{d.summary}</span> <StatusTag status={d.status} />
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        ))}
    </section>
  );
}
