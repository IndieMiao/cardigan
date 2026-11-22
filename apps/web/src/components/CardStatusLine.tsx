import type { ReactNode } from "react";
import type { CardDetail } from "../api.js";
import {
  cardChecking,
  MERGE_CHECK_LABEL,
  PRECHECK_LABEL,
} from "../card-checking.js";
import { NextOwners } from "./EmployeeIdentity.js";
import { StatusTag } from "./Foundation.js";
import { MergeStatusFacts } from "./MergeStatusLine.js";
import { PlainSummaryRisk } from "./PlainSummary.js";

const nextStep = {
  decision: "处理拍板",
  human_action: "处理人工事项",
  review: "完成审核",
  blocked: "解除阻塞",
} as const;

export function CardStatusLine({
  detail,
  projectId,
  metadata,
}: {
  readonly detail: CardDetail;
  readonly projectId?: string;
  readonly metadata?: ReactNode;
}) {
  const { card } = detail;
  const confirmations = detail.merge_confirmations ?? [];
  // C-567: blockers that only wait for a running precheck read as “预检中”.
  const checks = cardChecking(card);
  const precheckLog = card.prechecks?.find(
    (check) =>
      card.checking?.precheck?.attempt_ids.includes(check.attempt_id) &&
      check.log_ref === `${check.attempt_id}.log` &&
      /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(check.attempt_id),
  );
  const waiting = checks.waiting.filter(
    (item) => !confirmations.some((q) => q.id === item.ref),
  );
  const owners = card.next_owners.filter(
    (owner) =>
      !confirmations.some(
        (q) =>
          (owner.kind === "human" &&
            (q.decider === "human" || q.status === "resolved")) ||
          (q.decider === "role:pm" &&
            (owner.ref === "pm" ||
              owner.author_role === "pm" ||
              owner.employee?.role_id === "pm")),
      ),
  );
  const steps: string[] = [
    ...new Set(
      waiting.map((item) =>
        item.kind === "review" &&
        (detail.overview?.waiting_delivery.includes(item.ref) ||
          detail.work_items.some(
            (w) =>
              w.id === item.ref &&
              w.verification_activity?.status === "waiting_delivery",
          ))
          ? "提交新交付"
          : nextStep[item.kind],
      ),
    ),
  ];
  if (confirmations.length) steps.unshift("处理合并确认");
  const next = steps.length
    ? steps.join("、")
    : !["done", "cancelled"].includes(card.status) && card.next_owners.length
      ? card.status === "review"
        ? "完成审核"
        : "处理工作项"
      : undefined;
  const statusLine = (
    <section
      className="decision-status-line card-metadata"
      aria-label="卡片状态"
    >
      <StatusTag status={card.status} />
      {confirmations.map((q) => (
        <MergeStatusFacts key={q.id} q={q} />
      ))}
      {owners.length > 0 && (
        <span className="card-waiting-owner">
          等谁：
          <NextOwners owners={owners} />
        </span>
      )}
      {checks.precheck &&
        (precheckLog && projectId ? (
          <a
            href={`/api/projects/${encodeURIComponent(projectId)}/prechecks/${encodeURIComponent(precheckLog.attempt_id)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {PRECHECK_LABEL}
          </a>
        ) : (
          <span>{PRECHECK_LABEL}</span>
        ))}
      {checks.mergeCheck && <span>{MERGE_CHECK_LABEL}</span>}
      {waiting.map((item) => (
        <span key={`${item.kind}/${item.ref}`}>
          {card.hold && item.ref === card.id
            ? "已暂停，见下方说明"
            : item.kind === "human_action"
              ? "人工待办阻塞"
              : item.label}
        </span>
      ))}
      {next && <span>下一步：{next}</span>}
      {metadata}
    </section>
  );
  return (
    <>
      {statusLine}
      {confirmations.map((q) => (
        <dl className="card-key-risk plain-summary" key={q.id}>
          <PlainSummaryRisk risk={q.plain_summary?.risk ?? "风险尚未说明"} />
        </dl>
      ))}
      {waiting
        .filter(
          (item) =>
            !(card.hold && item.ref === card.id) &&
            (item.kind === "human_action" || item.kind === "blocked"),
        )
        .map((item) => (
          <p className="merge-exception" key={item.ref}>
            {item.label}
          </p>
        ))}
    </>
  );
}
