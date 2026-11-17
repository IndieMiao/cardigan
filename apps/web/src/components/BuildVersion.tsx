import { useState } from "react";
import type { BuildInfo } from "../api.js";
import { Tooltip } from "./Tooltip.js";

export function BuildVersion({ build }: { readonly build: BuildInfo }) {
  const [feedback, setFeedback] = useState("");
  const sha = build.sha;
  const time = build.built_at ? new Date(build.built_at) : undefined;
  const validTime = time && !Number.isNaN(time.getTime()) ? time : undefined;
  const pad = (part: number) => String(part).padStart(2, "0");
  const shortTime = validTime
    ? `${pad(validTime.getMonth() + 1)}-${pad(validTime.getDate())} ${pad(validTime.getHours())}:${pad(validTime.getMinutes())}`
    : undefined;
  const version = [build.development ? "dev" : undefined, sha?.slice(0, 7)]
    .filter(Boolean)
    .join(" ");
  const label = `${version}${shortTime ? ` · ${shortTime}` : ""}`;
  const detail = [
    build.sha ?? "dev",
    validTime ? `构建于 ${validTime.toLocaleString()}` : undefined,
    feedback,
  ]
    .filter(Boolean)
    .join("\n");

  if (!sha) return <span className="build-version">{label}</span>;
  return (
    <>
      <Tooltip
        content={detail}
        side="bottom"
        className="build-version-tooltip"
        selectable
      >
        <button
          type="button"
          className="build-version"
          aria-label={`复制完整版本 ${build.sha}`}
          data-feedback={feedback ? "" : undefined}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(sha);
              setFeedback("已复制");
            } catch {
              setFeedback("复制失败，请从提示中选取完整 SHA");
            }
          }}
        >
          {label}
        </button>
      </Tooltip>
      <span className="visually-hidden" role="status">
        {feedback}
      </span>
    </>
  );
}
