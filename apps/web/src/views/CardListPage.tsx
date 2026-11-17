import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  type CardiganClient,
  type CardListItem,
  type CardPage,
} from "../api.js";
import {
  CARD_DISPLAY_FIELDS,
  type CardDisplay,
  type CardGrouping,
  readCardDisplay,
  readCardGrouping,
  writeCardDisplay,
  writeCardGrouping,
} from "../card-display.js";
import { Board } from "../components/Board.js";
import { CardHoldDetails } from "../components/CardHold.js";
import { CardSuperseded } from "../components/CardSuperseded.js";
import { Drawer } from "../components/Drawer.js";
import { NextOwners } from "../components/EmployeeIdentity.js";
import { FilterBar } from "../components/FilterBar.js";
import {
  EmptyState,
  IdTag,
  PageTitle,
  StatusTag,
  Time,
} from "../components/Foundation.js";
import { GroupedTableBody } from "../components/GroupedTableBody.js";
import { IdBadge } from "../components/IdTag.js";
import { Menu, type MenuItem } from "../components/Menu.js";
import { MultiSelect } from "../components/MultiSelect.js";
import { PageLoader } from "../components/PageLoader.js";
import { PageSizeMenu } from "../components/PageSizeMenu.js";
import { PriorityBadge } from "../components/Priority.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { Tooltip } from "../components/Tooltip.js";
import { ViewSwitch } from "../components/ViewSwitch.js";
import { CardDetailPage } from "../lazy-pages.js";
import { routeHash, useRouteFilters } from "../route.js";
import { inSnapshotGroup, SNAPSHOT_GROUPS } from "../snapshot-groups.js";
import { BOARD_STATUSES, cardStatusLabel } from "../status.js";
import { useBoardLanes } from "../useBoardLanes.js";
import { useResource } from "../useResource.js";

/**
 * The merged cards workspace (Phase 1.5 U5a / §8.2).
 *
 * One route holds the list/board switch, all filters and the optional card
 * drawer. The card detail component is reused as-is inside the drawer.
 */

export interface CardListPageProps {
  readonly client: CardiganClient;
  readonly projectId: string;
  /** Direct-render fallback; normal navigation reads `view` from the route. */
  readonly view?: "board" | "list";
  readonly revision?: number;
  readonly changedCards?: readonly string[];
  readonly changedCardsSince?: (revision: number) => readonly string[];
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly page: CardPage };

const statusesOf = (value: string | undefined): string[] =>
  (value ?? "").split(",").filter(Boolean);
