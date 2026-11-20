import { useEffect, useMemo, useState } from "react";
import {
  ApiError,
  type CardiganClient,
  describeError,
  type ExecutionCapacity,
  type MachineBindingView,
  type MachineView,
} from "../api.js";
import { useCapacity } from "../components/Capacity.js";
import { Drawer } from "../components/Drawer.js";
import { EmptyState, StatusTag, Time } from "../components/Foundation.js";
import { IdTag } from "../components/IdTag.js";
import { CardDetailLayout } from "../components/layout/CardDetailLayout.js";
import { DataTableCell } from "../components/layout/DataTableLayout.js";
import {
  SettingsDrawerFeedback,
  SettingsFact,
  SettingsFacts,
  SettingsPanel,
  SettingsSection,
  SettingsTable,
  settingsDrawerClassName,
  useDrawerReturnFocus,
} from "../components/layout/SettingsLayout.js";
import { CAPABILITY_TAGS } from "../components/MachineDetail.js";
import { CardLink } from "../components/Operations.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import {
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.js";
import {
  bindingChecks,
  capabilityState,
  latestMachineCheck,
  type MachineCheckRow,
  machineActiveRuns,
} from "../machine-labels.js";
import { useResource } from "../useResource.js";

/** A read the server refused (401/403) or that is no longer visible (404). */
type Withdrawn = { readonly withdrawn: string };
const WITHDRAWN_STATUSES = new Set([401, 403, 404]);
/**
 * C-512 (V-2475): such a reply replaces what was read before instead of
 * leaving it on screen beside the error. It stays in place through a retry
 * in flight until a read succeeds. Other failures keep the last good read.
 */
function withdrawable<T>(read: () => Promise<T>) {
  return async (): Promise<T | Withdrawn> => {
    try {
      return await read();
    } catch (error) {
      if (error instanceof ApiError && WITHDRAWN_STATUSES.has(error.status))
        return { withdrawn: describeError(error) };
      throw error;
    }
  };
}
function withdrawnOf(data: object | undefined): string | undefined {
  return data && "withdrawn" in data
    ? (data as Withdrawn).withdrawn
    : undefined;
}

const platform = (m: MachineView) =>
  [m.os, m.arch].filter(Boolean).join(" / ") || "—";
type AgentCapacity = ExecutionCapacity["agents"][number];
/**
 * The limited (non-standing) count from the shared capacity read, beside the
 * limit the machine read confirmed (the same value as its resource limits),
 * so one drawer never shows two limits. Standing sessions are exempt.
 */
const limited = (m: MachineView, capacity: AgentCapacity | undefined) =>
  `${capacity ? capacity.running : "—"} / ${m.run_limit || "不可用"}`;
/**
 * The shared capacity read as the machine panel uses it, in one of two
 * states (Q-1013). Usable: the last successful read is shown, also while an
 * ordinary background refresh is in flight. Stale: entered on any failed
 * read and left only when a later read completes without error; a retry or
 * refresh in flight does not count. While stale the counts are "—" (the
 * resource keeps the failed snapshot, which is no longer current). The state
 * lives with the project's shared capacity read; it is read once per panel
 * and handed to its drawer, so both always agree.
 */
function useMachineCapacity() {
  const capacity = useCapacity();
  const error = capacity?.error;
  const pending = capacity?.pending ?? false;
  // Kept by the project's capacity provider, not this panel: leaving the
  // panel and coming back does not forget a failure (Q-1017).
  const stale = capacity?.stale ?? false;
  const agents = stale ? undefined : capacity?.data?.agents;
  return {
    of: (id: string) => agents?.find((a) => a.machine_id === id),
    error,
    retrying: stale && !error && pending,
    reload: capacity?.reload,
  };
}
type MachineCapacity = ReturnType<typeof useMachineCapacity>;
function CapacityFeedback({ capacity }: { capacity: MachineCapacity }) {
  return (
    <RequestFeedback
      error={capacity.error ? `并发读数未能更新：${capacity.error}` : undefined}
      pending={capacity.retrying}
      interactive
      pendingMessage="正在重新读取并发读数…"
      retry={capacity.reload}
    />
  );
}

