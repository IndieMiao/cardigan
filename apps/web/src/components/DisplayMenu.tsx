import { Menu, type MenuItem } from "./Menu.js";
import { Button } from "./ui/button.js";
import { ChevronDownIcon } from "./ui/icons.js";

export function DisplayMenu({ items }: { items: readonly MenuItem[] }) {
  return (
    <Menu
      label="显示字段"
      className="card-display-menu"
      title="显示字段"
      trigger={
        <Button
          type="button"
          className="filter-select-trigger card-display-trigger"
        >
          <span>显示</span>
          <ChevronDownIcon aria-hidden="true" />
        </Button>
      }
      items={items}
    />
  );
}
