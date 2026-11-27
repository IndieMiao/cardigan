import { Fragment, useCallback, useId, useState } from "react";
import type { ActivityData, CardiganClient } from "../api.js";
import { EmployeeIdentity } from "../components/EmployeeIdentity.js";
import { FilterSelect } from "../components/FilterSelect.js";
import { EmptyState, Time } from "../components/Foundation.js";
import { GroupedTableBody } from "../components/GroupedTableBody.js";
import {
  DataTableCell,
  DataTableDetail,
  DataTableLayout,
} from "../components/layout/DataTableLayout.js";
import { PageHeader } from "../components/layout/PageHeader.js";
import { CardLink, Feedback } from "../components/Operations.js";
import { PageToolbar } from "../components/PageToolbar.js";
import { RefreshGroup } from "../components/RefreshGroup.js";
import { Button } from "../components/ui/button.js";
import {
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.js";
import { eventLabel } from "../events.js";
import { useRouteFilters } from "../route.js";
import { useRefreshInterval } from "../useRefreshInterval.js";
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
const options = (labels: Readonly<Record<string, string>>) =>
  Object.entries(labels).map(([value, label]) => ({ value, label }));
const COLUMNS = 5;

function ActivityRow({
  row,
  projectId,
  open,
  onToggle,
}: {
  readonly row: Row;
  readonly projectId: string;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const detailId = useId();
  const first = row.kind === "event" ? row.event : row.events[0];
  const audit =
    row.kind === "event" &&
    row.event.type === "cross_card_read" &&
    row.event.payload !== null &&
    typeof row.event.payload === "object"
      ? (row.event.payload as Record<string, unknown>)
      : undefined;
  // Deployment notices are project-scoped; this feed is their timeline.
  const closeReasons = (
    row.kind === "event" ? [row.event] : row.events
  ).flatMap((event) => {
    const p = event.payload as { source?: string; reason?: string } | null;
    return event.type === "human_action_cancelled" &&
      event.actor.kind === "system" &&
      (p?.source === "supervisor_rechecked" ||
        p?.source === "storage_rechecked") &&
      typeof p.reason === "string"
      ? [p.reason]
      : [];
  });
  const targets = auditTargets(audit);
  const cardId = row.kind === "event" ? row.event.card_id : row.card_id;
  const cardTitle =
    row.kind === "event" ? row.event.card_title : row.card_title;
  return (
    <>
      <TableRow data-activity-row="">
        <DataTableCell data-record="lead" nowrap>
          <Time value={first?.created_at} />
        </DataTableCell>
        <TableCell>
          {row.kind === "event" ? (
            <EmployeeIdentity
              {...row.event}
              author={row.event.actor.kind}
              author_role={row.event.role}
              showTitle={false}
            />
          ) : (
            <EmployeeIdentity author="system" showTitle={false} />
          )}
        </TableCell>
        <TableCell>
          {row.kind === "event"
            ? eventLabel(row.event.type)
            : groupedLabel(row.type, row.events.length)}
          {[...new Set(closeReasons)].map((reason) => (
            <div key={reason}>{reason}</div>
          ))}
          {typeof audit?.tool === "string" && audit.tool && (
            <div>工具：{audit.tool}</div>
          )}
        </TableCell>
        <TableCell>
          {targets.length > 0 ? (
            <>
              {targets.slice(0, AUDIT_TARGET_PREVIEW_LIMIT).map((id, i) => (
                <Fragment key={id}>
                  {i > 0 && " "}
                  <CardLink
                    projectId={projectId}
                    id={id}
                    label={targets.length === 1 ? "目标卡片" : ""}
                  />
                </Fragment>
              ))}
              {targets.length > AUDIT_TARGET_PREVIEW_LIMIT && (
                <span> 等 {targets.length} 张卡片</span>
              )}
            </>
          ) : (
            <CardLink
              projectId={projectId}
              id={cardId}
              label={cardTitle ?? "卡片"}
            />
          )}
        </TableCell>
        <TableCell data-record="aside">
          <Button
            type="button"
            className="quiet"
            aria-expanded={open}
            aria-controls={detailId}
            onClick={onToggle}
          >
            {open ? "收起" : "详情"}
          </Button>
        </TableCell>
      </TableRow>
      <TableRow id={detailId} hidden={!open}>
        <TableCell colSpan={COLUMNS}>
          <DataTableDetail>
            {JSON.stringify(
              row.kind === "event"
                ? row.event.payload
                : row.events.map((event) => event.payload),
              null,
              2,
            )}
          </DataTableDetail>
        </TableCell>
      </TableRow>
    </>
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
  const { data, pending, error, reload, refresh, interactive } = useResource(
    load,
    revision,
  );
  const [interval, setRefreshInterval] = useRefreshInterval(
    `cardigan.activity.refresh.${projectId}`,
    pending,
    refresh,
  );
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpened((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const days = new Map<string, ActivityEvent[]>();
  for (const event of data?.events ?? []) {
    const key = dayKey(event.created_at);
    days.set(key, [...(days.get(key) ?? []), event]);
  }
  // System runs collapse within a day only, as before.
  const rows = [...days].flatMap(([day, events]) =>
    rowsOf(events).map((row) => ({ day, row })),
  );
  const rowId = (row: Row) =>
    (row.kind === "event" ? row.event.id : row.events[0]?.id) ?? "";
  const filtered = Object.entries(filters).some(
    ([key, value]) => key !== "before" && value,
  );
  const cardOptions = (data?.cards ?? []).map((card) => ({
    value: card.id,
    label: `${card.id} ${card.title}`,
  }));
  const select = (
    key: string,
    label: string,
    choices: readonly { value: string; label: string }[],
  ) => ({
    key,
    label,
    options: choices,
    render: (value: string, setValue: (value: string) => void) => (
      <FilterSelect
        label={label}
        value={value}
        options={choices}
        onChange={setValue}
      />
    ),
  });
  return (
    <section className="ui-workspace" aria-label="项目动态">
      <PageHeader title="项目动态" />
      <PageToolbar
        fields={[
          select("card_id", "卡片", cardOptions),
          select("actor", "发言方", options(ACTOR_LABELS)),
          select("category", "事件类别", options(CATEGORY_LABELS)),
          select("range", "时间范围", options(RANGE_LABELS)),
          ...(filtered
            ? [
                {
                  key: "clear",
                  label: "清除筛选",
                  render: () => (
                    <Button
                      type="button"
                      className="quiet"
                      onClick={() => setFilters({})}
                    >
                      清除筛选
                    </Button>
                  ),
                },
              ]
            : []),
        ]}
        values={filters}
        onChange={(next) => setFilters({ ...next, before: "" })}
      >
        <RefreshGroup
          interval={interval}
          onIntervalChange={setRefreshInterval}
          pending={pending}
          onRefresh={reload}
        />
      </PageToolbar>
      <Feedback
        pending={pending}
        interactive={interactive}
        error={error}
        retry={reload}
      />
      {data && (
        <>
          {data.events.length === 0 ? (
            <EmptyState>{filtered ? "没有匹配的事件" : "没有事件"}</EmptyState>
          ) : (
            <DataTableLayout records label="事件列表">
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>发言方</TableHead>
                  <TableHead>事件</TableHead>
                  <TableHead>卡片</TableHead>
                  <TableHead>详情</TableHead>
                </TableRow>
              </TableHeader>
              <GroupedTableBody
                rows={rows}
                groupBy={(entry) => entry.day}
                groupName={(group) => dayLabel(group.id)}
                columns={COLUMNS}
                countLabel="条"
                renderRow={({ row }) => (
                  <ActivityRow
                    key={rowId(row)}
                    row={row}
                    projectId={projectId}
                    open={opened.has(rowId(row))}
                    onToggle={() => toggle(rowId(row))}
                  />
                )}
              />
            </DataTableLayout>
          )}
          <nav
            className="timeline-controls card-list-pagination ui-inline-items"
            aria-label="动态分页"
          >
            <span className="timeline-count">
              {filters.before ? "更早的事件" : "最新事件"} · 本页{" "}
              {data.counts.returned} 条
            </span>
            {data.events.length > 0 && !data.next_before && (
              <span role="status">已经到底了</span>
            )}
            {filters.before && (
              <Button
                type="button"
                className="quiet"
                onClick={() => setFilters({ ...filters, before: "" })}
              >
                返回最新
              </Button>
            )}
            {data.next_before && (
              <Button
                type="button"
                className="quiet"
                disabled={pending}
                onClick={() => {
                  if (data.next_before)
                    setFilters({ ...filters, before: data.next_before });
                }}
              >
                更早的事件
              </Button>
            )}
          </nav>
        </>
      )}
    </section>
  );
}
