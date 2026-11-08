import { useCallback } from "react";
import type { CardiganClient, CardView, SnapshotData } from "../api.js";
import {
  EmptyState,
  IdTag,
  PageTitle,
  StatusTag,
  Time,
} from "../components/Foundation.js";
import { CardLink, Feedback } from "../components/Operations.js";
import { routeHash } from "../route.js";
import { SNAPSHOT_GROUPS } from "../snapshot-groups.js";
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
      {data && <Overview data={data} projectId={projectId} />}
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
                <table className="card-table delivery-table">
                  <thead>
                    <tr>
                      {["卡片", "工作项", "状态", "提交时间", "摘要"].map(
                        (label) => (
                          <th scope="col" key={label}>
                            {label}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent_deliveries.map((d) => (
                      <tr key={d.id}>
                        <td>
                          <CardLink
                            projectId={projectId}
                            id={d.card_id}
                            label={
                              data.cards.find((c) => c.id === d.card_id)
                                ?.title ?? "卡片"
                            }
                          />
                        </td>
                        <td>
                          {d.work_item_id ? (
                            <IdTag
                              id={d.work_item_id}
                              label={d.work_item_title ?? "工作项"}
                              href={
                                d.card_id
                                  ? routeHash({
                                      kind: "card",
                                      projectId,
                                      cardId: d.card_id,
                                      anchor: `work-item-${d.work_item_id}`,
                                    })
                                  : undefined
                              }
                            />
                          ) : (
                            "工作项未记录"
                          )}
                        </td>
                        <td>
                          <StatusTag status={d.status} />
                        </td>
                        <td>
                          <Time value={d.submitted_at} />
                        </td>
                        <td>
                          <div className="delivery-summary">
                            <IdTag
                              id={d.id}
                              label="交付"
                              href={
                                d.card_id
                                  ? routeHash({
                                      kind: "card",
                                      projectId,
                                      cardId: d.card_id,
                                      anchor: `delivery-${d.id}`,
                                    })
                                  : undefined
                              }
                            />
                            <span className="summary-text" title={d.summary}>
                              {d.summary}
                            </span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}
          </>
        ))}
    </section>
  );
}

function Overview({
  data,
  projectId,
}: {
  data: SnapshotData;
  projectId: string;
}) {
  const counts: Record<string, number> = {
    human: new Set(data.waiting.human).size,
    agent: new Set(data.waiting.agent).size,
    progress: new Set(data.in_progress.map((c) => c.id)).size,
    review: new Set(data.in_review.map((c) => c.id)).size,
    blocked: new Set(data.blocked.map((b) => b.card_id)).size,
  };
  return (
    <nav className="snapshot-overview" aria-label="项目概览">
      {SNAPSHOT_GROUPS.map((group) => (
        <a
          key={group.value}
          href={routeHash({
            kind: "list",
            projectId,
            filters: { overview: group.value },
          })}
          title={
            group.value === "blocked"
              ? "有等待审核或阻塞的工作项，按卡片计数"
              : "按卡片计数，各分组可能重叠"
          }
        >
          <span>{group.label}</span> <strong>{counts[group.value]}</strong>
        </a>
      ))}
    </nav>
  );
}
