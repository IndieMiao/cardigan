import { useCallback } from "react";
import type { CardiganClient, CardView, SnapshotData } from "../api.js";
import { NextOwners } from "../components/EmployeeIdentity.js";
import { FilterSelect } from "../components/FilterSelect.js";
import {
  EmptyState,
  IdTag,
  StatusTag,
  Time,
} from "../components/Foundation.js";
import { GroupedTableBody } from "../components/GroupedTableBody.js";
import { DataTableLayout } from "../components/layout/DataTableLayout.js";
import { PageHeader } from "../components/layout/PageHeader.js";
import { PageStat, PageStats } from "../components/layout/PageStatsLayout.js";
import { CardLink, Feedback } from "../components/Operations.js";
import { PageToolbar } from "../components/PageToolbar.js";
import { RefreshGroup } from "../components/RefreshGroup.js";
import { Tooltip } from "../components/Tooltip.js";
import { SearchInput } from "../components/ui/input.js";
import {
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.js";
import { routeHash, useRouteFilters } from "../route.js";
import { SNAPSHOT_GROUPS } from "../snapshot-groups.js";
import { useRefreshInterval } from "../useRefreshInterval.js";
import { useResource } from "../useResource.js";

type Group = (typeof SNAPSHOT_GROUPS)[number]["value"];
interface SnapshotRow {
  readonly group: Group;
  readonly key: string;
  readonly cardId: string;
  readonly card: CardView | undefined;
  /** Card reason, or the blocked work item's label. */
  readonly reason: string;
}
const groupLabel = (group: string) =>
  SNAPSHOT_GROUPS.find((g) => g.value === group)?.label ?? group;
const groupOptions = SNAPSHOT_GROUPS.map(({ value, label }) => ({
  value,
  label,
}));

/** The existing sections in their existing order; groups may overlap. */
function snapshotRows(data: SnapshotData): SnapshotRow[] {
  const byId = new Map(data.cards.map((card) => [card.id, card]));
  const cardRows = (group: Group, cards: readonly CardView[]) =>
    cards.map((card) => ({
      group,
      key: `${group}/${card.id}`,
      cardId: card.id,
      card,
      reason: card.why,
    }));
  return [
    ...cardRows(
      "human",
      data.cards.filter((c) => data.waiting.human.includes(c.id)),
    ),
    ...cardRows(
      "agent",
      data.cards.filter((c) => data.waiting.agent.includes(c.id)),
    ),
    ...cardRows("progress", data.in_progress),
    ...cardRows("review", data.in_review),
    ...data.blocked.map((b) => ({
      group: "blocked" as const,
      key: `blocked/${b.card_id}/${b.work_item_id}/${b.label}`,
      cardId: b.card_id,
      card: byId.get(b.card_id),
      reason: b.label,
    })),
  ];
}
const matches = (query: string, ...values: (string | null | undefined)[]) =>
  !query || values.some((value) => value?.toLocaleLowerCase().includes(query));

export function SnapshotPage({
  client,
  projectId,
  revision = 0,
}: {
  client: CardiganClient;
  projectId: string;
  revision?: number;
}) {
  const [filters, setFilters] = useRouteFilters({
    kind: "snapshot",
    projectId,
  });
  const load = useCallback(
    () => client.snapshot(projectId),
    [client, projectId],
  );
  const { data, pending, error, reload, refresh, interactive } = useResource(
    load,
    revision,
  );
  const [interval, setRefreshInterval] = useRefreshInterval(
    `cardigan.snapshot.refresh.${projectId}`,
    pending,
    refresh,
  );
  const query = filters.q?.trim().toLocaleLowerCase() ?? "";
  const group = filters.group ?? "";
  const filtered = Boolean(query || group);
  const allRows = data ? snapshotRows(data) : [];
  const rows = allRows.filter(
    (row) =>
      (!group || row.group === group) &&
      matches(query, row.cardId, row.card?.title, row.reason),
  );
  const titleOf = (id: string | null) =>
    data?.cards.find((c) => c.id === id)?.title;
  const deliveries = (group ? [] : (data?.recent_deliveries ?? [])).filter(
    (d) =>
      matches(
        query,
        d.id,
        d.card_id,
        titleOf(d.card_id),
        d.work_item_id,
        d.work_item_title,
        d.summary,
      ),
  );
  const empty =
    data &&
    (!data.cards.length
      ? "没有卡片"
      : rows.length + deliveries.length === 0
        ? filtered
          ? "没有匹配的卡片"
          : "没有进行中的工作"
        : undefined);
  return (
    <section className="ui-workspace" aria-label="项目快照">
      <PageHeader
        title="项目快照"
        actions={data && <Overview data={data} projectId={projectId} />}
      />
      <PageToolbar
        fields={[
          {
            key: "group",
            label: "分组",
            options: groupOptions,
            render: (value, setValue) => (
              <FilterSelect
                label="分组"
                value={value}
                options={groupOptions}
                onChange={setValue}
              />
            ),
          },
          {
            key: "q",
            label: "搜索",
            grow: true,
            render: (value, setValue) => (
              <SearchInput
                aria-label="搜索标题或编号"
                placeholder="搜索标题或编号"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            ),
          },
        ]}
        values={filters}
        onChange={setFilters}
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
      {empty && <EmptyState>{empty}</EmptyState>}
      {data && rows.length > 0 && (
        <DataTableLayout records label="卡片分组">
          <TableHeader>
            <TableRow>
              <TableHead>编号</TableHead>
              <TableHead>标题</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>下一步</TableHead>
              <TableHead>原因</TableHead>
            </TableRow>
          </TableHeader>
          <GroupedTableBody
            rows={rows}
            groupBy={(row) => row.group}
            groupName={(g) => groupLabel(g.id)}
            columns={5}
            countLabel="项"
            renderRow={(row) => (
              <TableRow key={row.key}>
                <TableCell data-record="lead">
                  <IdTag
                    id={row.cardId}
                    label="卡片"
                    href={routeHash({
                      kind: "card",
                      projectId,
                      cardId: row.cardId,
                    })}
                    {...(row.card ? { detail: row.card.title } : {})}
                  />
                </TableCell>
                <TableCell>
                  {row.card ? (
                    <a
                      className="ui-data-title"
                      href={routeHash({
                        kind: "card",
                        projectId,
                        cardId: row.cardId,
                      })}
                    >
                      {row.card.title}
                    </a>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell data-nowrap="">
                  {row.card ? <StatusTag status={row.card.status} /> : "—"}
                </TableCell>
                <TableCell data-label="下一步">
                  {row.card?.next_owners.length ? (
                    <NextOwners owners={row.card.next_owners} />
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell data-label="原因">{row.reason || "—"}</TableCell>
              </TableRow>
            )}
          />
        </DataTableLayout>
      )}
      {deliveries.length > 0 && (
        <DataTableLayout records label="最近交付">
          <TableHeader>
            <TableRow>
              <TableHead>卡片</TableHead>
              <TableHead>工作项</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>提交时间</TableHead>
              <TableHead>摘要</TableHead>
            </TableRow>
          </TableHeader>
          <GroupedTableBody
            rows={deliveries}
            groupBy={() => "recent"}
            groupName={() => "最近交付"}
            columns={5}
            countLabel="项"
            renderRow={(d) => (
              <TableRow key={d.id}>
                <TableCell data-record="lead">
                  <CardLink
                    projectId={projectId}
                    id={d.card_id}
                    label={titleOf(d.card_id) ?? "卡片"}
                  />
                </TableCell>
                <TableCell>
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
                </TableCell>
                <TableCell data-nowrap="">
                  <StatusTag status={d.status} />
                </TableCell>
                <TableCell data-label="提交时间" data-nowrap="">
                  <Time value={d.submitted_at} />
                </TableCell>
                <TableCell>
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
                  />{" "}
                  {d.summary}
                </TableCell>
              </TableRow>
            )}
          />
        </DataTableLayout>
      )}
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
    <PageStats aria-label="项目概览">
      {SNAPSHOT_GROUPS.map((group) => (
        <Tooltip
          key={group.value}
          content={
            group.value === "blocked"
              ? "有等待审核或阻塞的工作项，按卡片计数"
              : "按卡片计数，各分组可能重叠"
          }
        >
          <PageStat
            href={routeHash({
              kind: "cards",
              projectId,
              filters: { view: "list", overview: group.value },
            })}
            label={group.label}
            value={counts[group.value]}
          />
        </Tooltip>
      ))}
    </PageStats>
  );
}
