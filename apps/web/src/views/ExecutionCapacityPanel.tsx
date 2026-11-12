import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  type CardiganClient,
  describeError,
  type ExecutionCapacity,
} from "../api.js";
import { useResource } from "../useResource.js";

function AgentLimit({
  machine,
  client,
  projectId,
  saved,
}: {
  machine: ExecutionCapacity["agents"][number];
  client: CardiganClient;
  projectId: string;
  saved: () => void;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const request = useRef<{ limit: number; key: string } | undefined>(undefined);
  const value = draft ?? String(machine.limit);
  const positiveInteger =
    /^\d+$/.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0;
  const exceedsMaximum = positiveInteger && Number(value) > machine.max_limit;
  const valid = positiveInteger && !exceedsMaximum;
  const save = async () => {
    if (pending || !valid) return;
    const limit = Number(value);
    if (request.current?.limit !== limit)
      request.current = { limit, key: crypto.randomUUID() };
    setPending(true);
    setError("");
    setMessage("");
    try {
      await client.setRunLimit(
        projectId,
        machine.machine_id,
        limit,
        request.current.key,
      );
      request.current = undefined;
      setDraft(undefined);
      setMessage("已保存，下一轮调度生效。");
      saved();
    } catch (reason) {
      setError(`保存失败：${describeError(reason)}`);
    } finally {
      setPending(false);
    }
  };
  return (
    <form
      className="execution-capacity-row"
      aria-label={`${machine.label} Agent 并发`}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="execution-capacity-count">
        <strong>{machine.label} · Agent</strong>
        <span>
          运行中 {machine.running} / 上限 {machine.limit || "不可用"} / 排队{" "}
          {machine.queued}
        </span>
      </div>
      <div className="execution-capacity-edit">
        <label htmlFor={inputId}>上限</label>
        <input
          id={inputId}
          aria-label={`${machine.label} Agent 并发上限`}
          type="number"
          min="1"
          step="1"
          max={machine.max_limit}
          aria-describedby={`${inputId}-validation`}
          aria-invalid={!valid}
          value={value}
          disabled={pending || machine.limit === 0}
          onChange={(event) => {
            setDraft(event.target.value);
            setMessage("");
            setError("");
          }}
        />
        <button
          type="submit"
          disabled={pending || !valid || machine.limit === 0}
        >
          {pending ? "保存中…" : "保存"}
        </button>
      </div>
      {!valid && (
        <span id={`${inputId}-validation`} className="hint">
          {exceedsMaximum
            ? `并发上限不能超过 ${machine.max_limit}。`
            : "并发上限必须为正整数。"}
        </span>
      )}
      {machine.limit === 0 && (
        <span role="alert">主机并发配置无效，请联系主机管理员。</span>
      )}
      {machine.merge_check_slots > 0 && (
        <span className="hint">
          本机合并检查另占 {machine.merge_check_slots} 个 Agent 名额。
        </span>
      )}
      {error && <span role="alert">{error}</span>}
      {message && <span role="status">{message}</span>}
    </form>
  );
}

export function ExecutionCapacityPanel({
  client,
  projectId,
  revision,
}: {
  client: CardiganClient;
  projectId: string;
  revision: number;
}) {
  const load = useCallback(
    () => client.executionCapacity(projectId),
    [client, projectId],
  );
  const { data, error, reload } = useResource(load, revision);
  // Occupancy and limits are shared across projects. Poll even when this project's SSE is quiet.
  useEffect(() => {
    const timer = window.setInterval(reload, 5000);
    return () => window.clearInterval(timer);
  }, [reload]);
  return (
    <section className="execution-capacity" aria-label="机器并发">
      <div className="execution-capacity-heading">
        <strong>机器并发</strong>
        <span className="hint">全项目共用</span>
      </div>
      {error && (
        <p role="alert">
          读取并发信息失败：{error}{" "}
          <button type="button" className="quiet" onClick={reload}>
            重试
          </button>
        </p>
      )}
      {!data && !error && <p className="hint">正在读取并发信息…</p>}
      {data?.agents.map((machine) => (
        <AgentLimit
          key={machine.machine_id}
          machine={machine}
          client={client}
          projectId={projectId}
          saved={reload}
        />
      ))}
      {!!data?.agents.length && (
        <p className="hint">调低上限不会停止已运行的任务。</p>
      )}
      {data?.merge_checks.map((machine) => (
        <div key={machine.machine_id} className="execution-capacity-row">
          <div className="execution-capacity-count">
            <strong>{machine.machine_id} · 合并检查</strong>
            <span>
              运行中 {machine.running} / 上限 {machine.limit} / 排队{" "}
              {machine.queued}
            </span>
          </div>
          <span className="hint">需要主机预置，找张良</span>
        </div>
      ))}
      {data?.merge_config_invalid && (
        <p role="alert">合并检查配置无效，请联系主机管理员。</p>
      )}
    </section>
  );
}
