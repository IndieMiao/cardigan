import { useState } from "react";
import { RequestFeedback } from "./RequestFeedback.js";
import { Tooltip } from "./Tooltip.js";

export function TimelineVersion({
  value,
  git = true,
}: {
  value: string;
  git?: boolean;
}) {
  const [message, setMessage] = useState("");
  if (!git) return <span>版本 {value}</span>;
  return (
    <span className="timeline-version">
      <Tooltip content={`提交 ${value}，点击复制完整 SHA`}>
        <button
          type="button"
          className="quiet"
          aria-label={`复制提交 ${value.slice(0, 7)}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setMessage("已复制");
            } catch {
              setMessage("复制失败，请从提示中选取完整 SHA");
            }
          }}
        >
          提交 {value.slice(0, 7)}
        </button>
      </Tooltip>
      <RequestFeedback message={message} />
    </span>
  );
}
