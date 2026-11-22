import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ApiError,
  type CardiganClient,
  describeError,
  type ExecutionCapacity,
  type MachineBindingView,
  type MachineView,
} from "../api.js";
import { runLimitSetting, useCapacity } from "../components/Capacity.js";
import { Drawer } from "../components/Drawer.js";
import { EmptyState, StatusTag, Time } from "../components/Foundation.js";
import { IdTag } from "../components/IdTag.js";
import { CardDetailLayout } from "../components/layout/CardDetailLayout.js";
import { DataTableCell } from "../components/layout/DataTableLayout.js";
import {
  SettingsConfirmDialog,
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
import {
  RequestFeedback,
  type RequestFeedbackProps,
} from "../components/RequestFeedback.js";
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
  checkStepLabel,
  latestMachineCheck,
  type MachineCheckRow,
  machineActiveRuns,
} from "../machine-labels.js";
import { settingKey, trackSettingsRead } from "../settings-clock.js";
import { statusLabel } from "../status.js";
import { useResource } from "../useResource.js";
import { MachineAgentLimit, MergeCheckCapacity } from "./AgentLimit.js";
import {
  checkingWithoutId,
  machineActions,
  machineReadTick,
  runningCheck,
} from "./machine-actions.js";
import { useNotice } from "./useSettingWrite.js";
import {
  storedWizard,
  type WizardExit,
  WorkerWizardDrawer,
} from "./WorkerWizard.js";

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
 * C-512: the machines this host manages. Machines are global; the detail
 * lists each project binding the server returns and marks this one.
 * C-511: a human session can check, drain/resume and set the Agent limit in
 * the detail, and add a worker with the wizard. The server decides who may.
 */
export function MachinesSettings({
  client,
  projectId,
  revision = 0,
  pollMs = 1000,
}: {
  client: CardiganClient;
  projectId: string;
  revision?: number;
  /** How often a running check or wizard step is read again. */
  pollMs?: number;
}) {
  const load = useMemo(
    () => withdrawable(() => client.machines(projectId)),
    [client, projectId],
  );
  const list = useResource(load, revision);
  const [open, setOpen] = useState<MachineView>();
  const withdrawn = withdrawnOf(list.data);
  const machines =
    list.data && !withdrawn && "machines" in list.data
      ? list.data.machines
      : undefined;
  // A list the server no longer allows takes its open detail with it, and
  // so does a list read that no longer contains the open machine (V-2482):
  // its earlier detail must not outlive it, whatever the detail read says.
  // Decided while rendering, so no frame shows both. While the list still
  // contains it, a failed detail refresh keeps the last good detail.
  const shown =
    open && !withdrawn && (!machines || machines.some((m) => m.id === open.id))
      ? open
      : undefined;
  useEffect(() => {
    if (open && !shown) setOpen(undefined);
  }, [open, shown]);
  // When the system closes the detail (refused list, machine gone), its
  // opener may be gone too: focus then goes to the machine panel.
  const { remember } = useDrawerReturnFocus(shown !== undefined, () =>
    document.getElementById("machines"),
  );
  const capacity = useMachineCapacity();
  const canEdit = useCapacity()?.canEdit ?? false;
  // An action changes the registry: the list, the detail and the shared
  // capacity read all read again.
  const reloadList = list.reload;
  const reloadCapacity = capacity.reload;
  const changed = useCallback(() => {
    reloadList();
    reloadCapacity?.();
  }, [reloadList, reloadCapacity]);
  const [wizard, setWizard] = useState(false);
  const [resumable, setResumable] = useState(() => !!storedWizard(projectId));
  const [notice, setNotice] = useNotice();
  const wizardFocus = useDrawerReturnFocus(wizard, () =>
    document.getElementById("machines"),
  );
  const closeWizard = (exit: WizardExit) => {
    setWizard(false);
    setResumable(!!storedWizard(projectId));
    if (exit === "kept") setNotice("已保留添加 worker 的进度，可稍后继续");
    else if (exit === "cancelled") setNotice("已放弃添加 worker");
  };
  return (
    <SettingsPanel
      id="machines"
      tabIndex={-1}
      title="机器"
      titleId="machines-title"
      actions={
        canEdit && client.createWorkerWizard ? (
          <Button
            variant="primary"
            aria-haspopup="dialog"
            onClick={() => {
              wizardFocus.remember();
              setWizard(true);
            }}
          >
            {resumable ? "继续添加 worker" : "添加 worker"}
          </Button>
        ) : undefined
      }
    >
      <RequestFeedback
        {...list}
        error={list.error ?? (list.pending ? undefined : withdrawn)}
        retry={list.reload}
        pendingMessage="正在加载机器…"
      />
      <RequestFeedback message={notice} />
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
      <MergeCheckCapacity />
      {shown && (
        <MachineDrawer
          key={shown.id}
          client={client}
          projectId={projectId}
          summary={shown}
          revision={revision}
          capacity={capacity}
          canEdit={canEdit}
          pollMs={pollMs}
          onChanged={changed}
          onClose={() => setOpen(undefined)}
        />
      )}
      {wizard && (
        <WorkerWizardDrawer
          client={client}
          projectId={projectId}
          pollMs={pollMs}
          onChanged={changed}
          onClose={closeWizard}
        />
      )}
    </SettingsPanel>
  );
}

