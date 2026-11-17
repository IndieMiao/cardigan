import { idBadgeClass, idType } from "../id-types.js";
import { isHttpLink } from "../markdown.js";
import { Tooltip } from "./Tooltip.js";

export { IdBadge } from "./ui/id-badge.js";

/** The caller supplies a known target via routeHash/referenceHref (S23). */
export function IdTag({
  id,
  label = idType(id)?.label,
  detail,
  href,
  tooltipClearAbove,
}: {
  id: string;
  label?: string | undefined;
  detail?: string;
  href?: string | undefined;
  tooltipClearAbove?: string | undefined;
}) {
  const text = (
    <>
      <span className={idBadgeClass(id)}>{id}</span>{" "}
      {label && <span className="id-description">{label}</span>}
    </>
  );
  return (
    <Tooltip
      content={detail ?? [id, label].filter(Boolean).join(" ")}
      clearAbove={tooltipClearAbove}
    >
      {href && (href.startsWith("#/p/") || isHttpLink(href)) ? (
        <a className="id-tag" href={href}>
          {text}
        </a>
      ) : (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Tooltip details must be reachable by keyboard.
        <span className="id-tag" tabIndex={0}>
          {text}
        </span>
      )}
    </Tooltip>
  );
}
