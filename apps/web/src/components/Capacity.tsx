import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { CardiganClient, ExecutionCapacity } from "../api.js";
import { settingKey, trackSettingsRead } from "../settings-clock.js";
import { useResource } from "../useResource.js";

import { Button } from "./ui/button.js";
import * as Popover from "./ui/popover.js";

type CapacityResource = ReturnType<typeof useResource<ExecutionCapacity>>;
const CapacityContext = createContext<
  | (CapacityResource & {
      canEdit: boolean;
      /**
       * C-512 (Q-1017): true from a failed read until a later read of this
       * project completes without error; a retry or refresh in flight does
       * not clear it. The kept `data` is then not current. Readers that do
       * not use it keep their behaviour.
       */
      stale: boolean;
    })
  | undefined
>(undefined);

/** One read shared by every page title and the settings form. No browser polling. */
export function CapacityProvider({
  client,
  projectId,
  revision,
  canEdit,
  children,
}: {
  client: CardiganClient;
  projectId: string;
  revision: number;
  canEdit: boolean;
  children: ReactNode;
}) {
  // Ordered against the settings page's limit writes (instant save, C-479);
  // each machine's limit confirms its write even with the settings page left.
  const load = useCallback(
    () =>
      trackSettingsRead(client.executionCapacity(projectId), (data) =>
        data.agents.map(
          (agent) =>
            [
              settingKey(projectId, runLimitSetting(agent.machine_id)),
              agent.limit,
            ] as const,
        ),
      ),
    [client, projectId],
  );
  const resource = useResource(load, revision);
  // Held by the provider (one per project, always mounted), so leaving and
  // returning to a page that reads it does not lose a failure.
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (resource.error) setFailed(true);
    else if (!resource.pending) setFailed(false);
  }, [resource.error, resource.pending]);
  const stale = Boolean(resource.error) || failed;
  return (
    <CapacityContext.Provider value={{ ...resource, canEdit, stale }}>
      {children}
    </CapacityContext.Provider>
  );
}

export const useCapacity = () => useContext(CapacityContext);

/** The settings identity of one machine's Agent limit (its machine id). */
export const runLimitSetting = (machineId: string) => `run-limit:${machineId}`;

export function checkCapacityPolicy(
  target: ExecutionCapacity["merge_checks"][number],
) {
  if (target.executor_type === "github")
    return "GitHub · 同项目可并行，作者预检与合并检查共用目标容量";
  if (target.executor_type === "ssh")
    return `SSH · 每项目一个检查，目标配置上限 ${target.target_limit ?? target.limit}`;
  if (target.executor_type === "local") return "本机 · 每项目一个检查";
  return "";
}

export function CapacityDetails({ data }: { data: ExecutionCapacity }) {
  return (
    <>
      <strong>并发与容量 · 全项目共用</strong>
      {data.agents.length === 0 && <p>暂无 Agent 机器</p>}
      {data.agents.map((machine) => (
        <div className="capacity-detail-row" key={machine.machine_id}>
          <strong>{machine.label} · Agent</strong>
          <span>
            {/* C-576: 占用 is what the scheduler compares with the limit, as
                on the machine page: limited Runs plus this host's CI slots. */}
            全部 {machine.total_running} · 占用{" "}
            {machine.running + machine.merge_check_slots} / 上限{" "}
            {machine.limit || "不可用"} / 排队 {machine.queued}
          </span>
          {!!machine.resources?.length && (
            <span>
              资源{" "}
              {machine.resources
                .map((r) => `${r.key} ${r.occupied}/${r.limit}`)
                .join(" · ")}
            </span>
          )}
          {machine.merge_check_slots > 0 && (
            <span>
              本机 CI 另占 {machine.merge_check_slots} 个 Agent 名额。
            </span>
          )}
        </div>
      ))}
      <p>
        常驻 PM（Office / Ops）和主机运维不占额度、不参与容量排队；工作项 PM
        与其他 Agent 一样排队。上限比较占用：占用不含常驻、含本机 CI
        名额，全部计数包含常驻。占用含启动和停止预留。
      </p>
      {data.merge_checks.map((target) => (
        <div className="capacity-detail-row" key={target.machine_id}>
          <strong>{target.machine_id} · CI</strong>
          <span>{checkCapacityPolicy(target)}</span>
          <span>
            运行中 {target.running} / 上限 {target.limit || "不可用"} / 排队{" "}
            {target.queued}
          </span>
        </div>
      ))}
      {data.merge_config_invalid ? (
        <p role="alert">合并检查配置无效，容量信息不完整。</p>
      ) : (
        data.merge_checks.length === 0 && <p>未启用合并检查</p>
      )}
      <p>
        检查占用包含尚未确认结束的远端运行；排队包含作者预检。上限可在设置 →
        机器的详情中修改。
      </p>
    </>
  );
}

export function CapacitySummary({
  byMachine = false,
}: {
  byMachine?: boolean;
}) {
  const resource = useCapacity();
  const [open, setOpen] = useState(false);
  const id = useId();
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const keepOpen = () => {
    clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const leave = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  if (!resource) return null;
  const { data, error } = resource;
  const sum = (
    rows: readonly { running: number; limit: number; queued: number }[],
    key: "running" | "limit" | "queued",
  ) => rows.reduce((total, row) => total + row[key], 0);
  const agents = data
    ? `${sum(data.agents, "running")}/${data.agents.length && data.agents.every((m) => m.limit > 0) ? sum(data.agents, "limit") : "—"}`
    : "—";
  const ci =
    data && !data.merge_config_invalid
      ? data.merge_checks.length
        ? `${sum(data.merge_checks, "running")}/${data.merge_checks.every((m) => m.limit > 0) ? sum(data.merge_checks, "limit") : "—"}`
        : "未启用"
      : "—";
  const machines = data?.agents
    .map((m) => `${m.label} ${m.running}/${m.limit || "—"}`)
    .join(" · ");
  const summary = error
    ? "容量读取失败"
    : data
      ? byMachine && machines
        ? machines
        : `Agent ${agents} · 排队 ${sum(data.agents, "queued")} · CI ${ci}`
      : "容量读取中…";
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <Button
          type="button"
          variant="ghost"
          size="content"
          className="capacity-status quiet ui-page-capacity"
          aria-label={`${summary}，查看并发与容量详情`}
          aria-describedby={open ? id : undefined}
          onPointerEnter={(event) => {
            if (event.pointerType !== "touch") keepOpen();
          }}
          onPointerLeave={(event) => {
            if (document.activeElement !== event.currentTarget) leave();
          }}
          onFocus={keepOpen}
          onBlur={leave}
          onClick={keepOpen}
        >
          <span className="capacity-wide" aria-hidden="true">
            {summary}
          </span>
          <span className="capacity-compact" aria-hidden="true">
            {error
              ? "容量异常"
              : data
                ? byMachine && machines
                  ? machines
                  : `A ${agents}${sum(data.agents, "queued") ? ` · 队${sum(data.agents, "queued")}` : ""} · CI ${ci === "未启用" ? "—" : ci}`
                : "容量…"}
          </span>
        </Button>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          id={id}
          role="tooltip"
          tabIndex={0}
          className="capacity-tooltip"
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onPointerEnter={keepOpen}
          onPointerLeave={leave}
          onFocus={keepOpen}
          onBlur={leave}
        >
          {error ? (
            <p role="alert">读取并发信息失败：{error}。可在设置中重试。</p>
          ) : data ? (
            <CapacityDetails data={data} />
          ) : (
            <p>正在读取并发信息…</p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// Existing consumers keep the same component identity.
export { CapacitySummary as CapacityStatus };
