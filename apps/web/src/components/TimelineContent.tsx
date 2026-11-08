// biome-ignore-all lint/suspicious/noArrayIndexKey: delivery and review arrays are immutable record snapshots with no item IDs.
import type { CardDetail, TimelineEntryView } from "../api.js";
import { decisionOption, decisionTitle } from "../decision-labels.js";
import { routeHash } from "../route.js";
import { IdTag, LongContent, StatusTag } from "./Foundation.js";
import { Markdown } from "./Operations.js";

/** Structural records come from the read model, never from parsing Agent prose. */
export function TimelineContent({
  entry,
  detail,
  projectId,
  cardId,
}: {
  entry: TimelineEntryView;
  detail: CardDetail;
  projectId: string;
  cardId: string;
}) {
  const link = (anchor: string) =>
    routeHash({ kind: "card", projectId, cardId, anchor });
  const work = detail.work_items.find((w) => w.id === entry.work_item_id);
  if (entry.type === "delivery") {
    const delivery = detail.deliveries.find((d) => d.id === entry.delivery_id);
    if (!delivery) return null;
    return (
      <div className="structured-entry">
        <p>
          <IdTag
            id={delivery.id}
            label={delivery.kind === "card_completion" ? "完成申请" : "交付"}
          />{" "}
          <strong>{delivery.summary}</strong>
        </p>
        <dl className="entry-fields">
          <dt>工作项</dt>
          <dd>
            <IdTag
              id={delivery.work_item_id}
              label={work?.title ?? "工作项"}
              href={link(`work-item-${delivery.work_item_id}`)}
            />
          </dd>
          <dt>{delivery.subject.kind === "git_head" ? "提交" : "版本"}</dt>
          <dd>{delivery.subject.value}</dd>
          <dt>当前状态</dt>
          <dd>
            <StatusTag status={delivery.status} />
            {delivery.supersedes && (
              <>
                {" "}
                替代{" "}
                <IdTag
                  id={delivery.supersedes}
                  label="旧交付"
                  href={link(`delivery-${delivery.supersedes}`)}
                />
              </>
            )}
          </dd>
        </dl>
        <details>
          <summary>
            测试结果与证据（{delivery.test_results?.length ?? 0} 项测试）
          </summary>
          {!delivery.test_results?.length && <p>未附测试结果。</p>}
          {delivery.test_results?.map((t, i) => (
            <div key={`${i}-${t.command}`}>
              <code>{t.command}</code>
              <Markdown body={t.result} />
            </div>
          ))}
          {!!delivery.evidence?.length && (
            <LongContent>
              <pre>{JSON.stringify(delivery.evidence, null, 2)}</pre>
            </LongContent>
          )}
          {delivery.known_gaps?.map((g, i) => (
            <p key={`${i}-${g.description}`}>
              已知遗留：{g.description}{" "}
              {g.followup_card_id && (
                <IdTag
                  id={g.followup_card_id}
                  label="后续卡片"
                  href={routeHash({
                    kind: "card",
                    projectId,
                    cardId: g.followup_card_id,
                  })}
                />
              )}
            </p>
          ))}
        </details>
      </div>
    );
  }
  if (entry.type === "review") {
    const review = detail.reviews.find((r) => r.id === entry.review_id);
    if (!review) return null;
    const delivery = detail.deliveries.find((d) => d.id === review.delivery_id);
    return (
      <div className="structured-entry">
        <p>
          <IdTag id={review.id} label="审核" />{" "}
          <StatusTag status={review.verdict} />{" "}
          {delivery?.status === "superseded" && <span>旧版本结论，已失效</span>}
        </p>
        <dl className="entry-fields">
          <dt>验证项</dt>
          <dd>
            <IdTag
              id={review.work_item_id}
              label={work?.title ?? "验证项"}
              href={link(`work-item-${review.work_item_id}`)}
            />
          </dd>
          <dt>审核版本</dt>
          <dd>
            <IdTag
              id={review.delivery_id}
              label="交付"
              href={link(`delivery-${review.delivery_id}`)}
            />{" "}
            {review.target_sha ?? "版本未记录"}
          </dd>
        </dl>
        <details open={review.blocking}>
          <summary>
            问题列表（{review.issues?.length ?? 0}）
            {review.recheck_required ? "，需要复审" : ""}
          </summary>
          {!review.issues?.length && <p>未报告问题。</p>}
          {review.issues?.map((issue, i) => (
            <div key={`${i}-${issue.description}`}>
              <p>
                {(
                  { critical: "严重", major: "主要", minor: "次要" } as Record<
                    string,
                    string
                  >
                )[issue.severity] ?? "问题"}
                ，{issue.must_fix ? "必须修复" : "建议"}
                {issue.pre_existing ? "，既有问题" : ""}
              </p>
              <Markdown body={issue.description} />
              {issue.proof && <Markdown body={`依据：${issue.proof}`} />}
            </div>
          ))}
        </details>
      </div>
    );
  }
  if (entry.type === "decision_request" || entry.type === "decision_resolved") {
    const decision = detail.decisions.find((d) => d.id === entry.decision_id);
    if (!decision) return null;
    return (
      <div className="structured-entry">
        <p>
          <IdTag id={decision.id} label="拍板" />{" "}
          <strong>{decisionTitle(decision)}</strong>
        </p>
        {entry.type === "decision_request" ? (
          <details>
            <summary>背景与选项</summary>
            {decision.context && <Markdown body={decision.context} />}
            {decision.options.map((o) => (
              <div key={o.key}>
                <strong>
                  {o.key}：{decisionOption(decision, o.key)}
                  {o.key === decision.recommended ? "（推荐）" : ""}
                </strong>
                <Markdown body={`影响：${o.impact}`} />
              </div>
            ))}
          </details>
        ) : (
          <>
            <p>
              记录的结果：
              {entry.decision_option
                ? decisionOption(decision, entry.decision_option)
                : "原记录未附选项"}
            </p>
            <blockquote>
              <Markdown body={entry.body} />
            </blockquote>
          </>
        )}
      </div>
    );
  }
  return null;
}
