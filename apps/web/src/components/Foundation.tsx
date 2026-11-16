import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { statusLabel } from "../status.js";
import { CapacityStatus } from "./Capacity.js";
import { StatusIcon, statusShape } from "./StatusIcon.js";

export function PageTitle({
  title,
  description,
  actions,
  showCapacity = true,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  showCapacity?: boolean;
}) {
  return (
    <header className="page-title">
      <h1>{title}</h1>
      {showCapacity && <CapacityStatus />}
      {description && <p className="page-description">{description}</p>}
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
export function StatusTag({
  status,
  label = statusLabel(status),
  subdued = false,
}: {
  status: string;
  label?: string;
  subdued?: boolean;
}) {
  return (
    <span
      className={`status status-${status} status-shape-${statusShape(status)}${subdued ? " status-subdued" : ""}`}
    >
      {!subdued && <StatusIcon status={status} decorative />}
      {label}
    </span>
  );
}

/** Local clock, including the year across year boundaries. Never prints raw UTC. */
export function formatTime(value: string, now = Date.now()): string {
  const date = new Date(value),
    age = now - date.getTime();
  if (!Number.isFinite(date.getTime())) return "时间未知";
  // A slightly faster server clock is recent only within this local minute.
  // Local setters can select the earlier offset when a DST hour repeats.
  const clock = new Date(now);
  const minuteEnd =
    now - clock.getSeconds() * 1000 - clock.getMilliseconds() + 60000;
  if (age < 0 && date.getTime() < minuteEnd) return "刚刚";
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
export function fullTime(value: string): string {
  if (!Number.isFinite(Date.parse(value))) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).format(new Date(value));
}
export function Time({
  value,
  relative = false,
}: {
  value: string | null | undefined;
  relative?: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  if (!value || !Number.isFinite(Date.parse(value)))
    return <span>时间未知</span>;
  const title = fullTime(value);
  return (
    <time dateTime={value} title={title}>
      {relative && now - Date.parse(value) >= 86400000
        ? `${Math.floor((now - Date.parse(value)) / 86400000)} 天前`
        : formatTime(value, now)}
    </time>
  );
}

export { IdTag } from "./IdTag.js";

/** Measure rendered lines, including wrapping and Markdown, rather than source newlines. */
export function LongContent({
  children,
  lines = 6,
}: {
  children: ReactNode;
  lines?: 2 | 4 | 6 | 15;
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
        className={
          expanded || (lines === 15 && !long)
            ? "long-body"
            : "long-body collapsed"
        }
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
