import type { CardDetail } from "../api.js";
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

export function CardStatusLine({ detail }: { readonly detail: CardDetail }) {
  const { card } = detail;
  const confirmations = detail.merge_confirmations ?? [];
  const waiting = card.waiting_on.filter(
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
    ...new Set(waiting.map((item) => nextStep[item.kind])),
  ];
  if (confirmations.length) steps.unshift("处理合并确认");
  return (
    <>
      <section className="decision-status-line" aria-label="卡片状态">
        <StatusTag status={card.status} />
        {confirmations.map((q) => (
          <MergeStatusFacts key={q.id} q={q} />
        ))}
        {(!confirmations.length || owners.length > 0) && (
          <span className="card-waiting-owner">
            等谁：
            {owners.length ? <NextOwners owners={owners} /> : "待明确"}
          </span>
        )}
        {waiting.map((item) => (
          <span key={`${item.kind}/${item.ref}`}>
            {item.kind === "human_action" ? "人工待办阻塞" : item.label}
          </span>
        ))}
        <span>
          下一步：
          {steps.length
            ? steps.join("、")
            : card.status === "done" || card.status === "cancelled"
              ? "无"
              : card.next_owners.length
                ? card.status === "review"
                  ? "完成审核"
                  : "处理工作项"
                : "待明确"}
        </span>
      </section>
      {confirmations.map((q) => (
        <dl className="card-key-risk plain-summary" key={q.id}>
          <PlainSummaryRisk risk={q.plain_summary?.risk ?? "风险尚未说明"} />
        </dl>
      ))}
      {waiting
        .filter(
          (item) => item.kind === "human_action" || item.kind === "blocked",
        )
        .map((item) => (
          <p className="merge-exception" key={item.ref}>
            {item.label}
          </p>
        ))}
      {!confirmations.length && !waiting.length && card.why && (
        <p className="hint">{card.why}</p>
      )}
    </>
  );
}
