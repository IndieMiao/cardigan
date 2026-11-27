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
import { routeHash } from "../route.js";
import { settingKey, trackSettingsRead } from "../settings-clock.js";
import { usePageVisible } from "../usePageVisible.js";
import { useResource } from "../useResource.js";
import {
  CapacityCell,
  CapacityGroup,
  CapacityHeading,
  CapacityLink,
  CapacityLinks,
  CapacityPanel,
  CapacityRow,
  CapacityTable,
  CapacityTag,
  CapacityTags,
} from "./layout/CapacityLayout.js";
import { Button } from "./ui/button.js";
import * as Popover from "./ui/popover.js";

/** The help document that explains how capacity is counted. */
export const CAPACITY_HELP_SLUG = "07-capacity";

type CapacityResource = ReturnType<typeof useResource<ExecutionCapacity>>;
const CapacityContext = createContext<
  | (CapacityResource & {
      projectId: string;
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
  // C-775: a background tab stops reading and reads once when shown again.
  const resource = useResource(load, revision, usePageVisible());
  // Held by the provider (one per project, always mounted), so leaving and
  // returning to a page that reads it does not lose a failure.
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (resource.error) setFailed(true);
    else if (!resource.pending) setFailed(false);
  }, [resource.error, resource.pending]);
  const stale = Boolean(resource.error) || failed;
  return (
    <CapacityContext.Provider
      value={{ ...resource, projectId, canEdit, stale }}
    >
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

type Slots = { used: number; limit: number; queued: number };
/** Full, unusable (limit 0) or queued slots need attention. */
const full = ({ used, limit }: Slots) => limit <= 0 || used >= limit;
const resourceState = (r: { occupied: number; limit: number }) =>
  r.limit > 0 && r.occupied >= r.limit
    ? ("full" as const)
    : r.limit <= 0 || r.occupied === 0
      ? ("idle" as const)
      : ("used" as const);

function SlotCells(slots: Slots) {
  return (
    <>
      <CapacityCell kind="numeric" tone={full(slots) ? "wait" : undefined}>
        {slots.used}/{slots.limit > 0 ? slots.limit : "—"}
      </CapacityCell>
      <CapacityCell kind="numeric" tone={slots.queued > 0 ? "wait" : undefined}>
        {slots.queued}
      </CapacityCell>
    </>
  );
}

/**
 * C-824: one compact table, a row per Agent machine and CI target. The
 * counting rules live in the help page, not in the popover.
 */
export function CapacityDetails({
  data,
  projectId,
}: {
  data: ExecutionCapacity;
  projectId: string;
}) {
  const resources = data.agents.some(
    (m) => m.merge_check_slots > 0 || !!m.resources?.length,
  );
  const columns = resources ? 4 : 3;
  return (
    <>
      <CapacityHeading>并发与容量 · 全项目共用</CapacityHeading>
      <CapacityTable resources={resources}>
        <CapacityGroup label="Agent" columns={columns}>
          {data.agents.length === 0 && (
            <CapacityRow attention={false}>
              <CapacityCell colSpan={columns}>没有 Agent 机器</CapacityCell>
            </CapacityRow>
          )}
          {data.agents.map((machine) => {
            // C-576: 占用 is what the scheduler compares with the limit:
            // limited Runs plus this host's CI slots.
            const slots = {
              used: machine.running + machine.merge_check_slots,
              limit: machine.limit,
              queued: machine.queued,
            };
            return (
              <CapacityRow
                key={machine.machine_id}
                attention={full(slots) || slots.queued > 0}
              >
                <CapacityCell kind="name">{machine.label}</CapacityCell>
                <SlotCells {...slots} />
                {resources && (
                  <CapacityCell kind="resources">
                    <CapacityTags>
                      {machine.merge_check_slots > 0 && (
                        <CapacityTag state="used">
                          本机 CI {machine.merge_check_slots}
                        </CapacityTag>
                      )}
                      {machine.resources?.map((r) => (
                        <CapacityTag key={r.key} state={resourceState(r)}>
                          {r.key} {r.occupied}/{r.limit}
                        </CapacityTag>
                      ))}
                    </CapacityTags>
                  </CapacityCell>
                )}
              </CapacityRow>
            );
          })}
        </CapacityGroup>
        <CapacityGroup label="CI" columns={columns}>
          {data.merge_config_invalid ? (
            <CapacityRow attention>
              <CapacityCell colSpan={columns} tone="wait">
                <span role="alert">合并检查配置无效，容量信息不完整</span>
              </CapacityCell>
            </CapacityRow>
          ) : data.merge_checks.length === 0 ? (
            <CapacityRow attention={false}>
              <CapacityCell colSpan={columns}>未启用合并检查</CapacityCell>
            </CapacityRow>
          ) : (
            data.merge_checks.map((target) => {
              const slots = {
                used: target.running,
                limit: target.limit,
                queued: target.queued,
              };
              return (
                <CapacityRow
                  key={target.machine_id}
                  attention={full(slots) || slots.queued > 0}
                >
                  <CapacityCell kind="name">{target.machine_id}</CapacityCell>
                  <SlotCells {...slots} />
                  {resources && (
                    <CapacityCell kind="resources">{null}</CapacityCell>
                  )}
                </CapacityRow>
              );
            })
          )}
        </CapacityGroup>
      </CapacityTable>
      <CapacityLinks>
        <CapacityLink
          href={routeHash({
            kind: "help",
            projectId,
            filters: { doc: CAPACITY_HELP_SLUG },
          })}
        >
          口径说明
        </CapacityLink>
        <CapacityLink
          href={routeHash({
            kind: "settings",
            projectId,
            filters: { tab: "machines" },
          })}
        >
          修改上限
        </CapacityLink>
      </CapacityLinks>
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
      <CapacityPanel
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
        onClick={(event) => {
          // A link leaves for the help or settings page.
          if ((event.target as Element).closest("a")) setOpen(false);
        }}
      >
        {error ? (
          <p role="alert">读取并发信息失败：{error}。可在设置中重试。</p>
        ) : data ? (
          <CapacityDetails data={data} projectId={resource.projectId} />
        ) : (
          <p>正在读取并发信息…</p>
        )}
      </CapacityPanel>
    </Popover.Root>
  );
}

// Existing consumers keep the same component identity.
export { CapacitySummary as CapacityStatus };
