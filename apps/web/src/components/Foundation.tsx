import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { isHttpLink } from "../markdown.js";
import { statusLabel } from "../status.js";

export function PageTitle({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-title">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
export function StatusTag({ status }: { status: string }) {
  return (
    <span className={`status status-${status}`}>{statusLabel(status)}</span>
  );
}

/** Local clock, including the year across year boundaries. Never prints raw UTC. */
export function formatTime(value: string, now = Date.now()): string {
  const date = new Date(value),
    age = now - date.getTime();
  if (!Number.isFinite(date.getTime())) return "时间未知";
  if (age >= 0 && age < 86400000) {
    if (age < 60000) return "刚刚";
    if (age < 3600000) return `${Math.floor(age / 60000)} 分钟前`;
    return `${Math.floor(age / 3600000)} 小时前`;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  const year =
    date.getFullYear() === new Date(now).getFullYear()
      ? ""
      : `${date.getFullYear()}-`;
  return `${year}${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function Time({ value }: { value: string | null | undefined }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  if (!value || !Number.isFinite(Date.parse(value)))
    return <span>时间未知</span>;
  const title = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).format(new Date(value));
  return (
    <time dateTime={value} title={title}>
      {formatTime(value, now)}
    </time>
  );
}

/** The caller supplies a known target via routeHash/referenceHref (S23). */
export function IdTag({
  id,
  label,
  detail,
  href,
}: {
  id: string;
  label: string;
  detail?: string;
  href?: string | undefined;
}) {
  const text = (
    <>
      <span>{id}</span> <span className="id-description">{label}</span>
    </>
  );
  const title = detail ?? `${id} ${label}`;
  return href && (href.startsWith("#/p/") || isHttpLink(href)) ? (
    <a className="id-tag" href={href} title={title}>
      {text}
    </a>
  ) : (
    <span className="id-tag" title={title}>
      {text}
    </span>
  );
}

/** Measure rendered lines, including wrapping and Markdown, rather than source newlines. */
export function LongContent({
  children,
  lines = 6,
}: {
  children: ReactNode;
  lines?: 2 | 4 | 6;
}) {
  const ref = useRef<HTMLDivElement>(null),
    id = useId();
  const [long, setLong] = useState(false),
    [expanded, setExpanded] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: new content needs measurement even at the same clamped height.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const line = Number.parseFloat(window.getComputedStyle(node).lineHeight);
      setLong(node.scrollHeight > line * lines + 1);
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(node);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [children, lines]);
  return (
    <div className={`long-content long-content-${lines}`}>
      <div
        ref={ref}
        onFocusCapture={() => setExpanded(true)}
        id={id}
        className={expanded ? "long-body" : "long-body collapsed"}
      >
        {children}
      </div>
      {long && (
        <button
          type="button"
          className="quiet"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "收起全文" : "展开全文"}
        </button>
      )}
    </div>
  );
}