/** The detail reads the machine again so the facts are current. */
function MachineDrawer({
  client,
  projectId,
  summary,
  revision,
  capacity,
  canEdit,
  pollMs,
  onChanged,
  onClose,
}: {
  client: CardiganClient;
  projectId: string;
  summary: MachineView;
  revision: number;
  capacity: MachineCapacity;
  canEdit: boolean;
  pollMs: number;
  onChanged: () => void;
  onClose: () => void;
}) {
  // Ordered against the Agent limit's writes, which it confirms (C-511).
  const load = useMemo(
    () =>
      withdrawable(async () => {
        // When the read started, against unknown writes (Q-1074).
        const at = machineReadTick();
        const data = await trackSettingsRead(
          client.machine(projectId, summary.id),
          (data) => [
            [
              settingKey(projectId, runLimitSetting(data.machine.id)),
              data.machine.run_limit,
            ],
          ],
        );
        readTicks.set(data, at);
        return data;
      }),
    [client, projectId, summary.id],
  );
  const detail = useResource(load, revision);
  // V-2549: the detail read is also the read-back after a write whose reply
  // was lost, so a refusal (401/403/404) takes the facts and controls down
  // here, exactly like any refused detail read, until a read succeeds.
  const withdrawn = withdrawnOf(detail.data);
  const machine =
    detail.data && !withdrawn && "machine" in detail.data
      ? detail.data.machine
      : undefined;
  const reloadDetail = detail.reload;
  const changed = useCallback(() => {
    reloadDetail();
    onChanged();
  }, [reloadDetail, onChanged]);
  const actions = useMachineActions({
    client,
    projectId,
    machineId: summary.id,
    machine,
    read: {
      at: detail.data && !withdrawn ? readTicks.get(detail.data) : undefined,
      ok: !!machine && !detail.error && !detail.pending,
      pending: detail.pending,
      reload: reloadDetail,
    },
    pollMs,
    onChanged: changed,
  });
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
      actions={canEdit && machine ? <MachineButtons {...actions} /> : undefined}
    >
      <SettingsConfirmDialog
        open={actions.asking}
        title="仍要重新检查？"
        description="上次请求结果未知，再次检查可能让这台机器多检查一次。"
        cancelLabel="取消"
        confirmLabel="重新检查"
        onCancel={actions.cancelAgain}
        onConfirm={actions.confirmAgain}
        fallbackFocus={() =>
          document.getElementById(checkButtonId(summary.id)) ??
          document.querySelector<HTMLElement>("[aria-label='关闭抽屉']")
        }
      />
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
          <RequestFeedback interactive {...actions.checkFeedback} />
          <RequestFeedback interactive {...actions.drainFeedback} />
        </SettingsDrawerFeedback>
        {machine && (
          <MachineFacts
            machine={machine}
            capacity={capacity}
            limit={
              detail.data && (
                <MachineAgentLimit
                  client={client}
                  projectId={projectId}
                  machine={machine}
                  source={detail.data}
                  saved={changed}
                  canEdit={canEdit}
                />
              )
            }
          />
        )}
      </CardDetailLayout>
    </Drawer>
  );
}

