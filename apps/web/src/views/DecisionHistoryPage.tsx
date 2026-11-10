import { useCallback } from "react";
import type { CardiganClient } from "../api.js";
import { EmployeeIdentity } from "../components/EmployeeIdentity.js";
import {
  EmptyState,
  PageTitle,
  StatusTag,
  Time,
} from "../components/Foundation.js";
import { CardLink, Markdown } from "../components/Operations.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { categoryLabels } from "../decision-labels.js";
import { useRouteFilters } from "../route.js";
import { useResource } from "../useResource.js";

export function DecisionHistoryPage({
  client,
  projectId,
  revision = 0,
}: {
  client: CardiganClient;
  projectId: string;
  revision?: number;
}) {
  const [filters, setFilters] = useRouteFilters({
    kind: "decision-history",
    projectId,
  });
  const load = useCallback(
    () =>
      client.decisionHistory(projectId, {
        ...filters,
        ...(filters.from
          ? { from: new Date(`${filters.from}T00:00:00`).toISOString() }
          : {}),
        ...(filters.to
          ? { to: new Date(`${filters.to}T23:59:59.999`).toISOString() }
          : {}),
      }),
    [client, projectId, filters],
  );
  const resource = useResource(load, revision);
  const select = (name: string, value: string) =>
    setFilters({ ...filters, [name]: value });
  const makerLabels = { human: "所有者", pm: "PM 代拍", system: "系统代批" };
  return (
    <section>
      <PageTitle
        title="拍板记录"
        description="查询已解决的拍板、所选方案及授权依据。"
      />
      <div className="filter-bar">
        <label>
          决策人
          <select
            value={filters.decider ?? ""}
            onChange={(e) => select("decider", e.target.value)}
          >
            <option value="">全部</option>
            {Object.entries(makerLabels).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          类别
          <select
            value={filters.category ?? ""}
            onChange={(e) => select("category", e.target.value)}
          >
            <option value="">全部</option>
            {Object.entries(categoryLabels).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          卡片
          <input
            placeholder="C-1"
            value={filters.card_id ?? ""}
            onChange={(e) => select("card_id", e.target.value)}
          />
        </label>
        <label>
          开始日期
          <input
            type="date"
            value={filters.from ?? ""}
            onChange={(e) => select("from", e.target.value)}
          />
        </label>
        <label>
          结束日期
          <input
            type="date"
            value={filters.to ?? ""}
            onChange={(e) => select("to", e.target.value)}
          />
        </label>
      </div>
      <RequestFeedback
        {...resource}
        retry={resource.reload}
        pendingMessage="正在加载拍板记录…"
      />
      {resource.data?.decisions.length === 0 && (
        <EmptyState>没有符合条件的拍板记录</EmptyState>
      )}
      {resource.data?.decisions.map((q) => (
        <article
          key={q.id}
          className="needs-item"
          aria-label={`拍板记录 ${q.id}`}
        >
          <h2>
            {q.id} · {q.question}
          </h2>
          {q.status !== "resolved" && <StatusTag status={q.status} />}
          <p>
            {makerLabels[q.decision_maker]} ·{" "}
            {categoryLabels[q.category] ?? q.category} ·{" "}
            <Time value={q.resolution.at} />
          </p>
          <p>
            {[
              ...new Set([
                ...(q.card_id ? [q.card_id] : []),
                ...q.affected_cards,
              ]),
            ].map((id) => (
              <CardLink key={id} projectId={projectId} id={id} />
            ))}
          </p>
          <p>
            所选方案：
            {q.options.find((o) => o.key === q.resolution.option)
              ?.description ?? q.resolution.option}
          </p>
          <p>
            影响：{q.options.find((o) => o.key === q.resolution.option)?.impact}
          </p>
          <Markdown body={`理由：${q.resolution.rationale}`} />
          <p>
            记录人：
            <EmployeeIdentity
              {...q.resolution}
              author={q.resolution.resolved_by}
            />
          </p>
          {q.resolution.proxy_authority && (
            <p>授权依据：{q.resolution.proxy_authority}</p>
          )}
        </article>
      ))}
    </section>
  );
}
