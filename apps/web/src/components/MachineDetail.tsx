import type { ExecutionMachine } from "../api.js";
import {
  type CapabilityState,
  capabilityState,
  healthBlockerLabel,
  machineHealth,
} from "../machine-labels.js";
import { useCapacity } from "./Capacity.js";
import { StatusTag, Time } from "./Foundation.js";
import { CardDetailLayout } from "./layout/CardDetailLayout.js";

const CAPABILITY_TAGS: Readonly<
  Record<
    CapabilityState,
    { readonly status: string; readonly label: string; readonly order: number }
  >
> = {
  verified: { status: "passed", label: "已验证", order: 0 },
  expired: { status: "inactive", label: "已过期", order: 1 },
  unverified: { status: "not_run", label: "未验证", order: 2 },
};

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
  const capabilities = (machine.capabilities ?? [])
    .map((capability) => ({
      ...capability,
      state: capabilityState(capability),
    }))
    .sort(
      (a, b) =>
        CAPABILITY_TAGS[a.state].order - CAPABILITY_TAGS[b.state].order ||
        a.key.localeCompare(b.key),
    );
  // Only a fetched row with an explicit list proves "nothing configured".
  const resources = capacity?.resources;
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
          {resources === undefined ? (
            <p className="hint">未知</p>
          ) : resources.length === 0 ? (
            <p className="hint">未配置资源上限</p>
          ) : (
            <ul className="execution-runs board-list">
              {resources.map((resource) => (
                <li key={resource.key}>
                  <span className="execution-run-head metadata">
                    <span>{resource.key}</span>
                    <StatusTag
                      // A full slot is normal queueing, not a fault.
                      status={
                        resource.occupied >= resource.limit ? "running" : "idle"
                      }
                      label={`${resource.occupied}/${resource.limit}`}
                      subdued={resource.occupied < resource.limit}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
          {capacity?.lease_details && (
            <ul className="execution-runs board-list">
              {capacity.lease_details.map((detail) => (
                <li key={detail}>{detail}</li>
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
                {capabilities.filter((c) => c.state === "verified").length} /{" "}
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
              {capabilities.map((capability) => {
                const tag = CAPABILITY_TAGS[capability.state];
                const verified = capability.state === "verified";
                return (
                  <li key={capability.key}>
                    <span className="execution-run-head metadata">
                      <StatusTag
                        status={tag.status}
                        label={tag.label}
                        subdued={!verified}
                      />
                      <span className={verified ? undefined : "hint"}>
                        {capability.key}
                        {capability.version ? ` ${capability.version}` : ""}
                      </span>
                      {capability.verified_at && (
                        <span className="hint">
                          验证于 <Time value={capability.verified_at} />
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </CardDetailLayout>
  );
}
