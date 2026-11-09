import type { ReactNode } from "react";
import type { TimelineEntryView } from "../api.js";
import { Time } from "./Foundation.js";
import { Tooltip } from "./Tooltip.js";

const paths: Record<string, string> = {
  comment: "M4 4h16v12H9l-5 4V4Z M8 8h8 M8 12h5",
  instruction: "m5 5 15 6-15 6V5Z M8 16v5 M8 4v2",
  delivery: "M4 8h16v12H4V8Z M4 8l4-4h8l4 4 M12 4v9 M9 10l3 3 3-3",
  review: "m5 3 14 0v18H5V3Z m3 9 3 3 5-6",
  decision: "m6 3 8 8 M3 6l8 8 M4 5l2-2 8 8-2 2 M11 12l7 7 M13 21h8",
  attachment: "m8 12 6-6a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9 M6 14l8-8",
  system: "M5 7h14 M5 12h14 M5 17h14 M8 4v6 M16 9v6 M8 14v6",
};
export function TimelineIcon({ entry }: { entry: TimelineEntryView }) {
  const type =
    entry.event_type === "attachment_uploaded"
      ? "attachment"
      : entry.type.startsWith("decision_")
        ? "decision"
        : entry.type;
  return (
    <span
      className="timeline-icon"
      data-icon={paths[type] ? type : "system"}
      aria-hidden="true"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={paths[type] ?? paths.system} />
      </svg>
    </span>
  );
}
export function TimelineActor({
  entry,
  compact = false,
}: {
  entry: TimelineEntryView;
  compact?: boolean;
}) {
  const assignment = entry.author.startsWith("assignment:")
    ? entry.author.slice(11)
    : undefined;
  const name = assignment
    ? (entry.author_role ?? "Agent")
    : entry.author === "human"
      ? "你"
      : "系统";
  const role = ["pm", "coder", "reviewer", "tester"].includes(name)
    ? name
    : assignment
      ? "agent"
      : entry.author;
  return (
    <div
      className={`timeline-identity actor-${role}${compact ? " compact" : ""}`}
    >
      {!compact && (
        <span className="timeline-avatar" aria-hidden="true">
          {name === "你"
            ? "人"
            : name === "系统"
              ? "系"
              : name.charAt(0).toUpperCase()}
        </span>
      )}
      <Tooltip
        content={`${entry.author}，${entry.id}，序号 ${entry.event_seq}`}
      >
        <button type="button" className="quiet timeline-author">
          <strong>{name}</strong>
        </button>
      </Tooltip>
      {assignment && <span className="timeline-role">{assignment}</span>}
    </div>
  );
}
export function TimelineHeader({
  entry,
  action,
  conclusion,
}: {
  entry: TimelineEntryView;
  action: string;
  conclusion?: ReactNode;
}) {
  return (
    <header className="timeline-head">
      <TimelineActor entry={entry} />
      {conclusion}
      <p className="timeline-when">
        {action}于 <Time value={entry.created_at} relative />
        {entry.retracted && (
          <span className="timeline-retracted-label"> 已撤回</span>
        )}
      </p>
    </header>
  );
}
