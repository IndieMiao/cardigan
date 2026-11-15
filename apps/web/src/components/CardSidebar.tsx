import { useState } from "react";
import {
  type CardDetail,
  type CardiganClient,
  type DecisionView,
  describeWriteError,
  type WorkItemView,
} from "../api.js";
import { decisionTitle } from "../decision-labels.js";
import { isHttpLink } from "../markdown.js";
import { routeHash } from "../route.js";
import { SUGGESTION_COPY } from "../suggestion-copy.js";
import { DecisionAffectedCards } from "./DecisionAffectedCards.js";
import { DecisionRouting } from "./DecisionRouting.js";
import { NextOwners } from "./EmployeeIdentity.js";
import { EmptyState, IdTag, StatusTag } from "./Foundation.js";
import { PlainSummary } from "./PlainSummary.js";

export function CardSidebar({
  detail,
  projectId,
  cardId,
}: {
  detail: CardDetail;
  projectId: string;
  cardId: string;
}) {
  const { card, work_items, relations } = detail;
  const completed = work_items.filter((w) =>
    ["accepted", "passed"].includes(w.status),
  ).length;
  const link = (anchor: string) =>
    routeHash({ kind: "card", projectId, cardId, anchor });
  return (
    <aside className="card-sidebar" aria-label="卡片概况">
      <details>
        <summary>卡片索引与关联</summary>
        <section aria-label="当前进度">
          <dl className="questions">
            <div>
              <dt>进行到哪一步</dt>
              <dd>
                <StatusTag status={card.status} />
                <span>
                  工作项 {completed}/{work_items.length} 完成
                </span>
              </dd>
            </div>
            <div>
              <dt>下一步该谁做</dt>
              <dd>
                <NextOwners owners={card.next_owners} />
              </dd>
            </div>
            <div>
              <dt>被什么阻塞</dt>
              <dd>
                {card.waiting_on.length
                  ? card.waiting_on.map((w) => w.label).join("；")
                  : "没有被阻塞"}
              </dd>
            </div>
          </dl>
        </section>
        <section aria-label="验收责任">
          <details>
            <summary>谁验收、依据是什么</summary>
            <ul className="plain-list">
              {work_items
                .filter((w) => w.kind === "verify")
                .map((w) => {
                  const latest = [...detail.review_matrix]
                    .reverse()
                    .find((r) => r.work_item_id === w.id);
                  return (
                    <li key={w.id}>
                      {w.role_id}：
                      {latest?.verdict ? (
                        <StatusTag status={latest.verdict} />
                      ) : (
                        "还没有结论"
                      )}
                      {w.completion_criteria.length > 0 &&
                        `，依据 ${w.completion_criteria.join("；")}`}
                    </li>
                  );
                })}
            </ul>
          </details>
        </section>
        {!!relations.decisions.length && (
          <section aria-label="拍板">
            <h2>拍板（{relations.decisions.length}）</h2>
            <ul className="plain-list">
              {relations.decisions.map((d) => (
                <li
                  key={d.id}
                  id={
                    detail.timeline.some((e) => e.decision_id === d.id)
                      ? `decision-summary-${d.id}`
                      : `decision-${d.id}`
                  }
                >
                  <IdTag
                    id={d.id}
                    label="拍板"
                    detail={d.question}
                    href={link(`decision-${d.id}`)}
                  />{" "}
                  <StatusTag status={d.status} />
                  {d.blocking &&
                    ![
                      "resolved",
                      "withdrawn",
                      "superseded",
                      "revoked",
                    ].includes(d.status) && <span>阻塞中</span>}
                  <p>
                    {decisionTitle(
                      detail.decisions.find((q) => q.id === d.id) ?? d,
                    )}
                  </p>
                  <OpenPlainSummary
                    decision={detail.decisions.find((q) => q.id === d.id)}
                  />
                  <SuggestionLine
                    decision={detail.decisions.find((q) => q.id === d.id)}
                  />
                  <DecisionAffectedCards
                    decision={detail.decisions.find((q) => q.id === d.id)}
                    projectId={projectId}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}
        <section aria-label="关联">
          <h2>关联</h2>
          {!relations.cards.length && !relations.pull_requests.length && (
            <EmptyState>没有关联卡片或 PR。</EmptyState>
          )}
          <ul className="plain-list">
            {relations.cards.map((c) => (
              <li key={c.id}>
                <IdTag
                  id={c.id}
                  label={c.title}
                  href={routeHash({ kind: "card", projectId, cardId: c.id })}
                />{" "}
                <StatusTag status={c.status} />
              </li>
            ))}
          </ul>
          <ul className="plain-list">
            {relations.pull_requests.map((p) => (
              <li key={p.delivery_id}>
                {isHttpLink(p.pr_url) ? (
                  <a href={p.pr_url} target="_blank" rel="noopener noreferrer">
                    {p.pr_url}
                  </a>
                ) : (
                  <span className="plain-url">{p.pr_url}</span>
                )}
                <p>
                  {p.work_item_id}（<StatusTag status={p.status} />）
                </p>
              </li>
            ))}
          </ul>
        </section>
      </details>
    </aside>
  );
}

export function CardWorkItems({
  detail,
  projectId,
  cardId,
  client,
  changed,
}: {
  detail: CardDetail;
  projectId: string;
  cardId: string;
  client?: CardiganClient;
  changed?: () => void;
}) {
  const work_items = detail.work_items;
  const completed = work_items.filter((w) =>
    ["accepted", "passed"].includes(w.status),
  ).length;
  const link = (anchor: string) =>
    routeHash({ kind: "card", projectId, cardId, anchor });
  return (
    <section className="card-section" aria-label="工作项">
      <details className="work-items">
        <summary>
          工作项（{completed}/{work_items.length} 完成）
        </summary>
        {!work_items.length && <EmptyState>这张卡还没有工作项。</EmptyState>}
        <ul className="work-item-list">
          {work_items.map((item) => {
            const delivery = [...detail.deliveries]
              .reverse()
              .find(
                (d) => d.work_item_id === item.id && d.status !== "superseded",
              );
            return (
              <li
                key={item.id}
                id={`work-item-${item.id}`}
                className="work-item"
              >
                <details>
                  <summary>
                    <span className="work-item-caption">
                      <IdTag id={item.id} label={item.title} />{" "}
                      <StatusTag
                        status={
                          item.verification_activity?.status ?? item.status
                        }
                        {...(item.verification_activity
                          ? { label: item.verification_activity.label }
                          : {})}
                      />
                      {item.manual_assign && <span>手动指派</span>}
                    </span>
                  </summary>
                  <p>
                    {item.assignment_id ? (
                      <IdTag id={item.assignment_id} label={item.role_id} />
                    ) : (
                      `尚未指派 ${item.role_id}`
                    )}
                  </p>
                  {client &&
                    !["done", "cancelled"].includes(detail.card.status) && (
                      <ManualAssignControl
                        key={`${item.id}:${item.manual_assign}`}
                        item={item}
                        client={client}
                        projectId={projectId}
                        changed={changed}
                      />
                    )}
                  {delivery && (
                    <p>
                      <IdTag
                        id={delivery.id}
                        label="交付"
                        href={link(`delivery-${delivery.id}`)}
                      />{" "}
                      <StatusTag status={delivery.status} />
                    </p>
                  )}
                  <p>
                    依据：
                    {item.completion_criteria.join("；") || "未列出验收依据"}
                  </p>
                </details>
              </li>
            );
          })}
        </ul>
      </details>
    </section>
  );
}

/** C-192: read-only suggestion; one-click handling lives in Needs You. */
function SuggestionLine({
  decision,
}: {
  readonly decision: DecisionView | undefined;
}) {
  const s = decision?.suggestion;
  if (
    !decision ||
    !s ||
    !["open", "provisional", "snoozed"].includes(decision.status)
  )
    return null;
  const label =
    decision.trigger === "merge_confirmation"
      ? (SUGGESTION_COPY.mergeOptions[s.option] ?? s.option)
      : (decision.options.find((o) => o.key === s.option)?.description ??
        s.option);
  return (
    <p className="hint">
      {SUGGESTION_COPY.line(label, s.rationale)}
      {s.stale && (
        <>
          {" "}
          <StatusTag status="superseded" label={SUGGESTION_COPY.stale} />
        </>
      )}
    </p>
  );
}

/** C-202: the plain summary of an open decision, first thing under its title. */
function OpenPlainSummary({
  decision,
}: {
  readonly decision: DecisionView | undefined;
}) {
  if (
    !decision ||
    !["open", "provisional", "snoozed"].includes(decision.status)
  )
    return null;
  return (
    <>
      <PlainSummary id={decision.id} summary={decision.plain_summary} compact />
      <DecisionRouting decision={decision} />
    </>
  );
}

function ManualAssignControl({
  item,
  client,
  projectId,
  changed,
}: {
  item: WorkItemView;
  client: CardiganClient;
  projectId: string;
  changed?: (() => void) | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div>
      <label>
        <input
          type="checkbox"
          checked={item.manual_assign === true}
          disabled={busy}
          onChange={async (e) => {
            const enabled = e.target.checked;
            setBusy(true);
            setError("");
            try {
              await client.setManualAssign(
                projectId,
                item.id,
                enabled,
                crypto.randomUUID(),
              );
              changed?.();
            } catch (failure) {
              setError(describeWriteError(failure));
            } finally {
              setBusy(false);
            }
          }}
        />
        手动指派（跳过自动指派和催办）
      </label>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
