// biome-ignore-all lint/suspicious/noArrayIndexKey: delivery and review arrays are immutable record snapshots with no item IDs.

import type { ReactNode } from "react";
import type { CardDetail, TimelineEntryView } from "../api.js";
import { decisionOption, decisionTitle } from "../decision-labels.js";
import { routeHash } from "../route.js";
import { DecisionAffectedCards } from "./DecisionAffectedCards.js";
import { DecisionAttachments } from "./DecisionAttachments.js";
import { EmployeeIdentity } from "./EmployeeIdentity.js";
import { IdTag, LongContent, StatusTag } from "./Foundation.js";
import { Markdown } from "./Operations.js";
import { TimelineHeader } from "./TimelineHeader.js";
import { TimelineVersion } from "./TimelineVersion.js";

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
  const workLabel = (id: string) =>
    detail.work_items.find((w) => w.id === id)?.title ?? "工作项";
  const heading = (type: string, id: string, result: ReactNode) => (
    <TimelineHeader
      entry={entry}
      action={
        type === "完成申请"
          ? "提交完成申请"
          : type === "交付"
            ? "提交交付"
            : type === "审核"
              ? "提交审核"
              : entry.type === "decision_request"
                ? "请求拍板"
                : "记录拍板"
      }
      conclusion={
        <h4 className="timeline-conclusion">
          <span>
            {type} {id}
          </span>{" "}
          {result}
        </h4>
      }
    />
  );
  if (entry.type === "delivery") {
    const delivery = detail.deliveries.find((d) => d.id === entry.delivery_id);
    if (!delivery) return null;
    return (
      <div className="structured-entry">
        {heading(
          delivery.kind === "card_completion" ? "完成申请" : "交付",
          delivery.id,
          <StatusTag status={delivery.status} />,
        )}
        <p className="entry-summary">{delivery.summary}</p>
        <div className="entry-meta">
          <IdTag
            id={delivery.work_item_id}
            label={workLabel(delivery.work_item_id)}
            href={link(`work-item-${delivery.work_item_id}`)}
          />
          <TimelineVersion
            value={delivery.subject.value}
            git={delivery.subject.kind === "git_head"}
          />
          {delivery.supersedes && (
            <span>
              替代{" "}
              <IdTag
                id={delivery.supersedes}
                label="旧交付"
                href={link(`delivery-${delivery.supersedes}`)}
              />
            </span>
          )}
        </div>
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
        {heading("审核", review.id, <StatusTag status={review.verdict} />)}
        <p className="entry-summary">
          {review.issues?.length
            ? `报告 ${review.issues.length} 个问题。`
            : "未报告问题。"}
          {review.recheck_required && "需要复审。"}
          {delivery?.status === "superseded" && <span>旧版本结论，已失效</span>}
        </p>
        <div className="entry-meta">
          <IdTag
            id={review.work_item_id}
            label={workLabel(review.work_item_id)}
            href={link(`work-item-${review.work_item_id}`)}
          />
          <IdTag
            id={review.delivery_id}
            label="交付"
            href={link(`delivery-${review.delivery_id}`)}
          />
          {review.target_sha ? (
            <TimelineVersion
              value={review.target_sha}
              git={!delivery || delivery.subject.kind === "git_head"}
            />
          ) : (
            <span>版本未记录</span>
          )}
        </div>
        <details>
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
    const resolved = entry.type === "decision_resolved";
    const status = resolved
      ? entry.event_type === "decision_provisionally_resolved"
        ? "provisional"
        : "resolved"
      : decision.status;
    return (
      <div className="structured-entry">
        {heading(
          "拍板",
          decision.id,
          resolved &&
            decision.trigger === "merge_confirmation" &&
            entry.decision_option ? (
            <StatusTag
              status={status}
              label={
                entry.decision_via === "delegated"
                  ? entry.decision_delegate === "pm"
                    ? `PM 代确认：${decisionOption(decision, entry.decision_option)}`
                    : "自动合并（代批）"
                  : decisionOption(decision, entry.decision_option)
              }
            />
          ) : resolved &&
            decision.trigger !== "merge_confirmation" &&
            entry.decision_via === "delegated" ? (
            <StatusTag status={status} label="已拍板（PM 代拍）" />
          ) : (
            <StatusTag status={status} />
          ),
        )}
        <p className="entry-summary">{decisionTitle(decision)}</p>
        <DecisionAffectedCards decision={decision} projectId={projectId} />
        {!resolved && (
          <DecisionAttachments attachments={decision.attachments} />
        )}
        {!resolved && decision.auto_merge && (
          <p className="hint">
            将于{" "}
            {new Date(decision.auto_merge.due_at).toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}{" "}
            自动合并（偏好设置：{decision.auto_merge.minutes} 分钟）
          </p>
        )}
        <div className="entry-meta">
          <span>
            {resolved ? (
              "已记录拍板原话"
            ) : decision.decider === "human" ? (
              <>
                由{" "}
                <EmployeeIdentity
                  {...decision.decider_view}
                  author="human"
                  showTitle={false}
                />{" "}
                拍板
              </>
            ) : (
              "由指定角色拍板"
            )}
          </span>
          {!resolved && decision.blocking && <span>影响工作继续</span>}
        </div>
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
            {decision.trigger !== "merge_confirmation" && (
              <p>
                记录的结果：
                {entry.decision_option
                  ? decisionOption(decision, entry.decision_option)
                  : "原记录未附选项"}
              </p>
            )}
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
