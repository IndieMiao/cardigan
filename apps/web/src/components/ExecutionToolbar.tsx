import type { ExecutionDisplay } from "../execution-display.js";
import type { ExecutionSort } from "../execution-sort.js";
import { DisplayMenu } from "./DisplayMenu.js";
import { ExecutionViewSwitch } from "./ExecutionViewSwitch.js";
import { FilterSelect } from "./FilterSelect.js";
import { PageToolbar } from "./PageToolbar.js";
import { RefreshGroup } from "./RefreshGroup.js";
import { SearchInput } from "./ui/input.js";

const views = [
  { value: "working", label: "工作中" },
  { value: "released", label: "已释放" },
  { value: "lost", label: "失联" },
];
const sorts = [
  { value: "state-asc", label: "运行状态升序" },
  { value: "state-desc", label: "运行状态降序" },
  { value: "desc", label: "最近活动降序" },
  { value: "asc", label: "最近活动升序" },
];

export function ExecutionToolbar({
  filters,
  onFilterChange,
  machineOptions,
  employeeOptions = [],
  display,
  onDisplayChange,
  sort,
  onSortChange,
  interval,
  onIntervalChange,
  pending,
  onRefresh,
}: {
  filters: Record<string, string>;
  onFilterChange: (filters: Record<string, string>) => void;
  machineOptions: readonly { value: string; label: string }[];
  /** Only offered while a link has narrowed the view to one employee. */
  employeeOptions?: readonly { value: string; label: string }[];
  display: ExecutionDisplay;
  onDisplayChange: (display: ExecutionDisplay) => void;
  sort: ExecutionSort;
  onSortChange: (sort: ExecutionSort) => void;
  interval: number;
  onIntervalChange: (interval: number) => void;
  pending: boolean;
  onRefresh: () => void;
}) {
  const groupBy = display.groupBy ?? "employee";
  return (
    <PageToolbar
      fields={[
        {
          key: "view",
          label: "筛选",
          options: views,
          render: (value, setValue) => (
            <FilterSelect
              label="筛选"
              value={value === "all" ? "" : value}
              options={views}
              onChange={(next) => setValue(next || "all")}
            />
          ),
        },
        {
          key: "machine",
          label: "机器",
          options: machineOptions,
          render: (value, setValue) => (
            <FilterSelect
              label="机器"
              value={value}
              options={machineOptions}
              onChange={setValue}
            />
          ),
        },
        ...(filters.employee
          ? [
              {
                key: "employee",
                label: "员工",
                options: employeeOptions,
                render: (value: string, setValue: (next: string) => void) => (
                  <FilterSelect
                    label="员工"
                    value={value}
                    options={employeeOptions}
                    onChange={setValue}
                  />
                ),
              },
            ]
          : []),
        {
          key: "sort",
          label: "排序",
          render: () => (
            <FilterSelect
              label="排序"
              value={sort === "desc" ? "" : sort}
              options={sorts}
              onChange={(next) =>
                onSortChange((next || "desc") as ExecutionSort)
              }
            />
          ),
        },
        {
          key: "q",
          label: "搜索",
          grow: true,
          render: (value, setValue) => (
            <SearchInput
              aria-label="搜索员工、任务或机器"
              placeholder="搜索员工、任务或机器"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          ),
        },
        {
          key: "display",
          label: "显示",
          render: () => (
            <DisplayMenu
              items={[
                {
                  id: "grouped",
                  label: "分组",
                  kind: "checkbox",
                  checked: display.grouped,
                  onCheckedChange: (grouped) =>
                    onDisplayChange({ ...display, grouped }),
                },
                ...(["employee", "machine"] as const).map((field) => ({
                  id: field,
                  label: `分组字段：${field === "machine" ? "机器" : "员工"}`,
                  kind: "checkbox" as const,
                  checked: groupBy === field,
                  onCheckedChange: () =>
                    onDisplayChange({
                      ...display,
                      grouped: true,
                      groupBy: field,
                    }),
                })),
              ]}
            />
          ),
        },
      ]}
      values={filters}
      onChange={onFilterChange}
    >
      <RefreshGroup
        interval={interval}
        onIntervalChange={onIntervalChange}
        pending={pending}
        onRefresh={onRefresh}
      />
      <ExecutionViewSwitch
        value={display.mode}
        onChange={(mode) => onDisplayChange({ ...display, mode })}
      />
    </PageToolbar>
  );
}
