import { Button } from "./ui/button.js";
import { SelectControl } from "./ui/select-control.js";

export const REFRESH_INTERVALS = [10000, 30000, 60000, 300000, 0] as const;
export const DEFAULT_REFRESH_INTERVAL = 30000;

/** Controlled presentation only: scheduling and persistence belong to the page. */
export function RefreshGroup({
  interval,
  onIntervalChange,
  pending,
  onRefresh,
}: {
  interval: number;
  onIntervalChange: (interval: number) => void;
  pending: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="cards-refresh ui-refresh-controls">
      <label>
        <SelectControl
          aria-label="自动刷新"
          value={interval}
          onValueChange={(value) => onIntervalChange(Number(value))}
        >
          <option value={10000}>10 秒</option>
          <option value={30000}>30 秒</option>
          <option value={60000}>60 秒</option>
          <option value={300000}>5 分钟</option>
          <option value={0}>关闭</option>
        </SelectControl>
      </label>
      <Button
        type="button"
        className="quiet"
        onClick={() => {
          if (!pending) onRefresh();
        }}
        aria-disabled={pending}
      >
        立即刷新
      </Button>
    </div>
  );
}
