import { useCallback, useEffect } from "react";
import {
  ApiError,
  type CardDetail,
  type CardiganClient,
  type CardView,
  type WorkItemView,
} from "../api.js";
import { CommentBox, type MentionOption } from "../components/CommentBox.js";
import {
  EmptyState,
  IdTag,
  LongContent,
  PageTitle,
  StatusTag,
} from "../components/Foundation.js";
import { Timeline } from "../components/Timeline.js";
import { isHttpLink } from "../markdown.js";
import { routeHash } from "../route.js";
import {
  cardStatusLabel,
  type nextOwnerLabel,
  nextOwnersLabel,
  statusLabel,
} from "../status.js";
import { useResource } from "../useResource.js";

/**
 * The card page (M5 plan §3.7, §4 M5.3; development plan §8.4).
 *
 * The header answers the five questions the plan lists — goal, progress, who is
 * next, what blocks it, who accepts it and on what basis — before any timeline
 * entry is read. Below it: the collapsible work item list, the 关联区 and the
 * timeline with the comment box on top.
 */

export interface CardDetailPageProps {
  readonly client: CardiganClient;
  readonly projectId: string;
  readonly cardId: string;
  /** Route location (element id) to reveal once the card has loaded. */
  readonly anchor?: string;
  readonly revision?: number;
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "missing" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly detail: CardDetail };

export const workItemStatusLabel = statusLabel;