const idNumber = (id: string): number => {
  const digits = /(\d+)\)?$/.exec(id)?.[1];
  return digits === undefined ? 0 : Number(digits);
};
const nextKind = (card: CardListItem): "human" | "agent" | "none" => {
  if (
    card.next_owners.some((owner) => owner.kind === "human") ||
    card.waiting_on.some(
      (waiting) =>
        waiting.kind === "decision" || waiting.kind === "human_action",
    )
  )
    return "human";
  if (
    card.next_owners.some(
      (owner) => owner.kind === "role" || owner.kind === "assignment",
    )
  )
    return "agent";
  return "none";
};
function filteredCards(
  cards: readonly CardListItem[],
  filters: Readonly<Record<string, string>>,
): readonly CardListItem[] {
  const selected = new Set(statusesOf(filters.status)),
    q = (filters.q ?? "").trim().toLocaleLowerCase(),
    next = filters.next ?? "",
    role = filters.role ?? "";
  const matched = cards.filter(
    (card) =>
      (selected.size === 0 || selected.has(card.status)) &&
      inSnapshotGroup(card, filters.overview ?? "") &&
      (next === "" || nextKind(card) === next) &&
      (role === "" || card.roles.includes(role)) &&
      `${card.id} ${card.title}`.toLocaleLowerCase().includes(q),
  );
  return [...matched].sort((left, right) => {
    if (filters.sort === "id") return idNumber(left.id) - idNumber(right.id);
    if (filters.sort === "priority")
      return (
        right.priority - left.priority || idNumber(left.id) - idNumber(right.id)
      );
    return (
      right.updated_at.localeCompare(left.updated_at) ||
      idNumber(right.id) - idNumber(left.id)
    );
  });
}
function ListIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3 4h10M3 8h10M3 12h10"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}
function BoardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3 3h3v10H3zM9 3h4v6H9z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}
function SelectFilter({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
  }[];
  readonly onChange: (value: string) => void;
}) {
  const current =
    options.find((option) => option.value === value)?.label ?? "全部";
  return (
    <Menu
      label={label}
      trigger={
        <button type="button" className="filter-select-trigger">
          <span>
            {label}：{current}
          </span>
          <span aria-hidden="true">▾</span>
        </button>
      }
      items={[
        { id: "__all", label: "全部", onSelect: () => onChange("") },
        ...options.map((option) => ({
          id: option.value,
          label: option.label,
          onSelect: () => onChange(option.value),
        })),
      ]}
    />
  );
}
const refreshIntervals = [10000, 30000, 60000, 300000, 0];
function readRefresh(key: string) {
  try {
    const raw = localStorage.getItem(key);
    const value = raw === null ? 30000 : Number(raw);
    return refreshIntervals.includes(value) ? value : 30000;
  } catch {
    return 30000;
  }
}
function requestOptions(key: string): Record<string, string> {
  const options: Record<string, string> = JSON.parse(key);
  const size = ["10", "20", "50"].includes(options.count ?? "")
    ? options.count
    : "10";
  options.limit = options.mode === "board" ? "10" : (size ?? "10");
  delete options.count;
  options.sort ||= "updated";
  return options;
}
function appendBoardPage(previous: CardPage, next: CardPage): CardPage {
  return {
    ...next,
    total_filtered: previous.total_filtered ?? next.total_filtered ?? 0,
    cards: [
      ...new Map(
        [...previous.cards, ...next.cards].map((c) => [c.id, c]),
      ).values(),
    ],
    lanes: { ...previous.lanes, ...next.lanes },
  };
}

