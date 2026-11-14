import * as Popover from "@radix-ui/react-popover";
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
import { useResource } from "../useResource.js";

type CapacityResource = ReturnType<typeof useResource<ExecutionCapacity>>;
const CapacityContext = createContext<
  (CapacityResource & { canEdit: boolean }) | undefined
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
  const load = useCallback(
    () => client.executionCapacity(projectId),
    [client, projectId],
  );
  const resource = useResource(load, revision);
  return (
    <CapacityContext.Provider value={{ ...resource, canEdit }}>
      {children}
    </CapacityContext.Provider>
  );
}

export const useCapacity = () => useContext(CapacityContext);

export function CapacityDetails({ data }: { data: ExecutionCapacity }) {
  return (
    <>
      <strong>并发与容量 · 全项目共用</strong>
      {data.agents.length === 0 && <p>暂无 Agent 机器</p>}
      {data.agents.map((machine) => (
        <div className="capacity-detail-row" key={machine.machine_id}>
          <strong>{machine.label} · Agent</strong>
          <span>
            全部 {machine.total_running} · 非常驻 {machine.running} / 上限{" "}
            {machine.limit || "不可用"} / 排队 {machine.queued}
          </span>
          {machine.merge_check_slots > 0 && (
            <span>
              本机 CI 另占 {machine.merge_check_slots} 个 Agent 名额。
            </span>
          )}
        </div>
      ))}
      <p>
        常驻 PM（Office / Ops）和主机运维不占额度、不参与容量排队；工作项 PM
        与其他 Agent
        一样排队。上限比较非常驻占用，全部计数包含常驻。占用含启动和停止预留。
      </p>
      {data.merge_checks.map((target) => (
        <div className="capacity-detail-row" key={target.machine_id}>
          <strong>{target.machine_id} · CI</strong>
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
      <p>上限可在设置的“并发与容量”中查看。</p>
    </>
  );
}

export function CapacityStatus() {
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
  const summary = error
    ? "容量读取失败"
    : data
      ? `Agent ${agents} · 排队 ${sum(data.agents, "queued")} · CI ${ci}`
      : "容量读取中…";
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <button
          type="button"
          className="capacity-status quiet"
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
                ? `A ${agents}${sum(data.agents, "queued") ? ` · 队${sum(data.agents, "queued")}` : ""} · CI ${ci === "未启用" ? "—" : ci}`
                : "容量…"}
          </span>
        </button>
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
