import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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

export function CardStatusLine({
  detail,
  metadata,
}: {
  readonly detail: CardDetail;
  readonly metadata?: ReactNode;
}) {
  const metadataRow = useRef<HTMLElement>(null);
  const [hasMore, setHasMore] = useState(false);
  const measure = useCallback(() => {
    const el = metadataRow.current;
    if (el) setHasMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);
  useLayoutEffect(measure);
  useEffect(() => {
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    if (metadataRow.current) observer?.observe(metadataRow.current);
    return () => observer?.disconnect();
  }, [measure]);
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
    ...new Set(
      waiting.map((item) =>
        item.kind === "review" &&
        detail.work_items.some(
          (w) =>
            w.id === item.ref &&
            w.verification_activity?.status === "waiting_delivery",
        )
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
  return (
    <>
      <section
        className="decision-status-line card-metadata"
        ref={metadataRow}
        data-more={hasMore || undefined}
        onScroll={measure}
        aria-label="卡片状态"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: horizontal metadata must be keyboard scrollable.
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const el = event.currentTarget;
          const next =
            event.key === "ArrowRight"
              ? el.scrollLeft + 80
              : event.key === "ArrowLeft"
                ? el.scrollLeft - 80
                : event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? el.scrollWidth
                    : undefined;
          if (next === undefined) return;
          event.preventDefault();
          el.scrollLeft = next;
        }}
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
