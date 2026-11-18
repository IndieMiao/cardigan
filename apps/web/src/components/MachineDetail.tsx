import type { ExecutionCapacity, ExecutionMachine } from "../api.js";
import { healthBlockerLabel, machineHealth } from "../machine-labels.js";
import { useCapacity } from "./Capacity.js";
import { StatusTag, Time } from "./Foundation.js";
import { CardDetailLayout } from "./layout/CardDetailLayout.js";

type AgentCapacity = ExecutionCapacity["agents"][number];

export function MachineHealthTag({
  machine,
}: {
  readonly machine: ExecutionMachine;
}) {
  const health = machineHealth(machine);
  return (
    <StatusTag
      status={health.status}
      label={health.label}
      subdued={health.subdued}
    />
  );
}

export function machineCapacityText(capacity: AgentCapacity | undefined) {
  return capacity
    ? `${capacity.running}/${capacity.limit || "不可用"}`
    : undefined;
}

/** MC-5: read-only machine facts. Registry and limits are changed elsewhere by a human. */
export function MachineDetail({
  machine,
}: {
  readonly machine: ExecutionMachine;
}) {
  const capacity = useCapacity()?.data?.agents.find(
    (row) => row.machine_id === machine.id,
  );
  const health = machine.health;
  const capabilities = [...(machine.capabilities ?? [])].sort(
    (a, b) =>
      Number(b.available) - Number(a.available) || a.key.localeCompare(b.key),
  );
  const resources = capacity?.resources ?? [];
  return (
    <CardDetailLayout className="execution-drawer card-page-drawer">
      <div className="board-list">
        <dl className="execution-basics decision-record-detail">
          <dt>编号</dt>
          <dd>{machine.id}</dd>
          <dt>状态</dt>
          <dd>
            <StatusTag status={machine.status} />
          </dd>
          <dt>系统</dt>
          <dd>
            {[machine.os, machine.arch].filter(Boolean).join(" / ") || "—"}
          </dd>
          <dt>标签</dt>
          <dd>{machine.tags?.length ? machine.tags.join("、") : "—"}</dd>
          <dt>健康</dt>
          <dd>
            <MachineHealthTag machine={machine} />
            {health && (
              <span className="hint">
                {" "}
                <Time value={health.checked_at} />
              </span>
            )}
            {!!health?.blockers.length && (
              <span> {health.blockers.map(healthBlockerLabel).join("、")}</span>
            )}
          </dd>
          <dt>容量</dt>
          <dd>
            {capacity
              ? `非常驻 ${capacity.running} / 上限 ${capacity.limit || "不可用"} · 全部 ${capacity.total_running} · 排队 ${capacity.queued}`
              : "—"}
          </dd>
        </dl>
        <section
          className="execution-drawer-section card-section"
          aria-label={`${machine.label} 资源占用`}
        >
          <h3>资源占用</h3>
          {resources.length === 0 ? (
            <p className="hint">未配置资源上限</p>
          ) : (
            <ul className="execution-runs board-list">
              {resources.map((resource) => (
                <li key={resource.key}>
                  <span className="execution-run-head metadata">
                    <span>{resource.key}</span>
                    <StatusTag
                      status={
                        resource.occupied >= resource.limit ? "blocked" : "idle"
                      }
                      label={`${resource.occupied}/${resource.limit}`}
                      subdued={resource.occupied < resource.limit}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section
          className="execution-drawer-section card-section"
          aria-label={`${machine.label} 能力`}
        >
          <h3>
            能力
            {capabilities.length > 0 && (
              <span className="hint">
                {" "}
                {capabilities.filter((c) => c.available).length} /{" "}
                {capabilities.length}
              </span>
            )}
          </h3>
          {capabilities.length === 0 ? (
            <p className="hint">
              {health?.status === "checking" ? "检查中" : "没有已验证能力"}
            </p>
          ) : (
            <ul className="execution-runs board-list">
              {capabilities.map((capability) => (
                <li key={capability.key}>
                  <span className="execution-run-head metadata">
                    <StatusTag
                      status={capability.available ? "passed" : "inactive"}
                      label={capability.available ? "已验证" : "已过期"}
                      subdued={!capability.available}
                    />
                    <span className={capability.available ? undefined : "hint"}>
                      {capability.key}
                      {capability.version ? ` ${capability.version}` : ""}
                    </span>
                    <span className="hint">
                      验证于 <Time value={capability.verified_at} />
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </CardDetailLayout>
  );
}
