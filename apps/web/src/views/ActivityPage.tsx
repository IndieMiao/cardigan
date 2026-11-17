import { useCallback } from "react";
import type { ActivityData, CardiganClient } from "../api.js";
import { EmployeeIdentity } from "../components/EmployeeIdentity.js";
import { FilterBar } from "../components/FilterBar.js";
import { EmptyState, PageTitle, Time } from "../components/Foundation.js";
import { IdentityRow } from "../components/IdentityRow.js";
import { CardLink, Feedback } from "../components/Operations.js";
import { eventLabel } from "../events.js";
import { useRouteFilters } from "../route.js";
import { useResource } from "../useResource.js";

const ACTOR_LABELS: Readonly<Record<string, string>> = {
  human: "所有者",
  pm: "PM",
  agent: "Agent",
  system: "系统",
};
const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  delivery: "交付",
  review: "审核",
  decision: "拍板",
  comment: "评论与指令",
  run: "运行",
  merge: "合并与清理",
  other: "其他",
};
const RANGE_LABELS: Readonly<Record<string, string>> = {
  "24h": "最近 24 小时",
  "7d": "最近 7 天",
  "30d": "最近 30 天",
};
const dayKey = (value: string): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const dayLabel = (key: string): string => {
  if (key === "时间未知") return key;
  const [year, month, day] = key.split("-").map(Number);
  const current = new Date().getFullYear();
  return `${year === current ? "" : `${year} 年 `}${month} 月 ${day} 日`;
};
type ActivityEvent = ActivityData["events"][number];
const AUDIT_TARGET_PREVIEW_LIMIT = 3;
const isCardId = (value: unknown): value is string =>
  typeof value === "string" && /^C-\d+$/.test(value);

function auditTargets(audit: Record<string, unknown> | undefined): string[] {
  if (isCardId(audit?.card_id)) return [audit.card_id];
  if (
    Array.isArray(audit?.card_ids) &&
    audit.card_ids.length > 0 &&
    audit.card_ids.every(isCardId)
  )
    return [...new Set(audit.card_ids)];
  return [];
}
type Row =
  | { readonly kind: "event"; readonly event: ActivityEvent }
  | {
      readonly kind: "system";
      readonly type: string;
      readonly card_id: string | null;
      readonly card_title: string | null;
      readonly events: readonly ActivityEvent[];
    };
