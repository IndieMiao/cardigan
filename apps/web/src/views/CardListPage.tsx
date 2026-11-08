import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CardFilter,
  CardiganClient,
  CardListItem,
  CardPage,
} from "../api.js";
import {
  CARD_DISPLAY_FIELDS,
  type CardDisplay,
  readCardDisplay,
  writeCardDisplay,
} from "../card-display.js";
import { Board } from "../components/Board.js";
import { Drawer } from "../components/Drawer.js";
import { FilterBar } from "../components/FilterBar.js";
import {
  EmptyState,
  IdTag,
  PageTitle,
  StatusTag,
  Time,
} from "../components/Foundation.js";
import { Menu, type MenuItem } from "../components/Menu.js";
import { MultiSelect } from "../components/MultiSelect.js";
import { ViewSwitch } from "../components/ViewSwitch.js";
import { routeHash, useRouteFilters } from "../route.js";
import { inSnapshotGroup, SNAPSHOT_GROUPS } from "../snapshot-groups.js";
import { BOARD_STATUSES, cardStatusLabel, nextOwnersLabel } from "../status.js";
import { useResource } from "../useResource.js";
import { CardDetailPage } from "./CardDetailPage.js";

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
function CopyLinkButton() {
  const [message, setMessage] = useState("");
  return (
    <>
      <button
        type="button"
        className="quiet"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(window.location.href);
            setMessage("已复制");
          } catch {
            setMessage("复制失败，请手动复制地址");
          }
        }}
      >
        复制链接
      </button>
      <span className="visually-hidden" role="status">
        {message}
      </span>
    </>
  );
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
  const [display, setDisplay] = useState<CardDisplay>(readCardDisplay);
  const lastTrigger = useRef<HTMLElement | null>(null);
  const previousOpen = useRef<string | undefined>(undefined);
  const load = useCallback(
    () => client.cards(projectId, "all" as CardFilter),
    [client, projectId],
  );
  const { data, error, reload } = useResource(load, revision);
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
  const roles = [
    ...new Set((data?.cards ?? []).flatMap((card) => card.roles)),
  ].sort();
  const activeFilters = Object.entries(filters).some(
    ([key, value]) =>
      !["expanded", "view", "card"].includes(key) && Boolean(value),
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
    <section className="cards-page" aria-label="卡片">
      <PageTitle
        title="卡片"
        description="查看卡片进度与下一步负责人。"
        actions={
          <ViewSwitch
            label="视图"
            value={view}
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
        }
      />
      {data && error && (
        <p role="alert" className="error-panel">
          {error}{" "}
          <button type="button" onClick={reload}>
            重试
          </button>
        </p>
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
              { value: "human", label: "你" },
              { value: "agent", label: "Agent" },
              { value: "none", label: "无人" },
            ],
          },
          {
            key: "role",
            label: "角色",
            options: roles.map((role) => ({ value: role, label: role })),
          },
          {
            key: "sort",
            label: "排序",
            options: [
              { value: "updated", label: "更新时间" },
              { value: "id", label: "编号" },
              { value: "priority", label: "优先级" },
            ],
          },
          { key: "q", label: "搜索标题或编号" },
          {
            key: "display",
            label: "显示",
            render: () => (
              <Menu
                label="显示字段"
                trigger={
                  <button type="button" className="quiet">
                    显示
                  </button>
                }
                items={displayItems}
              />
            ),
          },
        ]}
        values={filters}
        onChange={setFilters}
      />

      {state.kind === "loading" && (
        <p className="loading" role="status">
          正在加载卡片…
        </p>
      )}
      {state.kind === "error" && (
        <div className="error-panel" role="alert">
          <p>{state.message}</p>
          <button type="button" onClick={reload}>
            重试
          </button>
        </div>
      )}
      {state.kind === "ready" && cards.length === 0 && (
        <EmptyState>
          {activeFilters
            ? "没有匹配的卡片，请调整筛选条件。"
            : "这个项目还没有卡片。向 PM 描述目标后，卡片会出现在这里。"}
        </EmptyState>
      )}
      {state.kind === "ready" &&
        (view === "board" ? (
          <Board
            cards={cards}
            projectId={projectId}
            expanded={filters.expanded ?? ""}
            onExpanded={(expanded) => setFilters({ ...filters, expanded })}
            display={display}
            onOpenCard={openCard}
          />
        ) : cards.length > 0 ? (
          <CardTable
            cards={cards}
            projectId={projectId}
            display={display}
            onOpenCard={openCard}
          />
        ) : null)}
      <Drawer
        open={openCardId !== undefined}
        onOpenChange={(open) => {
          if (!open) closeCard();
        }}
        title={
          selectedCard === undefined
            ? `卡片 ${openCardId ?? ""}`
            : `${selectedCard.id} ${selectedCard.title}`
        }
        description={`卡片 ${openCardId ?? ""} 详情`}
        actions={
          openCardId === undefined ? undefined : (
            <>
              <a
                className="drawer-action"
                href={routeHash({
                  kind: "card",
                  projectId,
                  cardId: openCardId,
                })}
              >
                在完整页面打开
              </a>
              <CopyLinkButton />
            </>
          )
        }
      >
        {openCardId !== undefined && (
          <CardDetailPage
            key={openCardId}
            client={client}
            projectId={projectId}
            cardId={openCardId}
            revision={revision}
          />
        )}
      </Drawer>
    </section>
  );
}

function cardHref(projectId: string, card: CardListItem): string {
  return routeHash({ kind: "card", projectId, cardId: card.id });
}
function WaitingTags({ card }: { readonly card: CardListItem }) {
  if (card.waiting_on.length === 0) return <span>—</span>;
  return (
    <span className="metadata">
      {card.waiting_on.map((waiting) => (
        <span key={`${waiting.kind}:${waiting.ref}`}>{waiting.label}</span>
      ))}
    </span>
  );
}
function CardTable({
  cards,
  projectId,
  display,
  onOpenCard,
}: {
  readonly cards: readonly CardListItem[];
  readonly projectId: string;
  readonly display: CardDisplay;
  readonly onOpenCard: (cardId: string, trigger: HTMLElement) => void;
}) {
  const columns = CARD_DISPLAY_FIELDS.filter((field) => display[field.key]);
  return (
    <table className="card-table">
      <thead>
        <tr>
          {display.number && <th scope="col">编号</th>}
          <th scope="col">标题</th>
          <th scope="col">状态</th>
          {columns
            .filter((field) => field.key !== "number")
            .map((field) => (
              <th key={field.key} scope="col">
                {field.label}
              </th>
            ))}
        </tr>
      </thead>
      <tbody>
        {cards.map((card) => (
          <tr key={card.id} title={display.reason ? card.why : undefined}>
            {display.number && (
              <td>
                <IdTag id={card.id} label="卡片" detail={card.title} />
              </td>
            )}
            <td>
              <a
                href={cardHref(projectId, card)}
                title={display.reason ? card.why : undefined}
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
            </td>
            <td>
              <StatusTag status={card.status} />
            </td>
            {display.waiting && (
              <td>
                <WaitingTags card={card} />
              </td>
            )}
            {display.roles && <td>{card.roles.join("、") || "—"}</td>}
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
            {display.next && <td>{nextOwnersLabel(card.next_owners)}</td>}
            {display.reason && <td>{card.why}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
