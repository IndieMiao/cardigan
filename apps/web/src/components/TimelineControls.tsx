import { useEffect, useRef, useState } from "react";
import { Menu } from "./Menu.js";
import { Button } from "./ui/button.js";

const fields = [
  {
    key: "type",
    label: "条目类型",
    options: [
      ["delivery", "交付"],
      ["review", "审核"],
      ["decision", "拍板"],
      ["comment", "评论"],
      ["instruction", "指令"],
      ["human_action", "待你执行"],
      ["handoff", "交接"],
      ["system", "系统"],
    ],
  },
  {
    key: "author",
    label: "发言方",
    options: [
      ["human", "所有者"],
      ["pm", "PM"],
      ["agent", "Agent"],
      ["system", "系统"],
    ],
  },
] as const;

/** Single-choice filters keep the existing URL contract; menus own focus/closing. */
export function TimelineControls({
  filters,
  onChange,
  loaded,
  total,
}: {
  filters: Record<string, string>;
  onChange: (filters: Record<string, string>) => void;
  loaded: number;
  total: number;
}) {
  return (
    <fieldset className="timeline-controls" aria-label="时间线筛选">
      {fields.map((field) => (
        <Menu
          key={field.key}
          label={field.label}
          trigger={
            <Button type="button" variant="ghost">
              {field.label}：
              {field.options.find(
                ([value]) => value === filters[field.key],
              )?.[1] ?? "全部"}
              <span aria-hidden="true"> ▾</span>
            </Button>
          }
          items={[["", "全部"], ...field.options].map(
            ([value = "", label]) => ({
              id: value || "all",
              label,
              onSelect: () => onChange({ ...filters, [field.key]: value }),
            }),
          )}
        />
      ))}
      <span className="timeline-count">
        已加载 {loaded} / {total} 条
      </span>
    </fieldset>
  );
}

/**
 * The row after the oldest loaded entry. While more history exists it is the
 * scroll sentinel: one load per observation, re-armed after each request,
 * paused after a failure until the reader retries. Without IntersectionObserver
 * it stays a plain button. Only the reader's own retry follows a failure.
 */
export function TimelinePager({
  loaded,
  hasMore,
  status,
  scrollRoot,
  onLoad,
}: {
  loaded: number;
  hasMore: boolean;
  status: { loading: true } | { error: string } | undefined;
  /** The element that scrolls the timeline; `null` for the viewport. */
  scrollRoot: () => Element | null;
  onLoad: () => void;
}) {
  const sentinel = useRef<HTMLButtonElement>(null);
  // A fast page can land before "loading" ever renders; counting each request
  // still re-arms a fresh observer, whose first report reflects the new layout.
  const [round, setRound] = useState(0);
  const idle = hasMore && !status;
  // biome-ignore lint/correctness/useExhaustiveDependencies: round re-arms the observer.
  useEffect(() => {
    const target = sentinel.current;
    if (!idle || !target || typeof IntersectionObserver === "undefined") return;
    let active = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!active || !entries.some((entry) => entry.isIntersecting)) return;
        active = false;
        observer.disconnect();
        onLoad();
        setRound((n) => n + 1);
      },
      { root: scrollRoot(), rootMargin: "0px 0px 200px 0px" },
    );
    observer.observe(target);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [idle, scrollRoot, onLoad, round]);
  const loading = !!status && "loading" in status;
  return (
    <div aria-live="polite">
      {!hasMore ? (
        loaded > 0 && <p className="hint">已到最早的记录</p>
      ) : status && "error" in status ? (
        <p className="hint">
          未能加载更早的记录：{status.error}{" "}
          <Button type="button" variant="link" onClick={onLoad}>
            重试
          </Button>
        </p>
      ) : (
        // Same control while loading, so the row keeps its height and focus.
        <Button
          type="button"
          variant="link"
          ref={sentinel}
          aria-disabled={loading || undefined}
          onClick={loading ? undefined : onLoad}
        >
          {loading ? "正在加载更早的记录…" : "加载更早的记录"}
        </Button>
      )}
    </div>
  );
}