function MachineFacts({
  machine,
  capacity: shared,
  limit,
}: {
  machine: MachineView;
  capacity: MachineCapacity;
  /** The Agent limit: editable when the shared capacity read has it. */
  limit: ReactNode;
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
        {limit}
        {machine.resources.length > 0 && (
          <SettingsFacts>
            {machine.resources.map((resource) => (
              <SettingsFact key={resource.key} label={resource.key}>
                {resource.limit}
              </SettingsFact>
            ))}
          </SettingsFacts>
        )}
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

/** When each detail read started (page tick), by the data it returned. */
const readTicks = new WeakMap<object, number>();
const checkButtonId = (machineId: string) => `machine-check-${machineId}`;

/**
 * C-511: 立即检查 and 排空/恢复 in one machine's drawer. What they are doing
 * lives in the page's action state for this machine (Q-1074), which the
 * drawer subscribes to: closing and reopening it, or a reply arriving after
 * it closed, never lets a second write through. A running check (also one
 * started elsewhere) is followed instead of started again. The check and
 * the drain keep separate feedback. After a lost reply the drawer reads the
 * machine again; that read says what the machine is doing, not what became
 * of the request (Q-1048).
 */
function useMachineActions({
  client,
  projectId,
  machineId,
  machine,
  read,
  pollMs,
  onChanged,
}: {
  client: CardiganClient;
  projectId: string;
  machineId: string;
  /** Undefined while the detail is unread or withdrawn. */
  machine: MachineView | undefined;
  /** The drawer's detail read, which is also the read-back. */
  read: {
    /** Page tick when the shown read started. */
    readonly at: number | undefined;
    /** The last read answered and was allowed. */
    readonly ok: boolean;
    readonly pending: boolean;
    readonly reload: () => void;
  };
  pollMs: number;
  onChanged: () => void;
}) {
  const store = machineActions(projectId, machineId);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const reread = useCallback(() => changed.current(), []);
  useEffect(
    () => store.attach({ client, pollMs, reread: () => changed.current() }),
    [store, client, pollMs],
  );
  // Every allowed read is shown to the action state, once.
  const at = read.ok ? read.at : undefined;
  useEffect(() => {
    if (machine && at !== undefined) store.observe(machine, at);
  }, [store, machine, at]);

  const { sending, following, unknownCheck, unknownDrain, verify } = state;
  /** A read answered and allowed after the write became unknown. */
  const fresh = (since: number) => at !== undefined && at > since;
  const freshCheck = !!unknownCheck && fresh(unknownCheck.at) && !!machine;
  const runningNow = freshCheck ? runningCheck(machine) : undefined;
  const quietlyChecking =
    freshCheck && !runningNow && !!machine && checkingWithoutId(machine);
  // A check without an id to follow: read the machine again until it ends.
  const reloadRead = read.reload;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each answered read schedules the next.
  useEffect(() => {
    if (!quietlyChecking) return;
    const timer = window.setTimeout(reloadRead, pollMs);
    return () => window.clearTimeout(timer);
  }, [quietlyChecking, at, reloadRead, pollMs]);
  // After a lost reply, until a read answers: nothing may be sent.
  const reading =
    (!!unknownCheck && !fresh(unknownCheck.at)) ||
    (!!unknownDrain && !fresh(unknownDrain.at));
  /**
   * Q-1048 5b: a new check the user asks for once more, never a resend; only
   * after an allowed read with no check running.
   */
  const againable =
    freshCheck && !runningNow && !quietlyChecking && !following && !sending;
  const checkLocked =
    !!sending ||
    reading ||
    !!following ||
    !!unknownCheck ||
    !!verify ||
    state.check.retry;
  // Q-1076 R3: the read meant to settle a mark failed or was refused.
  const verifyFailed = !!verify && !fresh(verify.at) && !read.pending;
  const drainLocked = !!sending || reading;
  const [asking, setAsking] = useState(false);
  const askable = useRef(againable);
  askable.current = againable;

  const lostText = "上次检查请求结果未知";
  const progress = (step: string) => checkStepLabel(step);
  const checkFeedback: RequestFeedbackProps = verifyFailed
    ? // The read failed or was refused: its own feedback retries (read only).
      { error: "未能确认正在进行的检查" }
    : verify && !following && !unknownCheck
      ? {
          // A result just shown (the followed check ended) stays readable.
          pending: !state.check.message && !state.check.error,
          pendingMessage: "正在读回机器状态…",
          error: state.check.error,
          message: state.check.message,
        }
      : !unknownCheck
        ? {
            pending: !!following || sending === "check",
            pendingMessage: following
              ? `正在检查：${progress(following.step)}…`
              : "正在开始检查…",
            error: state.check.error,
            retry: state.check.retry ? store.retryProgress : undefined,
            message: state.check.message,
          }
        : following
          ? {
              pending: true,
              pendingMessage: `这台机器正在检查：${progress(following.step)}…`,
              error: state.check.error,
              retry: state.check.retry ? store.retryProgress : undefined,
            }
          : !freshCheck
            ? read.pending
              ? { pending: true, pendingMessage: "正在读回机器状态…" }
              : // The read failed or was refused: its own feedback retries.
                { error: lostText }
            : quietlyChecking
              ? {
                  pending: true,
                  pendingMessage: "这台机器正在检查，正在等待结果…",
                }
              : { error: lostText, retry: reread, retryLabel: "重新读取" };
  const op = unknownDrain?.op;
  const what = op === "drain" ? "排空" : "恢复";
  const origin = op === "drain" ? "online" : "draining";
  const target = op === "drain" ? "draining" : "online";
  const drainSending = sending === "drain" || sending === "resume";
  const drainFeedback: RequestFeedbackProps =
    !unknownDrain || drainSending
      ? {
          pending: drainSending,
          pendingMessage: sending === "resume" ? "正在恢复…" : "正在排空…",
          error: state.drain.error,
          message: state.drain.message,
        }
      : !fresh(unknownDrain.at) || !machine
        ? read.pending
          ? { pending: true, pendingMessage: "正在读回机器状态…" }
          : { error: `${what}结果未知` }
        : machine.status === target
          ? {} // settles on this read
          : {
              error:
                machine.status === origin
                  ? `当前仍为“${statusLabel(origin)}”，${what}结果未知`
                  : `${what}结果未知，当前为“${
                      machine.status ? statusLabel(machine.status) : "未知"
                    }”`,
              retry: reread,
              retryLabel: "重新读取",
            };
  return {
    machineId,
    status: machine?.status,
    // Checks run per project binding; without one there is nothing to check.
    checkable:
      !!machine?.bindings.some((b) => b.is_current) && !!client.checkMachine,
    drainable: !!client.setMachineDrain,
    following,
    checkLocked,
    drainLocked,
    againable,
    asking,
    ask: () => {
      if (askable.current) setAsking(true);
    },
    cancelAgain: () => setAsking(false),
    confirmAgain: () => {
      setAsking(false);
      if (askable.current) void store.start(client, true);
    },
    // Buttons are aria-disabled, so a press still arrives: checked on send.
    start: () => {
      if (!checkLocked) void store.start(client);
    },
    drain: (on: boolean) => {
      if (!drainLocked) void store.drain(client, on);
    },
    checkFeedback,
    drainFeedback,
  };
}

function MachineButtons({
  machineId,
  status,
  checkable,
  drainable,
  following,
  checkLocked,
  drainLocked,
  againable,
  ask,
  start,
  drain,
}: ReturnType<typeof useMachineActions>) {
  const drainWaiting = drainLocked || undefined;
  return (
    <>
      {drainable && status === "online" && (
        <Button aria-disabled={drainWaiting} onClick={() => drain(true)}>
          排空
        </Button>
      )}
      {drainable && status === "draining" && (
        <Button aria-disabled={drainWaiting} onClick={() => drain(false)}>
          恢复
        </Button>
      )}
      {checkable &&
        (againable ? (
          <Button
            id={checkButtonId(machineId)}
            aria-haspopup="dialog"
            onClick={ask}
          >
            仍要重新检查
          </Button>
        ) : (
          <Button
            id={checkButtonId(machineId)}
            variant="primary"
            aria-disabled={checkLocked || undefined}
            onClick={start}
          >
            {following ? "检查中…" : "立即检查"}
          </Button>
        ))}
    </>
  );
}
