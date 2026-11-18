import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CardiganClient,
  type DecisionHistoryRecord,
  describeError,
} from "../api.js";
import {
  DecisionHistoryDetail,
  decisionCards,
  decisionMakerLabels,
} from "../components/DecisionHistoryDetail.js";
import { Drawer } from "../components/Drawer.js";
import { EmployeeIdentity } from "../components/EmployeeIdentity.js";
import { FilterDate } from "../components/FilterDate.js";
import { FilterSelect } from "../components/FilterSelect.js";
import {
  EmptyState,
  IdTag,
  StatusTag,
  Time,
} from "../components/Foundation.js";
import { IdBadge } from "../components/IdTag.js";
import { cardDetailDrawerClassName } from "../components/layout/CardDetailLayout.js";
import {
  DataTableCell,
  DataTableLayout,
} from "../components/layout/DataTableLayout.js";
import { PageHeader } from "../components/layout/PageHeader.js";
import { CardLink } from "../components/Operations.js";
import { PageToolbar } from "../components/PageToolbar.js";
import {
  DEFAULT_REFRESH_INTERVAL,
  REFRESH_INTERVALS,
  RefreshGroup,
} from "../components/RefreshGroup.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { Button } from "../components/ui/button.js";
import { SearchInput } from "../components/ui/input.js";
import {
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.js";
import {
  categoryLabels,
  decisionOption,
  decisionTitle,
} from "../decision-labels.js";
import { routeHash, useRouteFilters } from "../route.js";
import { useResource } from "../useResource.js";

const PAGE_SIZE = 10;
/** Route keys sent to the server; `decision` only selects the open drawer. */
const QUERY_KEYS = ["decider", "category", "card_id", "from", "to"] as const;
const makerOptions = Object.entries(decisionMakerLabels).map(
  ([value, label]) => ({ value, label }),
);
const categoryOptions = Object.entries(categoryLabels).map(
  ([value, label]) => ({ value, label }),
);

/** First page wins on refresh; later pages only add rows it does not have. */
function mergeRecords(
  first: readonly DecisionHistoryRecord[],
  later: readonly DecisionHistoryRecord[],
) {
  const seen = new Set(first.map((q) => q.id));
  return [...first, ...later.filter((q) => !seen.has(q.id))];
}

/** Same order as the server: newest resolution first, then higher id. */
function isNewer(a: DecisionHistoryRecord, b: DecisionHistoryRecord) {
  return a.resolution.at !== b.resolution.at
    ? a.resolution.at > b.resolution.at
    : a.id > b.id;
}

function readRefresh(key: string) {
  try {
    const raw = localStorage.getItem(key);
    const value = raw === null ? DEFAULT_REFRESH_INTERVAL : Number(raw);
    return REFRESH_INTERVALS.some((interval) => interval === value)
      ? value
      : DEFAULT_REFRESH_INTERVAL;
  } catch {
    return DEFAULT_REFRESH_INTERVAL;
  }
}

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
  const query = JSON.stringify(
    Object.fromEntries(
      QUERY_KEYS.filter((key) => filters[key]).map((key) => [
        key,
        filters[key],
      ]),
    ),
  );
  const fetchPage = useCallback(
    (cursor?: string) => {
      const selected: Record<string, string> = JSON.parse(query);
      return client.decisionHistory(
        projectId,
        {
          ...selected,
          ...(selected.from
            ? { from: new Date(`${selected.from}T00:00:00`).toISOString() }
            : {}),
          ...(selected.to
            ? { to: new Date(`${selected.to}T23:59:59.999`).toISOString() }
            : {}),
        },
        ...(cursor ? [cursor] : []),
      );
    },
    [client, projectId, query],
  );
  // The oldest record shown once "加载更多" was used, for this filter set.
  const boundary = useRef<{
    source: typeof fetchPage;
    record: DecisionHistoryRecord;
  }>(undefined);
  // A refresh re-reads the whole loaded range, from the newest record down to
  // that boundary, so records pushed off the first page by new decisions are
  // not skipped. Changing any filter starts over at the newest 10.
  const load = useCallback(async () => {
    const until =
      boundary.current?.source === fetchPage
        ? boundary.current.record
        : undefined;
    let page = await fetchPage();
    const decisions = [...page.decisions];
    while (until && page.next_cursor) {
      const last = decisions.at(-1);
      if (!last || !isNewer(last, until)) break;
      page = await fetchPage(page.next_cursor);
      decisions.push(...page.decisions);
    }
    return { decisions, next_cursor: page.next_cursor };
  }, [fetchPage]);
  const resource = useResource(load, revision);
  const { pending, reload } = resource;
  const refreshKey = `cardigan.decision-history.refresh.${projectId}`;
  const [refreshChoice, setRefreshChoice] = useState(() => ({
    key: refreshKey,
    value: readRefresh(refreshKey),
  }));
  const interval =
    refreshChoice.key === refreshKey
      ? refreshChoice.value
      : readRefresh(refreshKey);
  // Pages appended by "加载更多" extend the range of one load result; the
  // next refresh result already covers them.
  const first = resource.data;
  const [extra, setExtra] = useState<{
    base: typeof first;
    items: readonly DecisionHistoryRecord[];
    cursor: string | null;
  }>();
  const pages = first && extra?.base === first ? extra : undefined;
  const visible = mergeRecords(first?.decisions ?? [], pages?.items ?? []);
  const cursor = pages ? pages.cursor : (first?.next_cursor ?? null);
  const oldest = visible.at(-1);
  boundary.current =
    visible.length > PAGE_SIZE && oldest
      ? { source: fetchPage, record: oldest }
      : undefined;
  const loading = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState("");
  const more = async () => {
    if (loading.current || !cursor || !first) return;
    loading.current = true;
    setLoadingMore(true);
    setMoreError("");
    try {
      const page = await fetchPage(cursor);
      setExtra((old) => ({
        base: first,
        items: [...(old?.base === first ? old.items : []), ...page.decisions],
        cursor: page.next_cursor,
      }));
    } catch (cause) {
      setMoreError(describeError(cause));
    } finally {
      loading.current = false;
      setLoadingMore(false);
    }
  };
  // A refresh replaces the first page, so it must not race an appended page.
  const busy = pending || loadingMore;
  useEffect(() => {
    if (!interval || busy) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) reload();
    }, interval);
    return () => window.clearInterval(timer);
  }, [interval, busy, reload]);
  const openId = filters.decision;
  const selected = visible.find((q) => q.id === openId);
  // A link to a record outside the loaded range cannot open; drop it so the
  // drawer does not appear later by surprise.
  const missing =
    openId !== undefined && first !== undefined && !busy && !selected;
  useEffect(() => {
    if (!missing) return;
    const next = { ...filters };
    delete next.decision;
    setFilters(next);
  }, [missing, filters, setFilters]);
  const lastTrigger = useRef<HTMLElement | null>(null);
  const previousOpen = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (previousOpen.current !== undefined && openId === undefined)
      lastTrigger.current?.focus();
    previousOpen.current = openId;
  }, [openId]);
  const closeDecision = () => {
    const next = { ...filters };
    delete next.decision;
    setFilters(next);
  };
  const filterField = (
    key: string,
    label: string,
    options: readonly { value: string; label: string }[],
  ) => ({
    key,
    label,
    options,
    render: (value: string, setValue: (value: string) => void) => (
      <FilterSelect
        label={label}
        value={value}
        options={options}
        onChange={setValue}
      />
    ),
  });
  const dateField = (key: string, label: string) => ({
    key,
    label,
    render: (value: string, setValue: (value: string) => void) => (
      <FilterDate label={label} value={value} onChange={setValue} />
    ),
  });
  return (
    <section className="ui-workspace" aria-label="拍板记录">
      <PageHeader
        title="拍板记录"
        count={first ? `${visible.length}${cursor ? "+" : ""}` : undefined}
      />
      <PageToolbar
        fields={[
          filterField("decider", "决定人", makerOptions),
          filterField("category", "类别", categoryOptions),
          {
            key: "card_id",
            label: "卡片",
            grow: true,
            render: (value, setValue) => (
              <SearchInput
                aria-label="卡片"
                placeholder="卡片编号"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            ),
          },
          dateField("from", "开始日期"),
          dateField("to", "结束日期"),
        ]}
        values={filters}
        onChange={(next) => {
          // A new filter set starts at the newest records; close the drawer.
          const values = { ...next };
          delete values.decision;
          setFilters(values);
        }}
      >
        <RefreshGroup
          interval={interval}
          pending={busy}
          onRefresh={reload}
          onIntervalChange={(value) => {
            setRefreshChoice({ key: refreshKey, value });
            try {
              localStorage.setItem(refreshKey, String(value));
            } catch {
              /* Optional preference. */
            }
          }}
        />
      </PageToolbar>
      <RequestFeedback
        {...resource}
        retry={reload}
        pendingMessage="正在加载拍板记录…"
      />
      {first?.decisions.length === 0 && (
        <EmptyState>
          {query === "{}" ? "没有拍板记录" : "没有匹配的拍板记录"}
        </EmptyState>
      )}
      {visible.length > 0 && (
        <DataTableLayout stacked aria-label="拍板记录列表">
          <TableHeader>
            <TableRow>
              <TableHead>编号</TableHead>
              <TableHead>问题</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>所选方案</TableHead>
              <TableHead>决定人</TableHead>
              <TableHead>类别</TableHead>
              <TableHead>卡片</TableHead>
              <TableHead>记录人</TableHead>
              <TableHead>拍板时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((q) => (
              <TableRow key={q.id} aria-label={`拍板记录 ${q.id}`}>
                <DataTableCell nowrap>
                  <IdTag id={q.id} />
                </DataTableCell>
                <DataTableCell>
                  <a
                    className="card-table-title ui-data-title"
                    href={routeHash({
                      kind: "decision-history",
                      projectId,
                      filters: { ...filters, decision: q.id },
                    })}
                    aria-haspopup="dialog"
                    onClick={(event) => {
                      if (
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return;
                      event.preventDefault();
                      lastTrigger.current = event.currentTarget;
                      setFilters({ ...filters, decision: q.id });
                    }}
                  >
                    {decisionTitle(q)}
                  </a>
                </DataTableCell>
                <DataTableCell nowrap>
                  <StatusTag status={q.status} />
                </DataTableCell>
                <DataTableCell data-label="所选方案">
                  {decisionOption(q, q.resolution.option)}
                </DataTableCell>
                <DataTableCell nowrap data-label="决定人">
                  {decisionMakerLabels[q.decision_maker]}
                </DataTableCell>
                <DataTableCell nowrap data-label="类别">
                  {categoryLabels[q.category] ?? q.category}
                </DataTableCell>
                <DataTableCell data-label="卡片">
                  {decisionCards(q).map((id) => (
                    <CardLink key={id} projectId={projectId} id={id} />
                  ))}
                  {decisionCards(q).length === 0 && "—"}
                </DataTableCell>
                <DataTableCell nowrap data-label="记录人">
                  <EmployeeIdentity
                    {...q.resolution}
                    author={q.resolution.resolved_by}
                    showTitle={false}
                  />
                </DataTableCell>
                <DataTableCell nowrap data-label="拍板时间">
                  <Time value={q.resolution.at} />
                </DataTableCell>
              </TableRow>
            ))}
          </TableBody>
        </DataTableLayout>
      )}
      {visible.length > 0 && (
        <nav
          className="timeline-controls card-list-pagination ui-inline-items"
          aria-label="拍板记录分页"
        >
          {cursor ? (
            <>
              <span className="timeline-count">已显示 {visible.length} 条</span>
              <Button
                type="button"
                className="quiet"
                aria-disabled={loadingMore}
                onClick={() => {
                  if (!loadingMore) void more();
                }}
              >
                加载更多
              </Button>
            </>
          ) : (
            <span className="timeline-count" role="status">
              已显示全部 {visible.length} 条
            </span>
          )}
        </nav>
      )}
      <RequestFeedback
        interactive
        pending={loadingMore}
        pendingMessage="正在加载更多拍板记录…"
        error={moreError}
        retry={more}
      />
      <Drawer
        className={cardDetailDrawerClassName ?? ""}
        open={selected !== undefined}
        onOpenChange={(open) => {
          if (!open) closeDecision();
        }}
        title={
          selected ? (
            <>
              <IdBadge id={selected.id} /> {decisionTitle(selected)}
            </>
          ) : (
            "拍板记录"
          )
        }
        description={`拍板记录 ${openId ?? ""} 详情`}
        initialFocus="close"
      >
        {selected && (
          <DecisionHistoryDetail q={selected} projectId={projectId} />
        )}
      </Drawer>
    </section>
  );
}
