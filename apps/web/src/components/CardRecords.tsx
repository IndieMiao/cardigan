import type { CardDetail } from "../api.js";
import { routeHash } from "../route.js";
import { EmployeeIdentity } from "./EmployeeIdentity.js";
import { StatusTag } from "./Foundation.js";
import { TimelineVersion } from "./TimelineVersion.js";

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
      {id}
    </a>
  );
  return (
    <section className="card-section" aria-label="交付与审核">
      <h2>交付与审核</h2>
      <ul className="card-record-list">
        {detail.deliveries.map((d) => (
          <li key={d.id}>
            <div>
              <EmployeeIdentity {...d} showTitle={false} />{" "}
              {link(d.id, `delivery-${d.id}`)} <StatusTag status={d.status} />{" "}
              <TimelineVersion
                value={d.subject.value}
                git={d.subject.kind === "git_head"}
              />
            </div>
            <p title={d.summary}>{d.summary}</p>
            <div className="record-reviews">
              {detail.reviews
                .filter((r) => r.delivery_id === d.id)
                .map((r) => (
                  <span key={r.id}>
                    <EmployeeIdentity {...r} showTitle={false} />{" "}
                    {link(r.id, `review-${r.id}`)}{" "}
                    <StatusTag status={r.verdict} />
                  </span>
                ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
