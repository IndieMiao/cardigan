import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import type { CardDetail, DeliveryView, ReviewView } from "../api.js";
import { routeHash } from "../route.js";
import { EmployeeIdentity } from "./EmployeeIdentity.js";
import { StatusTag, Time } from "./Foundation.js";
import { IdentityRow } from "./IdentityRow.js";
import { IdBadge } from "./IdTag.js";
import { TimelineVersion } from "./TimelineVersion.js";
import { Button } from "./ui/button.js";
import { Prose } from "./ui/prose.js";

/** Full git SHA-1 or SHA-256 written out in a summary. */
const FULL_SHA = /\b(?:[0-9a-f]{64}|[0-9a-f]{40})\b/gi;

function sequence(id: string) {
  const n = Number(id.slice(id.lastIndexOf("-") + 1));
  return Number.isFinite(n) ? n : 0;
}

/** Newest first: by submission time when known, then by id number. */
function newestFirst(
  left: { id: string; submitted_at?: string },
  right: { id: string; submitted_at?: string },
) {
  return (
    (right.submitted_at ?? "").localeCompare(left.submitted_at ?? "") ||
    sequence(right.id) - sequence(left.id)
  );
}

/** Long SHAs read as 7 characters; hovering shows the full value. */
export function ShortShas({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(FULL_SHA)) {
    const start = match.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <abbr key={start} className="record-sha" title={match[0]}>
        {match[0].slice(0, 7)}
      </abbr>,
    );
    last = start + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** At most two lines until expanded; never scrolls sideways. */
function RecordSummary({
  text,
  kind,
}: {
  text: string;
  kind: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const body = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element || expanded) return;
    const measure = () =>
      setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded]);
  return (
    <div className="record-summary">
      <Prose text={text}>
        <p
          ref={body}
          className={expanded ? undefined : "record-summary-clamped"}
          data-expanded={expanded}
        >
          {kind && <span className="record-kind">{kind}</span>}
          <ShortShas text={text} />
        </p>
      </Prose>
      {(overflows || expanded) && (
        <Button
          type="button"
          variant="ghost"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起" : "展开全文"}
        </Button>
      )}
    </div>
  );
}

export function CardRecords({
  detail,
  projectId,
  onLocate,
}: {
  detail: CardDetail;
  projectId: string;
  onLocate: ((anchor: string) => void) | undefined;
}) {
  const link = (id: string, anchor: string) => (
    <a
      href={routeHash({
        kind: "card",
        projectId,
        cardId: detail.card.id,
        anchor,
      })}
      onClick={
        onLocate
          ? (e) => {
              e.preventDefault();
              onLocate(anchor);
            }
          : undefined
      }
    >
      <IdBadge id={id} />
    </a>
  );
  const reviewsOf = (delivery: DeliveryView) =>
    detail.reviews
      .filter((r) => r.delivery_id === delivery.id)
      .sort((a, b) => newestFirst(b, a));
  const review = (r: ReviewView, delivery: DeliveryView) => (
    <IdentityRow as="li" key={r.id} className="record-row record-review">
      <span className="record-who">
        <EmployeeIdentity {...r} showTitle={false} />
      </span>
      <span className="record-id">{link(r.id, `review-${r.id}`)}</span>
      <span className="record-status">
        <StatusTag status={r.verdict} />
      </span>
      <span className="record-commit record-kind-label">
        {delivery.kind === "card_completion" ? "验收" : "审核"}
      </span>
      <span className="record-time">
        {r.submitted_at && <Time value={r.submitted_at} />}
      </span>
    </IdentityRow>
  );
  const delivery = (d: DeliveryView, current: boolean) => {
    const reviews = reviewsOf(d);
    return (
      <li
        key={d.id}
        className={`record-delivery${current ? " record-delivery-current" : ""}`}
        data-delivery-id={d.id}
      >
        <IdentityRow className="record-row">
          <span className="record-who">
            <EmployeeIdentity {...d} showTitle={false} />
          </span>
          <span className="record-id">{link(d.id, `delivery-${d.id}`)}</span>
          <span className="record-status">
            <StatusTag status={d.status} />
          </span>
          <span className="record-commit">
            <TimelineVersion
              value={d.subject.value}
              git={d.subject.kind === "git_head"}
            />
          </span>
          <span className="record-time">
            {d.submitted_at && <Time value={d.submitted_at} />}
          </span>
        </IdentityRow>
        <RecordSummary
          text={d.summary}
          kind={d.kind === "card_completion" ? "完成申请" : undefined}
        />
        {!!reviews.length && (
          <ul className="record-reviews" aria-label={`${d.id} 的审核与验收`}>
            {reviews.map((r) => review(r, d))}
          </ul>
        )}
      </li>
    );
  };
  const current = detail.deliveries
    .filter((d) => d.status !== "superseded")
    .sort(newestFirst);
  const superseded = detail.deliveries
    .filter((d) => d.status === "superseded")
    .sort(newestFirst);
  return (
    <section className="card-section card-records" aria-label="交付与审核">
      {!!current.length && (
        <ul className="card-record-list" aria-label="当前交付">
          {current.map((d) => delivery(d, true))}
        </ul>
      )}
      {!!superseded.length && (
        <details className="record-superseded">
          <summary>已取代的交付 {superseded.length} 条</summary>
          <ul className="card-record-list" aria-label="已取代的交付">
            {superseded.map((d) => delivery(d, false))}
          </ul>
        </details>
      )}
    </section>
  );
}