function MachineStatus({ status }: { status: string | undefined }) {
  return status ? (
    <StatusTag status={status} />
  ) : (
    <StatusTag status="unknown" subdued />
  );
}
function CheckTag({ check }: { check: MachineCheckRow | undefined }) {
  return check ? (
    <StatusTag
      status={check.status === "unreadable" ? "unknown" : check.status}
      label={check.label}
      subdued={check.status === "unreadable"}
    />
  ) : (
    <StatusTag status="not_run" label="未检查" subdued />
  );
}

/**
 * C-512: the machines this host manages, read only. Machines are global; the
 * detail lists each project binding the server returns and marks this one.
 * Checking, draining and limits are not changed here (C-511).
 */
export function MachinesSettings({
  client,
  projectId,
  revision = 0,
}: {
  client: CardiganClient;
  projectId: string;
  revision?: number;
}) {
  const load = useMemo(
    () => withdrawable(() => client.machines(projectId)),
    [client, projectId],
  );
  const list = useResource(load, revision);
  const [open, setOpen] = useState<MachineView>();
  const { remember } = useDrawerReturnFocus(open !== undefined);
  const withdrawn = withdrawnOf(list.data);
  const machines =
    list.data && !withdrawn && "machines" in list.data
      ? list.data.machines
      : undefined;
  // A list the server no longer allows takes its open detail with it.
  useEffect(() => {
    if (withdrawn) setOpen(undefined);
  }, [withdrawn]);
  const capacity = useMachineCapacity();
  return (
    <SettingsPanel
      id="machines"
      tabIndex={-1}
      title="机器"
      titleId="machines-title"
    >
      <RequestFeedback
        {...list}
        error={list.error ?? (list.pending ? undefined : withdrawn)}
        retry={list.reload}
        pendingMessage="正在加载机器…"
      />
      {/* An open drawer reports it in its own body. */}
      {!open && <CapacityFeedback capacity={capacity} />}
      {machines && machines.length === 0 && <EmptyState>没有机器</EmptyState>}
      {machines && machines.length > 0 && (
        <SettingsTable aria-label="机器列表">
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>系统</TableHead>
              <TableHead>最近心跳</TableHead>
              <TableHead>非常驻 / 上限</TableHead>
              <TableHead>最近检查</TableHead>
              <TableHead>状态</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {machines.map((machine) => {
              const latest = latestMachineCheck(machine);
              return (
                <TableRow key={machine.id}>
                  <DataTableCell data-record="lead">
                    <Button
                      variant="link"
                      aria-haspopup="dialog"
                      onClick={() => {
                        remember();
                        setOpen(machine);
                      }}
                    >
                      {machine.label}
                    </Button>
                  </DataTableCell>
                  <DataTableCell nowrap data-label="系统">
                    {platform(machine)}
                  </DataTableCell>
                  <DataTableCell nowrap data-label="最近心跳">
                    <Time value={machine.last_seen} />
                  </DataTableCell>
                  <DataTableCell nowrap data-label="非常驻 / 上限">
                    {limited(machine, capacity.of(machine.id))}
                  </DataTableCell>
                  <DataTableCell nowrap data-label="最近检查">
                    <CheckTag check={latest?.check} />
                    {latest && !latest.binding.is_current && (
                      <> {latest.binding.project_name}</>
                    )}
                  </DataTableCell>
                  <DataTableCell nowrap data-record="aside">
                    <MachineStatus status={machine.status} />
                  </DataTableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </SettingsTable>
      )}
      {open && !withdrawn && (
        <MachineDrawer
          key={open.id}
          client={client}
          projectId={projectId}
          summary={open}
          revision={revision}
          capacity={capacity}
          onClose={() => setOpen(undefined)}
        />
      )}
    </SettingsPanel>
  );
}

/** Read-only detail; it reads the machine again so the facts are current. */
function MachineDrawer({
  client,
  projectId,
  summary,
  revision,
  capacity,
  onClose,
}: {
  client: CardiganClient;
  projectId: string;
  summary: MachineView;
  revision: number;
  capacity: MachineCapacity;
  onClose: () => void;
}) {
  const load = useMemo(
    () => withdrawable(() => client.machine(projectId, summary.id)),
    [client, projectId, summary.id],
  );
  const detail = useResource(load, revision);
  const withdrawn = withdrawnOf(detail.data);
  const machine =
    detail.data && !withdrawn && "machine" in detail.data
      ? detail.data.machine
      : undefined;
  return (
    <Drawer
      className={settingsDrawerClassName}
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={machine?.label ?? (withdrawn ? "机器" : summary.label)}
      description={withdrawn ? "机器详情" : `机器 ${summary.id} 详情`}
      initialFocus="close"
    >
      <CardDetailLayout
        className="card-page-drawer"
        aria-label={withdrawn ? "机器详情" : `机器 ${summary.id}`}
      >
        <SettingsDrawerFeedback>
          <RequestFeedback
            {...detail}
            error={detail.error ?? (detail.pending ? undefined : withdrawn)}
            retry={detail.reload}
            pendingMessage="正在加载机器…"
          />
          <CapacityFeedback capacity={capacity} />
        </SettingsDrawerFeedback>
        {machine && <MachineFacts machine={machine} capacity={capacity} />}
      </CardDetailLayout>
    </Drawer>
  );
}

function MachineFacts({
  machine,
  capacity: shared,
}: {
  machine: MachineView;
  capacity: MachineCapacity;
}) {
  const capacity = shared.of(machine.id);
  const bindings = [...machine.bindings].sort(
    (a, b) => Number(b.is_current) - Number(a.is_current),
  );
  // Capability evidence belongs to the project that observed it.
  const capabilities = bindings.flatMap((binding) =>
    [...binding.capabilities]
      .map((c) => ({ ...c, state: capabilityState(c) }))
      .sort(
        (a, b) =>
          CAPABILITY_TAGS[a.state].order - CAPABILITY_TAGS[b.state].order ||
          a.key.localeCompare(b.key),
      )
      .map((capability) => ({ binding, capability })),
  );
  const runs = bindings.flatMap((b) =>
    b.assignments.flatMap((a) =>
      a.runs.map((run) => ({
        binding: b,
        assignment: a,
        run,
        card: run.card_id ?? a.card_id,
      })),
    ),
  );
  const checks = bindings.flatMap((b) =>
    bindingChecks(b, machine.id).map((check) => ({ binding: b, check })),
  );
  return (
    <>
      <SettingsSection title="概况">
        <SettingsFacts>
          <SettingsFact label="编号">
            <code>{machine.id}</code>
          </SettingsFact>
          <SettingsFact label="系统与架构">{platform(machine)}</SettingsFact>
          <SettingsFact label="状态">
            <MachineStatus status={machine.status} />
          </SettingsFact>
          <SettingsFact label="最近心跳">
            <Time value={machine.last_seen} />
          </SettingsFact>
          <SettingsFact label="全部在跑">
            {machineActiveRuns(machine)}
          </SettingsFact>
          <SettingsFact label="非常驻 / 上限">
            {limited(machine, capacity)}
          </SettingsFact>
          <SettingsFact label="排队">{capacity?.queued ?? "—"}</SettingsFact>
        </SettingsFacts>
      </SettingsSection>
      <SettingsSection title="资源上限">
        <SettingsFacts>
          <SettingsFact label="Agent 并发">
            {machine.run_limit}（最多可设 {machine.run_limit_maximum}）
          </SettingsFact>
          {machine.resources.map((resource) => (
            <SettingsFact key={resource.key} label={resource.key}>
              {resource.limit}
            </SettingsFact>
          ))}
        </SettingsFacts>
      </SettingsSection>
      <SettingsSection title="已验证能力">
        {capabilities.length === 0 ? (
          <p>没有能力记录</p>
        ) : (
          <SettingsTable aria-label="已验证能力">
            <TableHeader>
              <TableRow>
                <TableHead>能力</TableHead>
                <TableHead>项目</TableHead>
                <TableHead>版本</TableHead>
                <TableHead>验证时间</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {capabilities.map(({ binding, capability: c }) => {
                const tag = CAPABILITY_TAGS[c.state];
                return (
                  <TableRow key={`${binding.project_id}:${c.key}`}>
                    <DataTableCell nowrap data-record="lead">
                      <code>{c.key}</code>
                    </DataTableCell>
                    <DataTableCell data-label="项目">
                      {binding.project_name}
                    </DataTableCell>
                    <DataTableCell nowrap data-label="版本">
                      {c.version ?? "—"}
                    </DataTableCell>
                    <DataTableCell nowrap data-label="验证时间">
                      {c.verified_at ? <Time value={c.verified_at} /> : "—"}
                    </DataTableCell>
                    <DataTableCell nowrap data-record="aside">
                      <StatusTag
                        status={tag.status}
                        label={tag.label}
                        subdued={c.state !== "verified"}
                      />
                    </DataTableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </SettingsTable>
        )}
      </SettingsSection>
      <SettingsSection title="项目绑定">
        <SettingsTable aria-label="项目绑定">
          <TableHeader>
            <TableRow>
              <TableHead>项目</TableHead>
              <TableHead>账号</TableHead>
              <TableHead>目录</TableHead>
              <TableHead>会话</TableHead>
              <TableHead>PATH</TableHead>
              <TableHead>状态</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {bindings.map((b) => (
              <BindingRow key={b.project_id} binding={b} />
            ))}
          </TableBody>
        </SettingsTable>
      </SettingsSection>
      <SettingsSection title="在跑任务">
        {runs.length === 0 ? (
          <p>没有在跑任务</p>
        ) : (
          <SettingsTable aria-label="在跑任务">
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>项目</TableHead>
                <TableHead>卡片</TableHead>
                <TableHead>员工</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map(({ binding, card, run, assignment }) => (
                // Run ids are numbered per project.
                <TableRow key={`${binding.project_id}:${run.id}`}>
                  <DataTableCell nowrap data-record="lead">
                    <IdTag id={run.id} />
                  </DataTableCell>
                  <DataTableCell data-label="项目">
                    {binding.project_name}
                  </DataTableCell>
                  <DataTableCell nowrap data-label="卡片">
                    {card ? (
                      <CardLink projectId={binding.project_id} id={card} />
                    ) : (
                      "—"
                    )}
                  </DataTableCell>
                  <DataTableCell nowrap data-label="员工">
                    {assignment.employee_name ?? "—"}
                  </DataTableCell>
                  <DataTableCell nowrap data-label="角色">
                    <code>{assignment.role_id}</code>
                  </DataTableCell>
                  <DataTableCell nowrap data-record="aside">
                    <StatusTag status={run.status} />
                  </DataTableCell>
                </TableRow>
              ))}
            </TableBody>
          </SettingsTable>
        )}
      </SettingsSection>
      <SettingsSection title="最近检查">
        {checks.length === 0 ? (
          <p>没有检查记录</p>
        ) : (
          <SettingsTable aria-label="最近检查">
            <TableHeader>
              <TableRow>
                <TableHead>类型</TableHead>
                <TableHead>项目</TableHead>
                <TableHead>时间</TableHead>
                <TableHead>失败步骤</TableHead>
                <TableHead>结果</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {checks.map(({ binding, check }) => (
                <TableRow key={`${binding.project_id}:${check.key}`}>
                  <DataTableCell nowrap data-record="lead">
                    {check.kind}
                  </DataTableCell>
                  <DataTableCell data-label="项目">
                    {binding.project_name}
                  </DataTableCell>
                  <DataTableCell nowrap data-label="时间">
                    {check.checked_at ? <Time value={check.checked_at} /> : "—"}
                  </DataTableCell>
                  <DataTableCell data-label="失败步骤">
                    {check.steps.length ? check.steps.join("、") : "—"}
                  </DataTableCell>
                  <DataTableCell nowrap data-record="aside">
                    <CheckTag check={check} />
                  </DataTableCell>
                </TableRow>
              ))}
            </TableBody>
          </SettingsTable>
        )}
      </SettingsSection>
    </>
  );
}

/** One project's registration. Only the summary the server returns is shown. */
function BindingRow({ binding }: { binding: MachineBindingView }) {
  const runtime = binding.runtime;
  const missing = binding.config_available ? "—" : "配置不可读";
  return (
    <TableRow aria-current={binding.is_current ? "true" : undefined}>
      <DataTableCell data-record="lead">
        {binding.project_name}
        {binding.is_current && (
          <>
            {" "}
            <Badge>当前项目</Badge>
          </>
        )}
      </DataTableCell>
      <DataTableCell nowrap data-label="账号">
        {runtime ? (runtime.account ?? "—") : missing}
      </DataTableCell>
      <DataTableCell data-label="目录">
        {runtime?.directory ? <code>{runtime.directory}</code> : "—"}
      </DataTableCell>
      <DataTableCell nowrap data-label="会话">
        {runtime ? <code>{runtime.session}</code> : "—"}
      </DataTableCell>
      <DataTableCell nowrap data-label="PATH">
        {runtime ? `${runtime.path_entries} 项` : "—"}
      </DataTableCell>
      <DataTableCell nowrap data-record="aside">
        <StatusTag status={binding.status} />
      </DataTableCell>
    </TableRow>
  );
}
