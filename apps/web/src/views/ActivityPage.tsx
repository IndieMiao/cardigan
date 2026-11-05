import { useCallback, useState } from "react";
import type { ActivityFilter, CardiganClient } from "../api.js";
import { CardLink, Feedback } from "../components/Operations.js";
import { useResource } from "../useResource.js";

const labels: Record<string, string> = {
  comment_posted: "评论",
  instruction_issued: "指令",
  delivery_submitted: "交付",
  review_submitted: "审核",
  decision_requested: "请求拍板",
  decision_resolved: "拍板结果",
  human_action_requested: "待你执行",
  human_action_completed: "执行回报",
  card_merged: "合并完成",
  merge_conflicted: "合并冲突",
  run_queued: "Run 排队",
  run_dispatched: "Run 派发",
  run_finished: "Run 结束",
  runtime_lost: "运行环境失联",
  bell_delivery_failed: "门铃失败",
  reconcile_finding: "对账发现",
};
export function ActivityPage({
  client,
  projectId,
}: {
  client: CardiganClient;
  projectId: string;
}) {
  const [draft, setDraft] = useState({ card_id: "", role: "", type: "" });
  const [filters, setFilters] = useState<ActivityFilter>({});
  const load = useCallback(
    () => client.activity(projectId, filters),
    [client, projectId, filters],
  );
  const { data, pending, error, reload } = useResource(load);
  return (
    <section aria-label="项目动态">
      <div className="toolbar">
        <h1>项目动态</h1>
        <button type="button" className="quiet" onClick={reload}>
          刷新
        </button>
      </div>
      <form
        className="activity-filters"
        onSubmit={(e) => {
          e.preventDefault();
          setFilters(
            Object.fromEntries(
              Object.entries(draft)
                .filter(([, v]) => v.trim())
                .map(([k, v]) => [k, v.trim()]),
            ),
          );
        }}
      >
        {(
          [
            ["card_id", "卡片编号"],
            ["role", "角色"],
            ["type", "事件类型"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              value={draft[key]}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
            />
          </label>
        ))}
        <button type="submit">应用筛选</button>
        <button
          type="button"
          className="quiet"
          onClick={() => {
            setDraft({ card_id: "", role: "", type: "" });
            setFilters({});
          }}
        >
          清除筛选
        </button>
      </form>
      <Feedback pending={pending} error={error} retry={reload} />
      {data && (
        <>
          <p>
            {filters.before ? "正在查看更早的事件" : "最新事件"} · 本页{" "}
            {data.counts.returned} 条
          </p>
          {!data.events.length && <p className="empty">没有符合条件的事件。</p>}
          {data.events.map((e) => (
            <details key={e.id} className="event-details">
              <summary>
                <time dateTime={e.created_at}>{e.created_at}</time> ·{" "}
                {labels[e.type] ?? e.type} ·{" "}
                {e.role === "human"
                  ? "你"
                  : e.role === "system"
                    ? "系统"
                    : e.role}{" "}
                · {e.card_id ?? "项目"}
              </summary>
              <p>
                <CardLink projectId={projectId} id={e.card_id} /> ·{" "}
                {e.actor.assignment_id ?? e.actor.kind} · seq {e.seq} · {e.id}
              </p>
              <pre>{JSON.stringify(e.payload, null, 2)}</pre>
            </details>
          ))}
          <div className="action-row">
            <button
              type="button"
              className="quiet"
              disabled={pending || !data.next_before}
              onClick={() => {
                if (data.next_before)
                  setFilters({ ...filters, before: data.next_before });
              }}
            >
              更早的事件
            </button>
            {filters.before && (
              <button
                type="button"
                onClick={() =>
                  setFilters(({ before: _before, ...rest }) => rest)
                }
              >
                返回最新
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
