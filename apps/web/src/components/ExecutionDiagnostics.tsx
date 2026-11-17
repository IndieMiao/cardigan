import { useEffect, useState } from "react";
import type { CardiganClient, ExecutionDiagnosticsData } from "../api.js";

const causes: Readonly<Record<string, string>> = {
  waiting_confirmation: "等待交互确认",
  waiting_interaction: "等待交互，类型未确认",
  runtime_exited: "运行终端已退出",
  upstream_unreachable: "线路连接失败",
  upstream_suspected: "疑似线路异常",
  agent_stalled: "会话失活",
  server_problem: "主机派发异常",
  unknown: "运行原因未知",
};

export function ExecutionDiagnostics({
  client,
  projectId,
  onOpen,
}: {
  readonly client: CardiganClient;
  readonly projectId: string;
  readonly onOpen: (id: string, trigger: HTMLElement) => void;
}) {
  const [data, setData] = useState<ExecutionDiagnosticsData>();
  const [request, setRequest] = useState(0);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [failed, setFailed] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: request is the explicit user refresh generation.
  useEffect(() => {
    if (!client.executionDiagnostics) return;
    let current = true;
    setBusy(true);
    setStale(false);
    setFailed(false);
    setData(undefined);
    void client
      .executionDiagnostics(projectId)
      .then(
        (value) => {
          if (current) setData(value);
        },
        () => {
          if (current) setFailed(true);
        },
      )
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [client, projectId, request]);
  useEffect(() => {
    if (!data?.expires_at) return;
    const remaining = Date.parse(data.expires_at) - Date.now();
    const timer = setTimeout(() => setStale(true), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [data]);
  if (!client.executionDiagnostics) return null;
  const sessions = stale
    ? []
    : (data?.sessions.filter((s) => causes[s.cause]) ?? []);
  const count = (data?.configuration.length ?? 0) + sessions.length;
  return (
    <details className="execution-diagnostics">
      <summary>启动与运行诊断{count > 0 ? `（${count}）` : ""}</summary>
      <button
        type="button"
        disabled={busy}
        onClick={() => setRequest((n) => n + 1)}
      >
        {busy ? "检查中" : "刷新诊断"}
      </button>
      {(failed || data?.available === false) && <p role="status">诊断不可用</p>}
      {stale && <p role="status">运行诊断已过期，请刷新</p>}
      {data && data.available !== false && !stale && count === 0 && (
        <p>没有告警</p>
      )}
      {count > 0 && (
        <ul>
          {data?.configuration.map((w) => (
            <li key={`${w.profile}:${w.code}`}>
              <strong>配置告警 · {w.profile}</strong>
              <p>{w.message}</p>
            </li>
          ))}
          {sessions.map((s) => (
            <li key={s.assignment_id}>
              <strong>{causes[s.cause]}</strong>
              {s.cause === "waiting_confirmation" && (
                <p>请接入终端核对确认请求；系统不会代答。</p>
              )}
              {s.cause === "waiting_interaction" && (
                <p>请接入终端核对等待原因。</p>
              )}
              {s.cause === "runtime_exited" && (
                <p>
                  请核对 Run
                  状态；停止已完成的会话可手工恢复，退出未确认时交主机运维。
                </p>
              )}
              {s.cause === "unknown" && (
                <p>观察不足，请检查运行状态后再决定是否恢复。</p>
              )}
              {s.evidence.includes("connection_probe_failed") &&
                s.cause !== "upstream_unreachable" && (
                  <p>同时检测到线路连接失败。</p>
                )}
              <button
                type="button"
                onClick={(event) =>
                  onOpen(s.assignment_id, event.currentTarget)
                }
              >
                查看 {s.assignment_id}
              </button>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
