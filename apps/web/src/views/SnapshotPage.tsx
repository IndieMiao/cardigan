import { useCallback } from "react";
import type { CardiganClient, CardView } from "../api.js";
import { CardLink, Feedback } from "../components/Operations.js";
import { cardStatusLabel, nextOwnersLabel } from "../status.js";
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
  return (
    <section aria-label={title}>
      <h2>
        {title}（{cards.length}）
      </h2>
      {!cards.length && <p className="hint">暂无</p>}
      <ul className="overview-list">
        {cards.map((c) => (
          <li key={c.id}>
            <CardLink projectId={projectId} id={c.id} /> · {c.title}{" "}
            <span className={`status status-${c.status}`}>
              {cardStatusLabel(c.status)}
            </span>
            <p>
              下一步：{nextOwnersLabel(c.next_owners)} · {c.why}
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
  return (
    <section aria-label="项目快照">
      <div className="toolbar">
        <h1>项目快照</h1>
        <button type="button" className="quiet" onClick={reload}>
          刷新
        </button>
      </div>
      <Feedback pending={pending} error={error} retry={reload} />
      {data &&
        (!data.cards.length ? (
          <p className="empty">这个项目还没有卡片。</p>
        ) : (
          <>
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
            <section aria-label="阻塞事项">
              <h2>阻塞事项（{data.blocked.length}）</h2>
              {!data.blocked.length && <p className="hint">没有阻塞。</p>}
              <ul>
                {data.blocked.map((b) => (
                  <li key={`${b.card_id}/${b.work_item_id}/${b.label}`}>
                    <CardLink projectId={projectId} id={b.card_id} /> ·{" "}
                    {b.label}
                  </li>
                ))}
              </ul>
            </section>
            <section aria-label="最近交付">
              <h2>最近交付</h2>
              {!data.recent_deliveries.length && (
                <p className="hint">暂无交付。</p>
              )}
              <ul>
                {data.recent_deliveries.map((d) => (
                  <li key={d.id}>
                    <CardLink projectId={projectId} id={d.card_id} /> · {d.id} ·{" "}
                    {d.summary}{" "}
                    <span className="status">
                      {(
                        {
                          submitted: "待审核",
                          accepted: "已接受",
                          rejected: "已驳回",
                          superseded: "已取代",
                        } as Record<string, string>
                      )[d.status] ?? d.status}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </>
        ))}
    </section>
  );
}
