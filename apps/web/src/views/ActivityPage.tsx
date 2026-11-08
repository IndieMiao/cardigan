import { useCallback } from "react";
import type { CardiganClient } from "../api.js";
import { FilterBar } from "../components/FilterBar.js";
import {
  EmptyState,
  IdTag,
  PageTitle,
  Time,
} from "../components/Foundation.js";
import { CardLink, Feedback } from "../components/Operations.js";
import { EVENT_LABELS, eventLabel } from "../events.js";
import { useRouteFilters } from "../route.js";
import { useResource } from "../useResource.js";

export function ActivityPage({
  client,
  projectId,
  revision = 0,
}: {
  client: CardiganClient;
  projectId: string;
  revision?: number;
}) {
  const [filters, setFilters] = useRouteFilters({
    kind: "activity",
    projectId,
  });
  const load = useCallback(
    () => client.activity(projectId, filters),
    [client, projectId, filters],
  );
  const { data, pending, error, reload } = useResource(load, revision);
  return (
    <section aria-label="项目动态">
      <PageTitle
        title="项目动态"
        description="查看发生了什么，展开事件可核对原始记录。"
      />
      <FilterBar
        fields={[
          { key: "card_id", label: "卡片编号" },
          {
            key: "role",
            label: "角色",
            options: ["human", "pm", "coder", "reviewer", "system"].map(
              (value) => ({
                value,
                label:
                  value === "human"
                    ? "你"
                    : value === "system"
                      ? "系统"
                      : value,
              }),
            ),
          },
          {
            key: "type",
            label: "事件类型",
            options: Object.entries(EVENT_LABELS).map(([value, label]) => ({
              value,
              label,
            })),
          },
        ]}
        values={filters}
        onChange={(next) => setFilters({ ...next, before: "" })}
      >
        <button type="button" className="quiet" onClick={() => setFilters({})}>
          清除筛选
        </button>
      </FilterBar>
      <Feedback pending={pending} error={error} retry={reload} />
      {data && (
        <>
          <p className="metadata">
            <span>{filters.before ? "正在查看更早的事件" : "最新事件"}</span>
            <span>本页：{data.counts.returned} 条</span>
          </p>
          {!data.events.length && (
            <EmptyState>
              没有符合条件的事件。调整筛选，或等待新的项目动态。
            </EmptyState>
          )}
          {data.events.map((e) => (
            <details key={e.id} className="event-details">
              <summary className="metadata">
                <Time value={e.created_at} />
                <span>{eventLabel(e.type)}</span>
                <span>
                  发起者：
                  {e.role === "human"
                    ? "你"
                    : e.role === "system"
                      ? "系统"
                      : e.role}
                </span>
                <span>
                  {e.card_id ? (
                    <IdTag id={e.card_id} label="卡片" />
                  ) : (
                    "项目级事件"
                  )}
                </span>
              </summary>
              <p className="metadata">
                <CardLink projectId={projectId} id={e.card_id} />
                {e.actor.assignment_id && (
                  <IdTag id={e.actor.assignment_id} label={e.role} />
                )}
                <span>流内序号：{e.seq}</span>
                <span>事件编号：{e.id}</span>
                <span>原始类型：{e.type}</span>
              </p>
              <pre>{JSON.stringify(e.payload, null, 2)}</pre>
            </details>
          ))}
          <div className="action-row">
            <button
              type="button"
              className="quiet"
              disabled={pending || !data.next_before}
              onClick={() => {
                if (data.next_before)
                  setFilters({ ...filters, before: data.next_before });
              }}
            >
              更早的事件
            </button>
            {filters.before && (
              <button
                type="button"
                onClick={() => setFilters({ ...filters, before: "" })}
              >
                返回最新
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
