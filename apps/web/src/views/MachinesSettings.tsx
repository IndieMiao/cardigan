import { useCallback, useState } from "react";
import type {
  CardiganClient,
  MachineBindingView,
  MachineView,
} from "../api.js";
import { Drawer } from "../components/Drawer.js";
import { EmptyState, StatusTag, Time } from "../components/Foundation.js";
import { IdTag } from "../components/IdTag.js";
import { CardDetailLayout } from "../components/layout/CardDetailLayout.js";
import { DataTableCell } from "../components/layout/DataTableLayout.js";
import {
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
  machineRunning,
  primaryBinding,
} from "../machine-labels.js";
import { useResource } from "../useResource.js";

const platform = (m: MachineView) =>
  [m.os, m.arch].filter(Boolean).join(" / ") || "—";
const running = (m: MachineView) => `${machineRunning(m)} / ${m.run_limit}`;

function MachineStatus({ status }: { status: string | undefined }) {
  return status ? (
    <StatusTag status={status} />
  ) : (
    <StatusTag status="unknown" subdued />
  );
}
function CheckTag({ check }: { check: MachineCheckRow | undefined }) {
  return check ? (
    <StatusTag status={check.status} label={check.label} />
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
  const load = useCallback(
    () => client.machines(projectId),
    [client, projectId],
  );
  const list = useResource(load, revision);
  const [open, setOpen] = useState<MachineView>();
  const { remember } = useDrawerReturnFocus(open !== undefined);
  const machines = list.data?.machines;
  return (
    <SettingsPanel
      id="machines"
      tabIndex={-1}
      title="机器"
      titleId="machines-title"
    >
      <RequestFeedback
        {...list}
        retry={list.reload}
        pendingMessage="正在加载机器…"
      />
      {machines && machines.length === 0 && <EmptyState>没有机器</EmptyState>}
      {machines && machines.length > 0 && (
        <SettingsTable aria-label="机器列表">
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>系统</TableHead>
              <TableHead>最近心跳</TableHead>
              <TableHead>在跑 / 上限</TableHead>
              <TableHead>最近检查</TableHead>
              <TableHead>状态</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {machines.map((machine) => (
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
                <DataTableCell nowrap data-label="在跑 / 上限">
                  {running(machine)}
                </DataTableCell>
                <DataTableCell nowrap data-label="最近检查">
                  <CheckTag check={latestMachineCheck(machine)} />
                </DataTableCell>
                <DataTableCell nowrap data-record="aside">
                  <MachineStatus status={machine.status} />
                </DataTableCell>
              </TableRow>
            ))}
          </TableBody>
        </SettingsTable>
      )}
      {open && (
        <MachineDrawer
          key={open.id}
          client={client}
          projectId={projectId}
          summary={open}
          revision={revision}
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
  onClose,
}: {
  client: CardiganClient;
  projectId: string;
  summary: MachineView;
  revision: number;
  onClose: () => void;
}) {
  const load = useCallback(
    () => client.machine(projectId, summary.id),
    [client, projectId, summary.id],
  );
  const detail = useResource(load, revision);
  const machine = detail.data?.machine;
  return (
    <Drawer
      className={settingsDrawerClassName}
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={machine?.label ?? summary.label}
      description={`机器 ${summary.id} 详情`}
      initialFocus="close"
    >
      <CardDetailLayout
        className="card-page-drawer"
        aria-label={`机器 ${summary.id}`}
      >
        <RequestFeedback
          {...detail}
          retry={detail.reload}
          pendingMessage="正在加载机器…"
        />
        {machine && <MachineFacts machine={machine} />}
      </CardDetailLayout>
    </Drawer>
  );
}

function MachineFacts({ machine }: { machine: MachineView }) {
  const bindings = [...machine.bindings].sort(
    (a, b) => Number(b.is_current) - Number(a.is_current),
  );
  const primary = primaryBinding(machine);
  const capabilities = [...(primary?.capabilities ?? [])]
    .map((c) => ({ ...c, state: capabilityState(c) }))
    .sort(
      (a, b) =>
        CAPABILITY_TAGS[a.state].order - CAPABILITY_TAGS[b.state].order ||
        a.key.localeCompare(b.key),
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
    bindingChecks(b).map((check) => ({ binding: b, check })),
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
          <SettingsFact label="在跑 / 上限">{running(machine)}</SettingsFact>
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
      <SettingsSection
        title={
          primary && !primary.is_current
            ? `已验证能力（${primary.project_name}）`
            : "已验证能力"
        }
      >
        {capabilities.length === 0 ? (
          <p>没有能力记录</p>
        ) : (
          <SettingsTable aria-label="已验证能力">
            <TableHeader>
              <TableRow>
                <TableHead>能力</TableHead>
                <TableHead>版本</TableHead>
                <TableHead>验证时间</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {capabilities.map((c) => {
                const tag = CAPABILITY_TAGS[c.state];
                return (
                  <TableRow key={c.key}>
                    <DataTableCell nowrap data-record="lead">
                      <code>{c.key}</code>
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
                <TableRow key={run.id}>
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
                    <Time value={check.checked_at} />
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