export function CardListPage({
  client,
  projectId,
  view: fallbackView = "board",
  revision = 0,
}: CardListPageProps) {
  const [filters, setFilters] = useRouteFilters({
    kind: "cards",
    projectId,
    filters: { view: fallbackView },
  });
  const view = filters.view === "list" ? "list" : "board";
  const openCardId = filters.card;
  const [loadedTitle, setLoadedTitle] = useState<{
    projectId: string;
    cardId: string | undefined;
    title: string;
  }>();
  const onTitleChange = useCallback(
    (title: string) => {
      setLoadedTitle({ projectId, cardId: openCardId, title });
    },
    [projectId, openCardId],
  );
  const preferenceKey = JSON.stringify([
    "cardigan.cards.refresh",
    client.cardPreferenceScope?.() ?? "local",
    projectId,
  ]);
  const [refreshChoice, setRefreshChoice] = useState({
    key: preferenceKey,
    value: readRefresh(preferenceKey),
  });
  const interval =
    refreshChoice.key === preferenceKey
      ? refreshChoice.value
      : readRefresh(preferenceKey);
  const [denied, setDenied] = useState(false);
  const [display, setDisplay] = useState<CardDisplay>(readCardDisplay);
  const [grouping, setGrouping] = useState<CardGrouping>(() =>
    readCardGrouping(projectId),
  );
  useEffect(() => setGrouping(readCardGrouping(projectId)), [projectId]);
  const changeGrouping = (next: CardGrouping) => {
    setGrouping(next);
    writeCardGrouping(projectId, next);
  };
  const lastTrigger = useRef<HTMLElement | null>(null);
  const previousOpen = useRef<string | undefined>(undefined);
  const requestKey = JSON.stringify(
    Object.fromEntries(
      ["status", "q", "next", "role", "sort", "overview", "page", "count"]
        .map((key) => [key, filters[key] ?? ""])
        .concat([["mode", view]]),
    ),
  );
  const snapshot = useRef<
    | {
        client: CardiganClient;
        projectId: string;
        key: string;
        page: CardPage;
      }
    | undefined
  >(undefined);
  if (snapshot.current && snapshot.current.client !== client)
    snapshot.current = undefined;
  const pendingPage = useRef<
    | { projectId: string; key: string; status: string; cursor: string }
    | undefined
  >(undefined);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    const options = requestOptions(requestKey);
    const previous =
      snapshot.current?.projectId === projectId &&
      snapshot.current.key === requestKey
        ? snapshot.current
        : undefined;
    const more =
      pendingPage.current?.key === requestKey &&
      pendingPage.current.projectId === projectId
        ? pendingPage.current
        : undefined;
    if (more)
      Object.assign(options, { status: more.status, cursor: more.cursor });
    let received: CardPage;
    try {
      received = await client.cards(projectId, "all", options);
      if (
        options.mode === "board" &&
        received.server_filtered &&
        previous &&
        !more
      ) {
        // Rebuild each already-expanded prefix from fresh cursors. This also
        // removes deleted/moved rows and backfills gaps when SSE was missed.
        for (const status of Object.keys(previous.page.lanes ?? {})) {
          const wanted = previous.page.cards.filter(
            (c) => c.status === status,
          ).length;
          const seen = new Set<string>();
          let cursor = received.lanes?.[status]?.next_cursor;
          while (
            request === sequence.current &&
            cursor &&
            !seen.has(cursor) &&
            received.cards.filter((c) => c.status === status).length < wanted
          ) {
            seen.add(cursor);
            const next = await client.cards(projectId, "all", {
              ...options,
              status,
              cursor,
            });
            received = appendBoardPage(received, next);
            cursor = received.lanes?.[status]?.next_cursor;
          }
        }
      }
      if (request === sequence.current) setDenied(false);
    } catch (error) {
      if (
        request === sequence.current &&
        error instanceof ApiError &&
        [401, 403].includes(error.status)
      ) {
        snapshot.current = undefined;
        setDenied(true);
      }
      throw error;
    }
    const merged =
      received.server_filtered && previous && more
        ? appendBoardPage(previous.page, received)
        : received;
    if (request === sequence.current) {
      if (pendingPage.current === more) pendingPage.current = undefined;
      snapshot.current = {
        client,
        projectId,
        key: requestKey,
        page: merged,
      };
    }
    return merged;
  }, [client, projectId, requestKey]);
  const { data: loadedData, error, reload, pending } = useResource(load);
  useEffect(() => {
    if (!interval || pending || denied) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) reload();
    }, interval);
    return () => window.clearInterval(timer);
  }, [interval, pending, denied, reload]);
  const data = denied
    ? undefined
    : (loadedData ??
      (snapshot.current?.projectId === projectId
        ? snapshot.current.page
        : client.cachedCards?.(projectId, "all", requestOptions(requestKey))));
  const boardLanes = useBoardLanes(client, projectId, revision);
  useEffect(() => {
    writeCardDisplay(display);
  }, [display]);
  useEffect(() => {
    if (previousOpen.current !== undefined && openCardId === undefined)
      lastTrigger.current?.focus();
    previousOpen.current = openCardId;
  }, [openCardId]);

  const state: LoadState = data
    ? { kind: "ready", page: data }
    : error
      ? { kind: "error", message: error }
      : { kind: "loading" };
  const cards = data ? filteredCards(data.cards, filters) : [];
  const pageSize = ["10", "20", "50"].includes(filters.count ?? "")
    ? Number(filters.count)
    : 10;
  const requestedPage = Number(filters.page ?? 1);
  const filteredTotal = data?.total_filtered ?? cards.length;
  const totalPages = Math.max(1, Math.ceil(filteredTotal / pageSize));
  const page =
    Number.isSafeInteger(requestedPage) && requestedPage > 0
      ? Math.min(requestedPage, totalPages)
      : 1;
  const pageCards = data?.server_filtered
    ? cards
    : cards.slice((page - 1) * pageSize, page * pageSize);
  const roles =
    data?.roles ??
    [...new Set((data?.cards ?? []).flatMap((card) => card.roles))].sort();
  const activeFilters = Object.entries(filters).some(
    ([key, value]) =>
      !["expanded", "view", "card", "page", "count"].includes(key) &&
      Boolean(value),
  );
  const statusOptions = BOARD_STATUSES.map((status) => ({
    value: status,
    label: cardStatusLabel(status),
  }));
  const displayItems: MenuItem[] = CARD_DISPLAY_FIELDS.map((field) => ({
    id: field.key,
    kind: "checkbox",
    label: field.label,
    checked: display[field.key],
    onCheckedChange: (checked) =>
      setDisplay((current) => ({ ...current, [field.key]: checked })),
  }));
  if (view === "list")
    displayItems.push({
      id: "group-status",
      kind: "checkbox",
      label: "分组字段：状态",
      checked: grouping === "status",
      onCheckedChange: (checked) => changeGrouping(checked ? "status" : "none"),
    });
  const openCard = (cardId: string, trigger?: HTMLElement) => {
    lastTrigger.current = trigger ?? null;
    setFilters({ ...filters, card: cardId });
  };
  const closeCard = () => {
    const next = { ...filters };
    delete next.card;
    setFilters(next);
  };
  const selectedCard = (data?.cards ?? []).find(
    (card) => card.id === openCardId,
  );
  return (
    <section
      className={`cards-page${view === "board" ? " cards-page-board" : ""}`}
      aria-label="卡片"
    >
      <PageTitle
        title={
          <span className="cards-title">
            卡片
            <small className="cards-count">{filteredTotal} 张卡片</small>
          </span>
        }
        description="查看卡片进度与下一步负责人。"
        actions={
          <div className="cards-page-actions">
            <div className="cards-refresh">
              <label>
                自动刷新
                <select
                  aria-label="自动刷新"
                  value={interval}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setRefreshChoice({ key: preferenceKey, value });
                    try {
                      localStorage.setItem(preferenceKey, String(value));
                    } catch {
                      /* Optional preference. */
                    }
                  }}
                >
                  <option value={10000}>10 秒</option>
                  <option value={30000}>30 秒</option>
                  <option value={60000}>60 秒</option>
                  <option value={300000}>5 分钟</option>
                  <option value={0}>关闭</option>
                </select>
              </label>
              <button
                type="button"
                className="quiet"
                onClick={() => {
                  if (!pending) reload();
                }}
                aria-disabled={pending}
              >
                立即刷新
              </button>
            </div>
            <ViewSwitch
              label="视图"
              value={view}
              showLabel
              onChange={(next) =>
                setFilters({
                  ...filters,
                  view: next === "list" ? "list" : "board",
                })
              }
              options={[
                { value: "board", label: "看板", icon: <BoardIcon /> },
                { value: "list", label: "列表", icon: <ListIcon /> },
              ]}
            />
          </div>
        }
      />
      <div
        className="cards-refresh-status"
        role={error ? "alert" : "status"}
        aria-live="polite"
        data-pending={pending}
      >
        <span>
          {error ||
            (pending
              ? data
                ? "正在刷新，保留当前卡片…"
                : "正在加载卡片…"
              : "")}
        </span>
        {error && (
          <button type="button" className="quiet" onClick={reload}>
            重试
          </button>
        )}
      </div>
      {boardLanes.error && (
        <RequestFeedback
          error={boardLanes.error}
          retry={boardLanes.retry}
          retryLabel="重新保存"
        />
      )}
      {view === "board" && boardLanes.readError && (
        <RequestFeedback
          error={boardLanes.readError}
          retry={boardLanes.reload}
        />
      )}
      <FilterBar
        fields={[
          ...(filters.overview
            ? [{ key: "overview", label: "概览", options: SNAPSHOT_GROUPS }]
            : []),
          {
            key: "status",
            label: "状态",
            multiple: true,
            options: statusOptions,
            render: (value, setValue) => (
              <MultiSelect
                label="状态"
                options={statusOptions}
                values={statusesOf(value)}
                onChange={(next) => setValue(next.join(","))}
              />
            ),
          },
          {
            key: "next",
            label: "下一步谁做",
            options: [
              { value: "human", label: "所有者" },
              { value: "agent", label: "Agent" },
              { value: "none", label: "无人" },
            ],
            render: (value, setValue) => (
              <SelectFilter
                label="下一步"
                value={value}
                options={[
                  { value: "human", label: "所有者" },
                  { value: "agent", label: "Agent" },
                  { value: "none", label: "无人" },
                ]}
                onChange={setValue}
              />
            ),
          },
          {
            key: "role",
            label: "角色",
            options: roles.map((role) => ({ value: role, label: role })),
            render: (value, setValue) => (
              <SelectFilter
                label="角色"
                value={value}
                options={roles.map((role) => ({
                  value: role,
                  label: role,
                }))}
                onChange={setValue}
              />
            ),
          },
          {
            key: "sort",
            label: "排序",
            options: [
              { value: "updated", label: "更新时间" },
              { value: "id", label: "编号" },
              { value: "priority", label: "优先级" },
            ],
            render: (value, setValue) => (
              <SelectFilter
                label="排序"
                value={value}
                options={[
                  { value: "updated", label: "更新时间" },
                  { value: "id", label: "编号" },
                  { value: "priority", label: "优先级" },
                ]}
                onChange={setValue}
              />
            ),
          },
          {
            key: "q",
            label: "搜索标题或编号",
            grow: true,
            render: (value, setValue) => (
              <label className="filter-search">
                <span aria-hidden="true">⌕</span>
                <input
                  type="search"
                  aria-label="搜索标题或编号"
                  placeholder="搜索标题或编号"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                />
              </label>
            ),
          },
          {
            key: "display",
            label: "显示",
            render: () => (
              <Menu
                label="显示字段"
                className="card-display-menu"
                title="显示字段"
                trigger={
                  <button
                    type="button"
                    className="filter-select-trigger card-display-trigger"
                  >
                    <span>显示</span>
                    <span aria-hidden="true">▾</span>
                  </button>
                }
                items={displayItems}
                footer={
                  <>
                    <span>标题始终显示</span>
                    <span>仅保存在此浏览器</span>
                    {view === "list" && grouping === "status" && (
                      <span>分组统计当前页</span>
                    )}
                  </>
                }
              />
            ),
          },
        ]}
        values={filters}
        onChange={(next) =>
          setFilters({
            ...next,
            ...(view === "list" || filters.page
              ? { page: "1", count: String(pageSize) }
              : {}),
          })
        }
      />

      {state.kind === "ready" && cards.length === 0 && (
        <EmptyState>
          {activeFilters
            ? "没有匹配的卡片，请调整筛选条件。"
            : "这个项目还没有卡片。向 PM 描述目标后，卡片会出现在这里。"}
        </EmptyState>
      )}
      {state.kind === "ready" &&
        (view === "board" ? (
          boardLanes.ready && (
            <Board
              resetKey={JSON.stringify([
                projectId,
                ...["status", "overview", "next", "role", "q", "sort"].map(
                  (key) => filters[key] ?? "",
                ),
              ])}
              cards={cards}
              remote={
                data?.lanes
                  ? {
                      lanes: data.lanes,
                      pending,
                      load: (status: string) => {
                        const cursor = data.lanes?.[status]?.next_cursor;
                        if (cursor && !pending) {
                          pendingPage.current = {
                            projectId,
                            key: requestKey,
                            status,
                            cursor,
                          };
                          reload();
                        }
                      },
                    }
                  : undefined
              }
              projectId={projectId}
              lanes={boardLanes.lanes}
              onLaneChange={boardLanes.setLane}
              display={display}
              onOpenCard={openCard}
            />
          )
        ) : cards.length > 0 ? (
          <CardTable
            key={projectId}
            grouping={grouping}
            cards={pageCards}
            projectId={projectId}
            display={display}
            onOpenCard={openCard}
          />
        ) : null)}
      {state.kind === "ready" && view === "list" && (
        <nav
          className="timeline-controls card-list-pagination"
          aria-label="卡片分页"
        >
          <span className="timeline-count">共 {filteredTotal} 张卡片</span>
          <PageSizeMenu
            label="每页"
            pageSize={pageSize}
            sizes={[10, 20, 50]}
            unit="张"
            onChange={(size) =>
              setFilters({ ...filters, page: "1", count: String(size) })
            }
          />
          <button
            type="button"
            className="quiet"
            disabled={page === 1}
            onClick={() =>
              setFilters({
                ...filters,
                page: String(page - 1),
                count: String(pageSize),
              })
            }
          >
            上一页
          </button>
          <span aria-live="polite">
            第 {page} / {totalPages} 页
          </span>
          <button
            type="button"
            className="quiet"
            disabled={page === totalPages}
            onClick={() =>
              setFilters({
                ...filters,
                page: String(page + 1),
                count: String(pageSize),
              })
            }
          >
            下一页
          </button>
        </nav>
      )}
      <Drawer
        className="card-detail-drawer"
        open={openCardId !== undefined}
        onOpenChange={(open) => {
          if (!open) closeCard();
        }}
        title={
          openCardId ? (
            <>
              <IdBadge id={openCardId} />{" "}
              {loadedTitle?.projectId === projectId &&
              loadedTitle.cardId === openCardId
                ? loadedTitle.title
                : selectedCard?.title}
            </>
          ) : (
            "卡片"
          )
        }
        description={`卡片 ${openCardId ?? ""} 详情`}
        initialFocus="close"
      >
        {openCardId !== undefined && (
          <PageLoader key={openCardId}>
            <CardDetailPage
              key={openCardId}
              client={client}
              projectId={projectId}
              cardId={openCardId}
              inDrawer
              onTitleChange={onTitleChange}
              revision={revision}
            />
          </PageLoader>
        )}
      </Drawer>
    </section>
  );
}

