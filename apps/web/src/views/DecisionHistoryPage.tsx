import { useCallback, useRef, useState } from "react";
import {
  type CardiganClient,
  type DecisionHistoryRecord,
  describeError,
} from "../api.js";
import { EmployeeIdentity } from "../components/EmployeeIdentity.js";
import {
  EmptyState,
  PageTitle,
  StatusTag,
  Time,
} from "../components/Foundation.js";
import { IdentityRow } from "../components/IdentityRow.js";
import { IdTag } from "../components/IdTag.js";
import { CardLink, Markdown } from "../components/Operations.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { categoryLabels } from "../decision-labels.js";
import { useRouteFilters } from "../route.js";
import { useResource } from "../useResource.js";

const PAGE_SIZE = 10;
const makerLabels = { human: "所有者", pm: "PM 代拍", system: "系统代批" };

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

function oneLine(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * C-134: one record in two lines plus a one-line, expandable summary of the
 * impact and rationale. Expanding shows every field in full.
 */
function DecisionRecord({
  q,
  projectId,
  makerLabel,
}: {
  q: DecisionHistoryRecord;
  projectId: string;
  makerLabel: string;
}) {
  const option = q.options.find((o) => o.key === q.resolution.option);
  const impact = option?.impact ?? "";
  const cards = [
    ...new Set([...(q.card_id ? [q.card_id] : []), ...q.affected_cards]),
  ];
  return (
    <article className="decision-record" aria-label={`拍板记录 ${q.id}`}>
      <header className="decision-record-head">
        <IdTag id={q.id} />
        <h2 className="decision-record-question" title={q.question}>
          {q.question}
        </h2>
        {q.status !== "resolved" && <StatusTag status={q.status} />}
        {cards.length > 0 && (
          <span className="decision-record-cards">
            {cards.map((id) => (
              <CardLink key={id} projectId={projectId} id={id} />
            ))}
          </span>
        )}
        <span className="decision-record-meta">
          {makerLabel} · {categoryLabels[q.category] ?? q.category} ·{" "}
          <Time value={q.resolution.at} />
        </span>
      </header>
      <IdentityRow className="decision-record-choice">
        <span className="decision-record-option">
          所选方案：{option?.description ?? q.resolution.option}
        </span>
        <IdentityRow as="span" className="decision-record-by">
          <span className="visually-hidden">记录人：</span>
          <EmployeeIdentity
            {...q.resolution}
            author={q.resolution.resolved_by}
            showTitle={false}
          />
        </IdentityRow>
      </IdentityRow>
      <details className="decision-record-more">
        <summary className="decision-record-summary">
          <span className="decision-record-preview">
            影响：{oneLine(impact) || "—"}　理由：
            {oneLine(q.resolution.rationale)}
          </span>
          <span className="decision-record-collapse">收起详情</span>
        </summary>
        <dl className="decision-record-detail">
          <dt>问题</dt>
          <dd>{q.question}</dd>
          <dt>影响</dt>
          <dd>{impact || "—"}</dd>
          <dt>理由</dt>
          <dd>
            <Markdown body={q.resolution.rationale} />
          </dd>
          {q.resolution.proxy_authority && (
            <>
              <dt>授权依据</dt>
              <dd>{q.resolution.proxy_authority}</dd>
            </>
          )}
        </dl>
      </details>
    </article>
  );
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
  const fetchPage = useCallback(
    (cursor?: string) =>
      client.decisionHistory(
        projectId,
        {
          ...filters,
          ...(filters.from
            ? { from: new Date(`${filters.from}T00:00:00`).toISOString() }
            : {}),
          ...(filters.to
            ? { to: new Date(`${filters.to}T23:59:59.999`).toISOString() }
            : {}),
        },
        ...(cursor ? [cursor] : []),
      ),
    [client, projectId, filters],
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
  const select = (name: string, value: string) =>
    setFilters({ ...filters, [name]: value });
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
      {visible.length > 0 && (
        <ol className="decision-records" aria-label="拍板记录列表">
          {visible.map((q) => (
            <li key={q.id}>
              <DecisionRecord
                q={q}
                projectId={projectId}
                makerLabel={makerLabels[q.decision_maker]}
              />
            </li>
          ))}
        </ol>
      )}
      {cursor && (
        <button
          type="button"
          className="decision-records-more"
          disabled={loadingMore}
          onClick={more}
        >
          加载更多
        </button>
      )}
      <RequestFeedback
        interactive
        pending={loadingMore}
        pendingMessage="正在加载更多拍板记录…"
        error={moreError}
        retry={more}
      />
    </section>
  );
}
