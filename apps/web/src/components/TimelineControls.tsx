import { Menu } from "./Menu.js";
import { PageSizeMenu } from "./PageSizeMenu.js";

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
  hasMore = total > loaded,
  pageSize,
  pending,
  loadEarlier,
}: {
  filters: Record<string, string>;
  onChange: (filters: Record<string, string>) => void;
  loaded: number;
  total: number;
  hasMore?: boolean;
  pageSize: number;
  pending: boolean;
  loadEarlier: () => void;
}) {
  return (
    <fieldset className="timeline-controls" aria-label="时间线筛选与加载">
      {fields.map((field) => (
        <Menu
          key={field.key}
          label={field.label}
          trigger={
            <button type="button" className="quiet timeline-filter">
              {field.label}：
              {field.options.find(
                ([value]) => value === filters[field.key],
              )?.[1] ?? "全部"}
              <span aria-hidden="true"> ▾</span>
            </button>
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
      {hasMore && (
        <button
          type="button"
          className="quiet timeline-load"
          disabled={pending}
          onClick={loadEarlier}
        >
          加载更早的记录
        </button>
      )}
      <PageSizeMenu
        label="每次加载"
        pageSize={pageSize}
        sizes={[20, 50, 100]}
        compact
        onChange={(size) => onChange({ ...filters, count: String(size) })}
      />
    </fieldset>
  );
}