function cardHref(projectId: string, card: CardListItem): string {
  return routeHash({ kind: "card", projectId, cardId: card.id });
}
function CardTable({
  cards,
  grouping,
  projectId,
  display,
  onOpenCard,
}: {
  readonly cards: readonly CardListItem[];
  readonly grouping: CardGrouping;
  readonly projectId: string;
  readonly display: CardDisplay;
  readonly onOpenCard: (cardId: string, trigger: HTMLElement) => void;
}) {
  return (
    <section
      className="card-table-scroll"
      aria-label="卡片列表"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: The horizontal scroll region needs keyboard scrolling.
      tabIndex={0}
    >
      <table className="card-table">
        <thead>
          <tr>
            {display.number && <th scope="col">编号</th>}
            <th scope="col">标题</th>
            <th scope="col">状态</th>
            {display.roles && <th scope="col">负责角色</th>}
            {display.progress && <th scope="col">进度</th>}
            {display.updated && <th scope="col">更新时间</th>}
            {display.next && <th scope="col">下一步</th>}
            <th scope="col" aria-label="打开" />
          </tr>
        </thead>
        <GroupedTableBody
          rows={cards}
          groupBy={grouping === "status" ? (card) => card.status : undefined}
          groupName={(group) => cardStatusLabel(group.id)}
          columns={
            3 +
            [
              display.number,
              display.roles,
              display.progress,
              display.updated,
              display.next,
            ].filter(Boolean).length
          }
          countLabel="张卡片"
          renderRow={(card) => (
            <tr
              key={card.id}
              className={
                card.resolution === "superseded" ? "card-superseded" : undefined
              }
            >
              {display.number && (
                <td>
                  <IdTag id={card.id} label="卡片" detail={card.title} />
                </td>
              )}
              <td>
                <div className="card-table-heading">
                  <PriorityBadge value={card.priority} />
                  <Tooltip content={display.reason ? card.why : undefined}>
                    <a
                      className="card-table-title"
                      href={cardHref(projectId, card)}
                      onClick={(event) => {
                        if (
                          event.metaKey ||
                          event.ctrlKey ||
                          event.shiftKey ||
                          event.altKey
                        )
                          return;
                        event.preventDefault();
                        onOpenCard(card.id, event.currentTarget);
                      }}
                    >
                      {card.title}
                    </a>
                  </Tooltip>
                </div>
                <CardSuperseded card={card} />
                <CardHoldDetails card={card} compact />
                {!card.hold && card.status === "review" && (
                  <p className="card-review-reason">{card.why}</p>
                )}
              </td>
              <td>
                <StatusTag status={card.status} />
              </td>
              {display.roles && (
                <td className="card-table-roles">
                  {card.roles.join("、") || "—"}
                </td>
              )}
              {display.progress && (
                <td>
                  {card.progress.completed}/{card.progress.total}
                </td>
              )}
              {display.updated && (
                <td>
                  <Time value={card.updated_at} />
                </td>
              )}
              {display.next && (
                <td>
                  <NextOwners owners={card.next_owners} />
                </td>
              )}
              <td className="card-table-arrow" aria-hidden="true">
                →
              </td>
            </tr>
          )}
        />
      </table>
    </section>
  );
}
