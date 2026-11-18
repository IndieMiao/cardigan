import { BoardIcon, ListIcon } from "./ui/icons.js";
import { ViewSwitch } from "./ViewSwitch.js";

/** Execution keeps its table/card modes while sharing the card page's icons. */
export function ExecutionViewSwitch({
  value,
  onChange,
}: {
  value: "table" | "cards";
  onChange: (value: "table" | "cards") => void;
}) {
  return (
    <ViewSwitch
      label="视图模式"
      value={value}
      showLabel
      onChange={(next) => onChange(next === "cards" ? "cards" : "table")}
      options={[
        { value: "table", label: "表格", icon: <ListIcon /> },
        { value: "cards", label: "卡片", icon: <BoardIcon /> },
      ]}
    />
  );
}