export function CardDetailPage({
  client,
  projectId,
  cardId,
  anchor,
  revision = 0,
}: CardDetailPageProps) {
  const load = useCallback(async () => {
    try {
      return await client.card(projectId, cardId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }, [client, projectId, cardId]);
  const { data, error, reload } = useResource(load, revision);
  const state: LoadState =
    data === null
      ? { kind: "missing" }
      : data
        ? { kind: "ready", detail: data }
        : error
          ? { kind: "error", message: error }
          : { kind: "loading" };
  const back = routeHash({ kind: "board", projectId });

  // The location lives in the route (``?at=``), so a reload or a copied URL
  // finds the same row. `getElementById` accepts ids such as `q(2)` and
  // `C-1#7` without CSS escaping (M5.S S23).
  useEffect(() => {
    if (state.kind !== "ready" || anchor === undefined) return;
    document.getElementById(anchor)?.scrollIntoView?.({ block: "start" });
  }, [anchor, state.kind]);

  if (state.kind === "loading") {
    return (
      <p className="loading" role="status">
        正在加载卡片 {cardId}…
      </p>
    );
  }
  if (state.kind === "missing") {
    return (
      <div className="empty">
        <EmptyState>找不到卡片 {cardId}。请核对编号或返回看板。</EmptyState>
        <a href={back}>返回到看板</a>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="error-panel" role="alert">
        <p>{state.message}</p>
        <button type="button" onClick={reload}>
          重试
        </button>
      </div>
    );
  }

  const { detail } = state;
  return (
    <article className="card-page" aria-label={`卡片 ${cardId}`}>
      {error && (
        <p role="alert" className="error-panel">
          {error}{" "}
          <button type="button" onClick={reload}>
            重试
          </button>
        </p>
      )}
      <CardHeader detail={detail} back={back} />
      <WorkItems detail={detail} />
      <Relations detail={detail} projectId={projectId} cardId={cardId} />
      <section className="card-section" aria-label="时间线">
        <h2>时间线</h2>
        <CommentBox
          client={client}
          projectId={projectId}
          cardId={cardId}
          mentions={mentionOptions(detail)}
          onPosted={() => reload()}
        />
        <Timeline
          projectId={projectId}
          cardId={cardId}
          entries={detail.timeline}
          attachments={detail.attachments}
        />
      </section>
    </article>
  );
}

/** The five questions, answered before the timeline (§8.4). */
function CardHeader({
  detail,
  back,
}: {
  readonly detail: CardDetail;
  readonly back: string;
}) {
  const card = detail.card;
  const verifyItems = detail.work_items.filter(
    (item) => item.kind === "verify",
  );
  const verdicts = verifyItems.map((item) => {
    const row = [...detail.review_matrix]
      .reverse()
      .find((entry) => entry.work_item_id === item.id);
    return {
      role: item.role_id,
      verdict: row?.verdict ?? null,
      criteria: item.completion_criteria,
    };
  });

  return (
    <header className="card-header">
      <p className="breadcrumb">
        <a href={back}>← 返回看板</a>
      </p>
      <PageTitle
        title={
          <>
            <IdTag id={card.id} label="卡片" /> {card.title}
          </>
        }
        description={card.why}
      />
      <p className="card-status-line">
        <StatusTag status={card.status} />
      </p>
      <dl className="questions">
        <div>
          <dt>目标是什么</dt>
          <dd>
            <LongContent>
              <p>{card.goal}</p>
            </LongContent>
            <ul className="plain-list">
              {(card.acceptance_criteria ?? []).map((criterion) => (
                <li key={criterion}>验收标准：{criterion}</li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>进行到哪一步</dt>
          <dd>
            <p>{progressLine(detail)}</p>
            {detail.deliveries.length > 0 && (
              <p className="card-why">
                最近交付：{detail.deliveries.at(-1)?.summary}
              </p>
            )}
          </dd>
        </div>
        <div>
          <dt>下一步该谁做</dt>
          <dd>{nextOwnersLabel(card.next_owners)}</dd>
        </div>
        <div>
          <dt>被什么阻塞</dt>
          <dd>
            {card.waiting_on.length === 0
              ? "没有被阻塞"
              : card.waiting_on.map((waiting) => waiting.label).join("；")}
          </dd>
        </div>
        <div>
          <dt>谁验收、依据是什么</dt>
          <dd>
            {verdicts.length === 0 ? (
              "没有配置验证工作项"
            ) : (
              <ul className="plain-list">
                {verdicts.map((entry) => (
                  <li key={entry.role}>
                    {entry.role}：{verdictLabel(entry.verdict)}
                    {entry.criteria.length > 0 &&
                      `，依据 ${entry.criteria.join("；")}`}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
    </header>
  );
}

function progressLine(detail: CardDetail): string {
  const total = detail.work_items.length;
  const finished = detail.work_items.filter(
    (item) => item.status === "accepted" || item.status === "passed",
  ).length;
  const openDecisions = detail.counts.open_decisions;
  const parts = [`工作项 ${finished}/${total} 完成`];
  if (openDecisions > 0) parts.push(`${openDecisions} 项待拍板`);
  if (detail.human_actions.length > 0) {
    parts.push(`${detail.human_actions.length} 项待你执行`);
  }
  return parts.join("，");
}

export function verdictLabel(verdict: string | null): string {
  return verdict === null ? "还没有结论" : statusLabel(verdict);
}

function WorkItems({ detail }: { readonly detail: CardDetail }) {
  return (
    <section className="card-section" aria-label="工作项">
      <details className="work-items" open>
        <summary>工作项（{detail.work_items.length}）</summary>
        {detail.work_items.length === 0 ? (
          <EmptyState>
            这张卡还没有工作项。PM 拆分任务后会在这里显示。
          </EmptyState>
        ) : (
          <ul className="work-item-list">
            {detail.work_items.map((item) => (
              <WorkItemRow key={item.id} item={item} detail={detail} />
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}

function WorkItemRow({
  item,
  detail,
}: {
  readonly item: WorkItemView;
  readonly detail: CardDetail;
}) {
  const delivery = [...detail.deliveries]
    .reverse()
    .find((entry) => entry.work_item_id === item.id);
  return (
    <li className="work-item" id={`work-item-${item.id}`}>
      <div className="work-item-head">
        <IdTag id={item.id} label={item.title} />
        <StatusTag status={item.status} />
        <span className="work-item-role">{item.role_id}</span>
      </div>
      <p className="card-why">
        {item.assignment_id === undefined ? (
          "还没有 Assignment"
        ) : (
          <IdTag id={item.assignment_id} label={item.role_id} />
        )}
        {delivery === undefined ? (
          "；还没有交付"
        ) : (
          <>
            {" "}
            <IdTag id={delivery.id} label="交付" detail={delivery.summary} />{" "}
            <StatusTag status={delivery.status} />
          </>
        )}
      </p>
    </li>
  );
}

export const deliveryStatusLabel = statusLabel;

/** §8.4 关联区: decisions, related cards and pull requests. */
function Relations({
  detail,
  projectId,
  cardId,
}: {
  readonly detail: CardDetail;
  readonly projectId: string;
  readonly cardId: string;
}) {
  const { decisions, cards, pull_requests } = detail.relations;
  return (
    <section className="card-section" aria-label="关联">
      <h2>关联</h2>
      <div className="relations">
        <div>
          <h3>拍板</h3>
          {decisions.length === 0 ? (
            <EmptyState>没有相关拍板。</EmptyState>
          ) : (
            <ul className="plain-list">
              {decisions.map((decision) => (
                <li key={decision.id} id={`decision-${decision.id}`}>
                  <IdTag
                    id={decision.id}
                    label="拍板"
                    detail={decision.question}
                    href={routeHash({
                      kind: "card",
                      projectId,
                      cardId,
                      anchor: `decision-${decision.id}`,
                    })}
                  />
                  <StatusTag status={decision.status} />
                  {decision.blocking && (
                    <span className="card-why">阻塞中</span>
                  )}
                  <span className="card-why">{decision.question}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3>卡片</h3>
          {cards.length === 0 ? (
            <EmptyState>没有关联卡片。</EmptyState>
          ) : (
            <ul className="plain-list">
              {cards.map((related) => (
                <li key={related.id}>
                  <IdTag
                    id={related.id}
                    label="卡片"
                    detail={related.title}
                    href={routeHash({
                      kind: "card",
                      projectId,
                      cardId: related.id,
                    })}
                  />
                  <span className="card-why">
                    {related.title}（{cardStatusLabel(related.status)}）
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3>PR</h3>
          {pull_requests.length === 0 ? (
            <EmptyState>没有 PR。</EmptyState>
          ) : (
            <ul className="plain-list">
              {pull_requests.map((pull) => (
                <li key={pull.delivery_id}>
                  {/* The URL comes from an Agent's delivery; a scheme we do not
                      allow is shown as text instead of becoming a link. */}
                  {isHttpLink(pull.pr_url) ? (
                    <a
                      href={pull.pr_url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {pull.pr_url}
                    </a>
                  ) : (
                    <span className="plain-url">{pull.pr_url}</span>
                  )}
                  <span className="card-why">
                    {pull.work_item_id}（{deliveryStatusLabel(pull.status)}）
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

/** `@` suggestions: the roles and Assignments this card already knows. */
export function mentionOptions(detail: CardDetail): MentionOption[] {
  const options = new Map<string, MentionOption>();
  for (const item of detail.work_items) {
    options.set(item.role_id, {
      value: item.role_id,
      label: `角色 ${item.role_id}`,
    });
    if (item.assignment_id !== undefined) {
      options.set(item.assignment_id, {
        value: item.assignment_id,
        label: `Assignment ${item.assignment_id}`,
      });
    }
  }
  for (const owner of detail.card.next_owners) {
    if (owner.kind === "role") {
      options.set(owner.ref, { value: owner.ref, label: `角色 ${owner.ref}` });
    }
    if (owner.kind === "assignment") {
      options.set(owner.ref, {
        value: owner.ref,
        label: `Assignment ${owner.ref}`,
      });
    }
  }
  return [...options.values()];
}

export type { CardView, nextOwnerLabel };
