import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  type CardDetail,
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
import {
  CardHoldTip,
  CardStatusTip,
  CardSupersededTip,
} from "../components/CardStatusTip.js";
import { CardsViewSwitch } from "../components/CardsViewSwitch.js";
import { CreateCardButton } from "../components/CreateCardButton.js";
import { DisplayMenu } from "../components/DisplayMenu.js";
import { Drawer } from "../components/Drawer.js";
import { NextOwners } from "../components/EmployeeIdentity.js";
import { FilterSelect } from "../components/FilterSelect.js";
import {
  EmptyState,
  IdTag,
  PageTitle,
  Time,
} from "../components/Foundation.js";
import { GroupedTableBody } from "../components/GroupedTableBody.js";
import { IdBadge } from "../components/IdTag.js";
import { cardDetailDrawerClassName } from "../components/layout/CardDetailLayout.js";
import type { MenuItem } from "../components/Menu.js";
import { MultiSelect } from "../components/MultiSelect.js";
import { PageLoader } from "../components/PageLoader.js";
import { PageSizeMenu } from "../components/PageSizeMenu.js";
import { PageToolbar } from "../components/PageToolbar.js";
import { PriorityBadge } from "../components/Priority.js";
import {
  DEFAULT_REFRESH_INTERVAL,
  REFRESH_INTERVALS,
  RefreshGroup,
} from "../components/RefreshGroup.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { TemplateMarker } from "../components/TemplateMarker.js";
import { Tooltip } from "../components/Tooltip.js";
import { Button, IconButton } from "../components/ui/button.js";
import { SearchInput } from "../components/ui/input.js";
import { Skeleton } from "../components/ui/skeleton.js";
import {
  Table,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.js";
import { fullIdHref } from "../full-id-jump.js";
import { CardDetailPage } from "../lazy-pages.js";
import { guardLeave } from "../leave-guard.js";
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
    detail: CardDetail;
  }>();
  const onTitleChange = useCallback(
    (title: string, detail: CardDetail) => {
      setLoadedTitle({ projectId, cardId: openCardId, title, detail });
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
  const readController = useRef<AbortController | undefined>(undefined);
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const change = () => {
      if (document.hidden) readController.current?.abort();
      setVisible(!document.hidden);
    };
    document.addEventListener("visibilitychange", change);
    return () => {
      document.removeEventListener("visibilitychange", change);
      readController.current?.abort();
    };
  }, []);
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
  useEffect(() => {
    // A hidden tab may miss deletions or reordering. Resume from fresh cursors,
    // even if a load-more operation was still pending when it became hidden.
    if (!visible) pendingPage.current = undefined;
  }, [visible]);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
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
      received = await client.cards(
        projectId,
        "all",
        options,
        controller.signal,
      );
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
            !document.hidden &&
            cursor &&
            !seen.has(cursor) &&
            received.cards.filter((c) => c.status === status).length < wanted
          ) {
            seen.add(cursor);
            const next = await client.cards(
              projectId,
              "all",
              {
                ...options,
                status,
                cursor,
              },
              controller.signal,
            );
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
    if (request === sequence.current && !document.hidden) {
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
  const {
    data: loadedData,
    error,
    reload,
    pending,
  } = useResource(load, 0, visible);
  useEffect(() => {
    if (!interval || pending || denied || !visible) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) reload();
    }, interval);
    return () => window.clearInterval(timer);
  }, [interval, pending, denied, visible, reload]);
  const data = denied
    ? undefined
    : (loadedData ??
      (snapshot.current?.projectId === projectId
        ? snapshot.current.page
        : client.cachedCards?.(projectId, "all", requestOptions(requestKey))));
  const boardLanes = useBoardLanes(client, projectId, revision, visible);
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
      className={`cards-page ui-workspace${view === "board" ? " cards-page-board" : ""}`}
      aria-label="卡片"
    >
      <PageTitle
        title="卡片"
        actions={
          // C-684: a standing entry, with or without cards and filters.
          <CreateCardButton
            key={projectId}
            projectId={projectId}
            client={client}
            onCreated={(id) => {
              reload();
              openCard(id);
            }}
          />
        }
      />
      <div
        className="cards-refresh-status ui-refresh-feedback"
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
          <Button type="button" className="quiet" onClick={reload}>
            重试
          </Button>
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
      <PageToolbar
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
              <FilterSelect
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
              <FilterSelect
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
              <FilterSelect
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
              <SearchInput
                type="search"
                aria-label="搜索标题或编号"
                placeholder="搜索标题或编号"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  // C-675: Enter on a full number (`SEN-C-34`) opens it, in any project.
                  const typed = event.currentTarget.value;
                  void fullIdHref(client, typed).then(
                    (href) => {
                      if (href !== undefined) window.location.hash = href;
                    },
                    () => undefined,
                  );
                }}
              />
            ),
          },
          {
            key: "display",
            label: "显示",
            render: () => <DisplayMenu items={displayItems} />,
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
      >
        <RefreshGroup
          interval={interval}
          pending={pending}
          onRefresh={reload}
          onIntervalChange={(value) => {
            setRefreshChoice({ key: preferenceKey, value });
            try {
              localStorage.setItem(preferenceKey, String(value));
            } catch {
              /* Optional preference. */
            }
          }}
        />
        <CardsViewSwitch
          value={view}
          onChange={(next) => setFilters({ ...filters, view: next })}
        />
      </PageToolbar>

      {state.kind === "ready" && cards.length === 0 && (
        <EmptyState>{activeFilters ? "没有匹配的卡片" : "没有卡片"}</EmptyState>
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
            sort={filters.sort ?? "updated"}
            onSort={(sort) => setFilters({ ...filters, sort, page: "1" })}
          />
        ) : null)}
      {state.kind === "ready" && view === "list" && (
        <nav
          className="timeline-controls card-list-pagination ui-inline-items"
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
          <Button
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
          </Button>
          <span aria-live="polite">
            第 {page} / {totalPages} 页
          </span>
          <Button
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
          </Button>
        </nav>
      )}
      <Drawer
        className={`card-detail-drawer ${cardDetailDrawerClassName}`}
        actions={
          openCardId ? (
            <>
              {loadedTitle?.projectId === projectId &&
                loadedTitle.cardId === openCardId && (
                  <TemplateMarker
                    card={loadedTitle.detail.card}
                    info={loadedTitle.detail.template}
                    force
                  />
                )}
              <Tooltip content="完整页面">
                <IconButton asChild aria-label="完整页面" variant="ghost">
                  <a
                    href={routeHash({
                      kind: "card",
                      projectId,
                      cardId: openCardId,
                    })}
                  >
                    <ExternalLink aria-hidden="true" />
                  </a>
                </IconButton>
              </Tooltip>
            </>
          ) : undefined
        }
        open={openCardId !== undefined}
        onOpenChange={(open) => {
          // C-503: an unsent draft in the drawer asks before it closes.
          if (!open) guardLeave(closeCard);
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
          <PageLoader key={openCardId} placeholder={<Skeleton />}>
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
const narrowCardQuery = () => window.matchMedia?.("(max-width: 640px)");
function useNarrowCardTable() {
  const [narrow, setNarrow] = useState(
    () => narrowCardQuery()?.matches ?? false,
  );
  useEffect(() => {
    const list = narrowCardQuery();
    if (!list) return;
    setNarrow(list.matches);
    const sync = (event: MediaQueryListEvent) => setNarrow(event.matches);
    list.addEventListener("change", sync);
    return () => list.removeEventListener("change", sync);
  }, []);
  return narrow;
}

function CardTable({
  sort,
  onSort,
  cards,
  grouping,
  projectId,
  display,
  onOpenCard,
}: {
  readonly cards: readonly CardListItem[];
  readonly grouping: CardGrouping;
  readonly sort: string;
  readonly onSort: (sort: string) => void;
  readonly projectId: string;
  readonly display: CardDisplay;
  readonly onOpenCard: (cardId: string, trigger: HTMLElement) => void;
}) {
  const narrow = useNarrowCardTable();
  return (
    <section
      className="card-table-scroll"
      aria-label="卡片列表"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: The horizontal scroll region needs keyboard scrolling.
      tabIndex={0}
    >
      <Table className="card-table">
        <TableHeader>
          <TableRow>
            {(display.number || narrow) && (
              <TableHead
                sort={sort === "id" ? "ascending" : "none"}
                onSort={display.number ? () => onSort("id") : undefined}
              >
                {display.number ? "编号" : "模板"}
              </TableHead>
            )}
            <TableHead scope="col">标题</TableHead>
            <TableHead scope="col">状态</TableHead>
            {display.roles && <TableHead scope="col">负责角色</TableHead>}
            {display.progress && <TableHead scope="col">进度</TableHead>}
            {display.updated && (
              <TableHead
                sort={sort === "updated" ? "descending" : "none"}
                onSort={() => onSort("updated")}
              >
                更新时间
              </TableHead>
            )}
            {display.next && <TableHead scope="col">下一步</TableHead>}
            {!narrow && <TableHead scope="col">模板</TableHead>}
          </TableRow>
        </TableHeader>
        <GroupedTableBody
          rows={cards}
          groupBy={grouping === "status" ? (card) => card.status : undefined}
          groupName={(group) => cardStatusLabel(group.id)}
          columns={
            (narrow ? 2 : 3) +
            [
              display.number || narrow,
              display.roles,
              display.progress,
              display.updated,
              display.next,
            ].filter(Boolean).length
          }
          countLabel="张卡片"
          renderRow={(card) => (
            <TableRow
              key={card.id}
              className={
                card.resolution === "superseded" ? "card-superseded" : undefined
              }
            >
              {(display.number || narrow) && (
                <TableCell className="card-table-number">
                  {display.number && (
                    <IdTag id={card.id} label="卡片" detail={card.title} />
                  )}
                  {narrow && (
                    <TemplateMarker card={card} info={card.template_info} />
                  )}
                </TableCell>
              )}
              <TableCell className="card-table-name">
                <div className="card-table-heading ui-data-heading">
                  <PriorityBadge value={card.priority} />
                  <Tooltip content={display.reason ? card.why : undefined}>
                    <a
                      className="card-table-title ui-data-title"
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
              </TableCell>
              <TableCell>
                <CardStatusTip card={card} />
                <CardHoldTip card={card} />
                <CardSupersededTip card={card} />
              </TableCell>
              {display.roles && (
                <TableCell className="card-table-roles" data-label="负责角色">
                  {card.roles.join("、") || "—"}
                </TableCell>
              )}
              {display.progress && (
                <TableCell>
                  {card.progress.completed}/{card.progress.total}
                </TableCell>
              )}
              {display.updated && (
                <TableCell data-label="更新时间">
                  <Time value={card.updated_at} />
                </TableCell>
              )}
              {display.next && (
                <TableCell data-label="下一步">
                  <NextOwners owners={card.next_owners} />
                </TableCell>
              )}
              {!narrow && (
                <TableCell className="card-table-template">
                  <TemplateMarker card={card} info={card.template_info} />
                </TableCell>
              )}
            </TableRow>
          )}
        />
      </Table>
    </section>
  );
}