/** Collapse adjacent system events of the same type and card into one row. */
function rowsOf(events: readonly ActivityEvent[]): Row[] {
  const rows: Row[] = [];
  for (const event of events) {
    const previous = rows.at(-1);
    if (
      event.actor.kind === "system" &&
      previous?.kind === "system" &&
      previous.type === event.type &&
      previous.card_id === event.card_id
    ) {
      rows[rows.length - 1] = {
        ...previous,
        events: [...previous.events, event],
      };
      continue;
    }
    if (
      event.actor.kind === "system" &&
      previous?.kind === "event" &&
      previous.event.actor.kind === "system" &&
      previous.event.type === event.type &&
      previous.event.card_id === event.card_id
    ) {
      rows[rows.length - 1] = {
        kind: "system",
        type: event.type,
        card_id: event.card_id,
        card_title: event.card_title,
        events: [previous.event, event],
      };
      continue;
    }
    rows.push({ kind: "event", event });
  }
  return rows;
}
function groupedLabel(type: string, count: number): string {
  const label = eventLabel(type);
  if (label.includes("了 ")) return label.replace("了 ", `了 ${count} 个 `);
  for (const [prefix, suffix] of [
    ["开始一次 ", "开始"],
    ["结束一次 ", "结束"],
    ["派发一次 ", "派发"],
    ["排队一次 ", "排队"],
  ] as const)
    if (label.startsWith(prefix))
      return `${suffix} ${count} 次 ${label.slice(prefix.length)}`;
  return `${label} ${count} 次`;
}
function DayGroup({
  day,
  events,
  projectId,
}: {
  readonly day: string;
  readonly events: readonly ActivityEvent[];
  readonly projectId: string;
}) {
  return (
    <section className="activity-day" aria-label={dayLabel(day)}>
      <h2>{dayLabel(day)}</h2>
      <ol className="activity-list">
        {rowsOf(events).map((row) => {
          if (row.kind === "event") {
            const event = row.event;
            const audit =
              event.type === "cross_card_read" &&
              event.payload !== null &&
              typeof event.payload === "object"
                ? (event.payload as Record<string, unknown>)
                : undefined;
            const targets = auditTargets(audit);
            return (
              <li key={event.id}>
                <details className="event-details">
                  <IdentityRow as="summary" className="activity-summary">
                    <span className="activity-time">
                      <Time value={event.created_at} />
                    </span>
                    <EmployeeIdentity
                      {...event}
                      author={event.actor.kind}
                      author_role={event.role}
                      showTitle={false}
                    />
                    <span className="activity-action">
                      {eventLabel(event.type)}
                      {typeof audit?.tool === "string" && audit.tool && (
                        <span className="activity-audit-tool">
                          工具：{audit.tool}
                        </span>
                      )}
                    </span>
                    <span className="activity-card">
                      {targets.length > 0 ? (
                        <>
                          {targets
                            .slice(0, AUDIT_TARGET_PREVIEW_LIMIT)
                            .map((id) => (
                              <CardLink
                                key={id}
                                projectId={projectId}
                                id={id}
                                label={targets.length === 1 ? "目标卡片" : ""}
                              />
                            ))}
                          {targets.length > AUDIT_TARGET_PREVIEW_LIMIT && (
                            <span>等 {targets.length} 张卡片</span>
                          )}
                        </>
                      ) : (
                        <CardLink
                          projectId={projectId}
                          id={event.card_id}
                          label={event.card_title ?? "卡片"}
                        />
                      )}
                    </span>
                  </IdentityRow>
                  <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                </details>
              </li>
            );
          }
          const first = row.events[0];
          return (
            <li key={first?.id}>
              <details className="event-details">
                <IdentityRow as="summary" className="activity-summary">
                  <span className="activity-time">
                    <Time value={first?.created_at} />
                  </span>
                  <EmployeeIdentity author="system" showTitle={false} />
                  <span className="activity-action">
                    {groupedLabel(row.type, row.events.length)}
                  </span>
                  <span className="activity-card">
                    <CardLink
                      projectId={projectId}
                      id={row.card_id}
                      label={row.card_title ?? "卡片"}
                    />
                  </span>
                </IdentityRow>
                <pre>
                  {JSON.stringify(
                    row.events.map((event) => event.payload),
                    null,
                    2,
                  )}
                </pre>
              </details>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
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
  const { data, pending, error, reload, interactive } = useResource(
    load,
    revision,
  );
  const days = new Map<string, ActivityEvent[]>();
  for (const event of data?.events ?? []) {
    const key = dayKey(event.created_at);
    days.set(key, [...(days.get(key) ?? []), event]);
  }
  return (
    <section className="activity-page" aria-label="项目动态">
      <PageTitle title="项目动态" />
      <FilterBar
        fields={[
          {
            key: "card_id",
            label: "卡片",
            options: (data?.cards ?? []).map((card) => ({
              value: card.id,
              label: `${card.id} ${card.title}`,
            })),
          },
          {
            key: "actor",
            label: "发言方",
            options: Object.entries(ACTOR_LABELS).map(([value, label]) => ({
              value,
              label,
            })),
          },
          {
            key: "category",
            label: "事件类别",
            options: Object.entries(CATEGORY_LABELS).map(([value, label]) => ({
              value,
              label,
            })),
          },
          {
            key: "range",
            label: "时间范围",
            options: Object.entries(RANGE_LABELS).map(([value, label]) => ({
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
      <Feedback
        pending={pending}
        interactive={interactive}
        error={error}
        retry={reload}
      />
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
          {[...days].map(([day, events]) => (
            <DayGroup
              key={day}
              day={day}
              events={events}
              projectId={projectId}
            />
          ))}
          {data.events.length > 0 && !data.next_before && (
            <p className="pagination-end" role="status">
              已经到底了
            </p>
          )}
          <div className="action-row">
            {data.next_before && (
              <button
                type="button"
                className="quiet"
                disabled={pending}
                onClick={() => {
                  if (data.next_before)
                    setFilters({ ...filters, before: data.next_before });
                }}
              >
                更早的事件
              </button>
            )}
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
