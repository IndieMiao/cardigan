import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CardiganClient, ExecutionAssignment, RunView } from "../api.js";
import { Drawer } from "../components/Drawer.js";
import {
  AssignmentCard,
  AssignmentRow,
  EmployeeLanes,
  GroupHeading,
  GroupLabel,
  labelledStandingRoles,
  MachinesContext,
  type RowProps,
  unfinished,
  useNarrow,
} from "../components/ExecutionContent.js";
import { ExecutionDetail } from "../components/ExecutionDetail.js";
import {
  ExecutionDiagnosticsAlert,
  ExecutionDiagnosticsStatus,
  useExecutionDiagnostics,
} from "../components/ExecutionDiagnostics.js";
import { ExecutionToolbar } from "../components/ExecutionToolbar.js";
import { EmptyState } from "../components/Foundation.js";
import { GroupedTableBody } from "../components/GroupedTableBody.js";
import { cardDetailDrawerClassName } from "../components/layout/CardDetailLayout.js";
import { DataTableLayout } from "../components/layout/DataTableLayout.js";
import { PageHeader } from "../components/layout/PageHeader.js";
import { MachineDetail } from "../components/MachineDetail.js";
import { MachineSummary } from "../components/MachineSummary.js";
import { Feedback } from "../components/Operations.js";
import {
  DEFAULT_REFRESH_INTERVAL,
  REFRESH_INTERVALS,
} from "../components/RefreshGroup.js";
import { TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import {
  type ExecutionDisplay,
  type ExecutionGroup,
  groupExecution,
  readExecutionDisplay,
  writeExecutionDisplay,
} from "../execution-display.js";
import { assignmentMachine, machineLabel } from "../execution-machine.js";
import {
  assignmentActivity,
  type ExecutionSort,
  readExecutionSort,
  sortByActivity,
  sortByState,
  sortCapacityWaits,
  writeExecutionSort,
} from "../execution-sort.js";
import { useRouteFilters } from "../route.js";
import { useResource } from "../useResource.js";

export {
  contextReading,
  contextUsage,
  RunLine,
  runConfig,
  runHarness,
  runModelEffort,
  standingLabel,
} from "../components/ExecutionContent.js";

const working = (a: ExecutionAssignment) =>
  a.status === "active" &&
  (a.external ||
    a.queue_ahead !== undefined ||
    (a.runtime_ref !== null && !["lost", "unknown"].includes(a.runtime_state)));
const lost = (a: ExecutionAssignment) =>
  !a.external && ["lost", "unknown"].includes(a.runtime_state);
const viewLabel: Readonly<Record<string, string>> = {
  working: "工作中",
  all: "全部",
  released: "已释放",
  lost: "失联",
};
function matchesView(a: ExecutionAssignment, view: string): boolean {
  if (view === "all") return true;
  if (view === "released") return a.status === "released";
  if (view === "lost") return lost(a);
  return working(a);
}

export function ExecutionPage({
  client,
  projectId,
  revision = 0,
  contextRevision = 0,
}: {
  client: CardiganClient;
  projectId: string;
  revision?: number;
  /** C-232: bumps when the host's context samples change (SSE `context`). */
  contextRevision?: number;
}) {
  const [filters, setFilters] = useRouteFilters({
    kind: "execution",
    projectId,
  });
  // C-75: one detail drawer at a time; opening another row replaces it.
  const [selected, setSelected] = useState<string | undefined>(undefined);
  // MC-5: the machine drawer replaces the Assignment drawer and vice versa.
  const [selectedMachine, setSelectedMachine] = useState<string | undefined>(
    undefined,
  );
  const drawerKey =
    selected ??
    (selectedMachine === undefined ? undefined : `machine:${selectedMachine}`);
  const lastTrigger = useRef<HTMLElement | null>(null);
  const previousSelected = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (previousSelected.current !== undefined && drawerKey === undefined)
      lastTrigger.current?.focus();
    previousSelected.current = drawerKey;
  }, [drawerKey]);
  const open = (id: string, trigger: HTMLElement) => {
    lastTrigger.current = trigger;
    setSelectedMachine(undefined);
    setSelected(id);
  };
  const openMachine = (id: string, trigger: HTMLElement) => {
    lastTrigger.current = trigger;
    setSelected(undefined);
    setSelectedMachine(id);
  };
  const view =
    filters.view && Object.hasOwn(viewLabel, filters.view)
      ? filters.view
      : "working";
  const narrow = useNarrow();
  const load = useCallback(
    () => client.execution(projectId),
    [client, projectId],
  );
  // Both counters only grow, so their sum changes whenever either does.
  const { data, pending, error, reload, interactive } = useResource(
    load,
    revision + contextRevision,
  );
  const diagnostics = useExecutionDiagnostics(client, projectId);
  const refreshKey = `cardigan.execution.refresh.${projectId}`;
  const readRefresh = (key: string) => {
    try {
      const stored = localStorage.getItem(key);
      const n = stored === null ? DEFAULT_REFRESH_INTERVAL : Number(stored);
      return REFRESH_INTERVALS.some((value) => value === n)
        ? n
        : DEFAULT_REFRESH_INTERVAL;
    } catch {
      return DEFAULT_REFRESH_INTERVAL;
    }
  };
  const [refreshChoice, setRefreshChoice] = useState(() => ({
    key: refreshKey,
    value: readRefresh(refreshKey),
  }));
  const interval =
    refreshChoice.key === refreshKey
      ? refreshChoice.value
      : readRefresh(refreshKey);
  useEffect(() => {
    if (!interval) return;
    const timer = window.setInterval(() => {
      if (!pending && !document.hidden) reload();
    }, interval);
    return () => window.clearInterval(timer);
  }, [interval, pending, reload]);
  // C-262: role display names, read only when a standing role has no label
  // of its own; a failed read keeps the role_id fallback.
  const [roleNames, setRoleNames] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const needsRoleNames =
    data?.assignments.some(
      (a) => !a.work_item_id && !labelledStandingRoles.has(a.role_id),
    ) ?? false;
  useEffect(() => {
    if (!needsRoleNames) return;
    let live = true;
    client.roles(projectId).then(
      (list) => {
        if (live)
          setRoleNames(
            new Map(list.roles.map((r) => [r.role_id, r.display_name])),
          );
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, projectId, needsRoleNames]);
  const [sort, setSort] = useState<ExecutionSort>(() =>
    readExecutionSort(projectId),
  );
  useEffect(() => setSort(readExecutionSort(projectId)), [projectId]);
  const changeSort = (next: ExecutionSort) => {
    setSort(next);
    writeExecutionSort(projectId, next);
  };
  const [display, setDisplay] = useState<ExecutionDisplay>(() =>
    readExecutionDisplay(projectId),
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const groupsId = useId();
  useEffect(() => {
    setDisplay(readExecutionDisplay(projectId));
    setCollapsed(new Set());
  }, [projectId]);
  const changeDisplay = (next: ExecutionDisplay) => {
    setDisplay(next);
    writeExecutionDisplay(projectId, next);
  };
  const toggleGroup = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Runs arrive newest first, so the first match is the Assignment's latest.
  const latestRuns = new Map<string, RunView>();
  for (const run of data?.runs ?? []) {
    if (!latestRuns.has(run.assignment_id))
      latestRuns.set(run.assignment_id, run);
  }
  const latestRun = (assignmentId: string) => latestRuns.get(assignmentId);
  const assignments = sortByState(
    sortCapacityWaits(
      sortByActivity(
        (data?.assignments ?? []).filter((a) => {
          const machine = assignmentMachine(a, data?.machines ?? []);
          const query = filters.q?.trim().toLocaleLowerCase();
          return (
            matchesView(a, view) &&
            (!filters.machine || machine === filters.machine) &&
            (!query ||
              [
                a.id,
                a.employee?.name,
                a.role_id,
                a.card_id,
                a.work_item_id,
                a.card_title,
                machine,
                machineLabel(machine, data?.machines ?? []),
              ].some((value) => value?.toLocaleLowerCase().includes(query)))
          );
        }),
        (assignment) =>
          assignmentActivity(assignment, latestRun(assignment.id)),
        sort === "asc" ? "asc" : "desc",
      ),
    ),
    (a) => latestRun(a.id),
    sort,
  );
  const groupBy = display.groupBy ?? "employee";
  const groups = groupExecution(assignments, groupBy, data?.machines);
  const groupKey = (a: ExecutionAssignment) =>
    groupBy === "machine"
      ? assignmentMachine(a, data?.machines ?? [])
      : (a.employee?.id ?? "unassigned");
  const groupName = (id: string) =>
    groups.find((g) => g.id === id)?.label ??
    groups.find((g) => g.id === id)?.employee?.name ??
    "未分配员工";
  const machineOptions = [
    ...new Set([
      ...(data?.machines.map((m) => m.id) ?? []),
      ...(data?.assignments.map((a) => assignmentMachine(a, data.machines)) ??
        []),
    ]),
  ]
    .filter(Boolean)
    .map((value) => ({
      value,
      label: machineLabel(value, data?.machines ?? []),
    }));
  const rowProps = (assignment: ExecutionAssignment): RowProps => ({
    a: assignment,
    run: latestRun(assignment.id),
    projectId,
    roleName: roleNames.get(assignment.role_id),
    showEmployee: groupBy === "machine",
    open: assignment.id === selected,
    onOpen: (trigger) => open(assignment.id, trigger),
  });
  const cardList = (
    rows: readonly ExecutionAssignment[],
    lane = false,
    id?: string,
  ) => (
    <ul
      id={id}
      className="execution-cards board-list"
      aria-label="Assignment 列表"
    >
      {rows.map((a) => (
        <AssignmentCard key={a.id} {...rowProps(a)} lane={lane} />
      ))}
    </ul>
  );
  const heading = (group: ExecutionGroup) => (
    <GroupHeading
      group={group}
      collapsed={collapsed.has(group.id)}
      controls={`${groupsId}-${group.id}`}
      onToggle={() => toggleGroup(group.id)}
    />
  );
  const detail = data?.assignments.find((a) => a.id === selected);
  const machineDetail = data?.machines.find((m) => m.id === selectedMachine);
  const detailLive =
    data?.runs.some(
      (run) => run.assignment_id === selected && unfinished(run),
    ) ?? false;
  return (
    <MachinesContext.Provider value={data?.machines ?? []}>
      <section aria-label="执行视图" className="execution-page ui-workspace">
        <PageHeader
          title="执行视图"
          capacityByMachine
          status={<ExecutionDiagnosticsStatus diagnostics={diagnostics} />}
          count={
            data
              ? `${assignments.length} / ${data.assignments.length}`
              : undefined
          }
        />
        <ExecutionToolbar
          filters={{ ...filters, view }}
          onFilterChange={setFilters}
          machineOptions={machineOptions}
          display={display}
          onDisplayChange={(next) => {
            if (next.groupBy !== display.groupBy) setCollapsed(new Set());
            changeDisplay(next);
          }}
          sort={sort}
          onSortChange={changeSort}
          interval={interval}
          onIntervalChange={(next) => {
            setRefreshChoice({ key: refreshKey, value: next });
            try {
              localStorage.setItem(refreshKey, String(next));
            } catch {
              /* Optional preference. */
            }
          }}
          pending={pending}
          onRefresh={reload}
        />
        <Feedback
          pending={pending}
          interactive={interactive}
          error={error}
          retry={reload}
        />
        <ExecutionDiagnosticsAlert diagnostics={diagnostics} onOpen={open} />
        {data &&
          (assignments.length === 0 ? (
            <EmptyState>没有匹配的执行记录</EmptyState>
          ) : display.mode === "cards" ? (
            <EmployeeLanes narrow={narrow} machine={groupBy === "machine"}>
              {groups.map((group) => (
                <section
                  key={group.id}
                  className={`execution-lane ${narrow ? "board-list" : "board-column"}`}
                  aria-label={`${group.label ?? group.employee?.name ?? "未分配员工"}泳道`}
                >
                  <div className="execution-lane-heading board-column-title">
                    <GroupLabel group={group} />
                  </div>
                  <div className={narrow ? undefined : "board-lane-cards"}>
                    {cardList(group.rows, true)}
                  </div>
                </section>
              ))}
            </EmployeeLanes>
          ) : narrow ? (
            display.grouped ? (
              <div className="execution-groups board-list">
                {groups.map((group) => (
                  <section
                    key={group.id}
                    aria-label={`${group.label ?? group.employee?.name ?? "未分配员工"}分组`}
                  >
                    {heading(group)}
                    <div
                      id={`${groupsId}-${group.id}`}
                      hidden={collapsed.has(group.id)}
                    >
                      {cardList(group.rows)}
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              cardList(assignments)
            )
          ) : (
            <DataTableLayout
              className="execution-table"
              scrollClassName="execution-table-scroll"
            >
              <TableHeader>
                <TableRow>
                  <TableHead>员工</TableHead>
                  <TableHead>正在做什么</TableHead>
                  <TableHead
                    sort={
                      sort === "state-asc"
                        ? "ascending"
                        : sort === "state-desc"
                          ? "descending"
                          : "none"
                    }
                    onSort={() =>
                      changeSort(
                        sort === "state-asc" ? "state-desc" : "state-asc",
                      )
                    }
                  >
                    运行状态
                  </TableHead>
                  <TableHead>机器</TableHead>
                  <TableHead>上下文用量</TableHead>
                  <TableHead>运行配置</TableHead>
                  <TableHead
                    sort={
                      sort === "asc"
                        ? "ascending"
                        : sort === "desc"
                          ? "descending"
                          : "none"
                    }
                    onSort={() => changeSort(sort === "desc" ? "asc" : "desc")}
                  >
                    最近活动
                  </TableHead>
                </TableRow>
              </TableHeader>
              <GroupedTableBody
                rows={assignments}
                groupBy={display.grouped ? groupKey : undefined}
                groupName={(group) => groupName(group.id)}
                columns={7}
                headingClassName="execution-group-heading"
                collapsed={collapsed}
                onToggle={toggleGroup}
                renderLabel={(group) => (
                  <GroupLabel
                    group={{
                      ...group,
                      employee: group.rows[0]?.employee,
                      machine: groupBy === "machine",
                      label: groupName(group.id),
                    }}
                  />
                )}
                renderRow={(a) => <AssignmentRow key={a.id} {...rowProps(a)} />}
              />
            </DataTableLayout>
          ))}
        {!!data?.machines.length && (
          <details className="execution-machines">
            <summary>机器（{data.machines.length}）</summary>
            <ul>
              {data.machines.map((machine) => (
                <MachineSummary
                  key={machine.id}
                  machine={machine}
                  open={selectedMachine === machine.id}
                  onOpen={(trigger) => openMachine(machine.id, trigger)}
                />
              ))}
            </ul>
          </details>
        )}
        <Drawer
          open={machineDetail !== undefined}
          onOpenChange={(next) => {
            if (!next) setSelectedMachine(undefined);
          }}
          className={cardDetailDrawerClassName ?? ""}
          title={machineDetail ? `${machineDetail.label} 机器详情` : "机器详情"}
          description={
            machineDetail
              ? `${machineDetail.id} 的状态、健康、容量、资源占用和能力`
              : undefined
          }
        >
          {machineDetail && (
            <MachineDetail key={machineDetail.id} machine={machineDetail} />
          )}
        </Drawer>
        <Drawer
          open={detail !== undefined}
          onOpenChange={(next) => {
            if (!next) setSelected(undefined);
          }}
          className={cardDetailDrawerClassName ?? ""}
          // C-75: rows stay usable while the drawer is open, so another row's
          // Assignment replaces the content; any other outside click closes it.
          modal={false}
          onInteractOutside={(event) => {
            const target = event.target;
            if (
              target instanceof Element &&
              target.closest(".execution-table tbody tr, .execution-card")
            )
              event.preventDefault();
          }}
          title={detail ? `${detail.id} 详情` : "Assignment 详情"}
          description={
            detail
              ? `${detail.id}（${detail.role_id}）的运行环境、命令、Run 历史和 ACK 游标`
              : undefined
          }
        >
          {detail && (
            <ExecutionDetail
              key={detail.id}
              a={detail}
              run={latestRun(detail.id)}
              live={detailLive}
              client={client}
              projectId={projectId}
              revision={revision}
            />
          )}
        </Drawer>
      </section>
    </MachinesContext.Provider>
  );
}
