import { BoardIcon, ListIcon } from "./ui/icons.js";
import { ViewSwitch } from "./ViewSwitch.js";

/** Use the same labels and icons wherever cards support board/list views. */
export function CardsViewSwitch({
  value,
  onChange,
}: {
  value: "board" | "list";
  onChange: (value: "board" | "list") => void;
}) {
  return (
    <ViewSwitch
      label="视图"
      value={value}
      showLabel
      onChange={(next) => onChange(next === "list" ? "list" : "board")}
      options={[
        { value: "board", label: "看板", icon: <BoardIcon /> },
        { value: "list", label: "列表", icon: <ListIcon /> },
      ]}
    />
  );
}
