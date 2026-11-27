import { useCallback, useMemo, useRef, useState } from "react";
import {
  type CardiganClient,
  describeError,
  type MachineDeviceView,
  type MachineView,
} from "../api.js";
import { StatusTag } from "../components/Foundation.js";
import { IdTag } from "../components/IdTag.js";
import { DataTableCell } from "../components/layout/DataTableLayout.js";
import {
  SettingsConfirmDialog,
  SettingsDialogFields,
  SettingsRowActions,
  SettingsSection,
  SettingsTable,
} from "../components/layout/SettingsLayout.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { Button } from "../components/ui/button.js";
import { Checkbox } from "../components/ui/checkbox.js";
import {
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.js";
import { routeHash } from "../route.js";
import { useResource } from "../useResource.js";

type Request =
  | { request: "enable" | "assign"; projects?: readonly string[] }
  | { request: "disable" };

const deviceKey = (d: Pick<MachineDeviceView, "machine" | "type" | "id">) =>
  `${d.machine}\u0000${d.type}\u0000${d.id}`;
const deviceName = (d: MachineDeviceView) =>
  d.model ? `${d.model}（${d.id}）` : d.id;

const REGISTRATION: Record<
  Exclude<MachineDeviceView["status"], "enabled">,
  { status: string; label: string }
> = {
  pending: { status: "todo", label: "待启用" },
  initializing: { status: "provisioning", label: "初始化中" },
  failed: { status: "failed", label: "初始化失败" },
  disabled: { status: "inactive", label: "已停用" },
};
const CONNECTION: Record<
  NonNullable<MachineDeviceView["state"]>,
  { status: string; label: string }
> = {
  available: { status: "online", label: "可用" },
  // Listed as held by a Run: connected; the holder is in its own column.
  in_use: { status: "online", label: "可用" },
  unauthorized: { status: "blocked", label: "未授权" },
  offline: { status: "offline", label: "离线" },
  missing: { status: "offline", label: "离线" },
  unavailable: { status: "degraded", label: "不可用" },
};

/**
 * An enabled device shows what this project's latest machine check saw;
 * one not (yet) enabled shows where its enabling stands.
 */
export function deviceStatus(d: MachineDeviceView) {
  if (d.status !== "enabled") return REGISTRATION[d.status];
  return d.state
    ? CONNECTION[d.state]
    : { status: "unknown", label: "状态未知", subdued: true };
}

const ACTION_LABEL: Record<Request["request"], string> = {
  enable: "启用",
  disable: "停用",
  assign: "修改项目",
};

/**
 * C-818: the external test devices of every machine this project registers,
 * one table per machine: model, id, status, the Run holding it and the
 * projects it is given to. The owner's session enables, disables and
 * reassigns a device with one click; each request is sent at once and the
 * row then shows the device record the server returned (never what was
 * asked for). A failure stays on that device with a retry.
 */
export function MachineDevices({
  client,
  projectId,
  machines,
  canEdit,
  revision = 0,
}: {
  client: CardiganClient;
  projectId: string;
  machines: readonly MachineView[];
  canEdit: boolean;
  revision?: number;
}) {
  const bound = useMemo(
    () => machines.filter((m) => m.bindings.some((b) => b.is_current)),
    [machines],
  );
  const ids = bound.map((m) => m.id).join("\u0000");
  // Each read and each write gets a tick: a row the server returned after a
  // write is shown until a list read started after that write arrives.
  const ticks = useRef(0);
  const readable = !!client.machineDevices;
  const load = useMemo(
    () => async () => {
      const started = ++ticks.current;
      const machineIds = ids ? ids.split("\u0000") : [];
      const reads = await Promise.all(
        machineIds.map(
          async (m) => (await client.machineDevices?.(projectId, m))?.devices,
        ),
      );
      return { started, devices: reads.flatMap((d) => d ?? []) };
    },
    [client, projectId, ids],
  );
  const read = useResource(load, revision, readable);
  const [written, setWritten] = useState<
    ReadonlyMap<string, { at: number; device: MachineDeviceView }>
  >(new Map());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<
    ReadonlyMap<string, { error: string; retry: () => void }>
  >(new Map());
  const [choosing, setChoosing] = useState<{
    device: MachineDeviceView;
    request: "enable" | "assign";
    projects: readonly string[];
  }>();

  const send = useCallback(
    async (device: MachineDeviceView, body: Request) => {
      const key = deviceKey(device);
      if (!client.requestMachineDevice) return;
      setBusy((current) => new Set(current).add(key));
      const retry = () => void send(device, body);
      try {
        const result = await client.requestMachineDevice(
          projectId,
          device.machine,
          device.type,
          device.id,
          body,
        );
        const at = ++ticks.current;
        setWritten((current) =>
          new Map(current).set(key, { at, device: result.device }),
        );
        setFailed((current) => {
          const next = new Map(current);
          next.delete(key);
          return next;
        });
      } catch (error) {
        setFailed((current) =>
          new Map(current).set(key, {
            error: `未能${ACTION_LABEL[body.request]}${deviceName(device)}：${describeError(error)}`,
            retry,
          }),
        );
      } finally {
        setBusy((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [client, projectId],
  );

  if (!readable) return null;
  const data = read.data;
  const rows = data?.devices.map((d) => {
    const w = written.get(deviceKey(d));
    return w && w.at > data.started ? w.device : d;
  });
  const writable = canEdit && !!client.requestMachineDevice;

  const enable = (device: MachineDeviceView) => {
    if (device.projects.length) return void send(device, { request: "enable" });
    if (device.choices.length === 1)
      return void send(device, {
        request: "enable",
        projects: device.choices,
      });
    setChoosing({ device, request: "enable", projects: [] });
  };

  return (
    <>
      <RequestFeedback
        {...read}
        retry={read.reload}
        pendingMessage="正在加载设备…"
      />
      {rows && bound.length > 0 && rows.length === 0 && (
        <SettingsSection title="设备">
          <p>没有设备</p>
        </SettingsSection>
      )}
      {rows &&
        bound.map((machine) => {
          const devices = rows.filter((d) => d.machine === machine.id);
          if (!devices.length) return null;
          return (
            <SettingsSection key={machine.id} title={`${machine.label} 的设备`}>
              <SettingsTable aria-label={`${machine.label} 的设备`}>
                <TableHeader>
                  <TableRow>
                    <TableHead>型号</TableHead>
                    <TableHead>编号</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>占用</TableHead>
                    <TableHead>项目</TableHead>
                    {writable && <TableHead>操作</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {devices.map((device) => {
                    const key = deviceKey(device);
                    const status = deviceStatus(device);
                    const pending = busy.has(key);
                    const failure = failed.get(key);
                    const on =
                      device.status === "enabled" ||
                      device.status === "initializing";
                    return (
                      <TableRow key={key} aria-label={deviceName(device)}>
                        <DataTableCell nowrap data-record="lead">
                          {device.model ?? "—"}
                        </DataTableCell>
                        <DataTableCell nowrap data-label="编号">
                          <code>{device.id}</code>
                        </DataTableCell>
                        <DataTableCell nowrap data-label="状态">
                          <StatusTag
                            status={status.status}
                            label={status.label}
                            subdued={"subdued" in status}
                          />
                        </DataTableCell>
                        <DataTableCell nowrap data-label="占用">
                          <Holder projectId={projectId} device={device} />
                        </DataTableCell>
                        <DataTableCell data-label="项目">
                          {device.projects.join("、") || "—"}
                        </DataTableCell>
                        {writable && (
                          <DataTableCell nowrap data-record="aside">
                            <SettingsRowActions>
                              <Button
                                aria-label={`${on ? "停用" : "启用"}${deviceName(device)}`}
                                aria-disabled={pending || undefined}
                                onClick={() => {
                                  if (pending) return;
                                  if (on)
                                    void send(device, { request: "disable" });
                                  else enable(device);
                                }}
                              >
                                {on ? "停用" : "启用"}
                              </Button>
                              {device.choices.length > 1 && (
                                <Button
                                  aria-label={`修改${deviceName(device)}的项目`}
                                  aria-haspopup="dialog"
                                  aria-disabled={pending || undefined}
                                  onClick={() => {
                                    if (pending) return;
                                    setChoosing({
                                      device,
                                      request: "assign",
                                      projects: device.projects,
                                    });
                                  }}
                                >
                                  改项目
                                </Button>
                              )}
                            </SettingsRowActions>
                            <RequestFeedback
                              interactive
                              pending={pending}
                              pendingMessage={`正在提交${deviceName(device)}…`}
                              error={failure?.error}
                              retry={failure?.retry}
                            />
                          </DataTableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </SettingsTable>
            </SettingsSection>
          );
        })}
      <SettingsConfirmDialog
        open={!!choosing}
        title={
          choosing?.request === "enable" ? "给哪些项目用？" : "修改设备的项目"
        }
        description={choosing ? deviceName(choosing.device) : ""}
        cancelLabel="取消"
        confirmLabel={choosing?.request === "enable" ? "启用" : "保存项目"}
        confirmDisabled={!choosing?.projects.length}
        onCancel={() => setChoosing(undefined)}
        onConfirm={() => {
          if (!choosing?.projects.length) return;
          setChoosing(undefined);
          void send(choosing.device, {
            request: choosing.request,
            projects: choosing.projects,
          });
        }}
      >
        {choosing && (
          <SettingsDialogFields>
            <fieldset>
              <legend>项目</legend>
              <div data-choices="">
                {choosing.device.choices.map((p) => (
                  <label key={p}>
                    <Checkbox
                      checked={choosing.projects.includes(p)}
                      onCheckedChange={(checked) =>
                        setChoosing({
                          ...choosing,
                          projects: checked
                            ? [...choosing.projects, p]
                            : choosing.projects.filter((x) => x !== p),
                        })
                      }
                    />
                    {p}
                  </label>
                ))}
              </div>
            </fieldset>
          </SettingsDialogFields>
        )}
      </SettingsConfirmDialog>
    </>
  );
}

/** The Run holding the device: this project's card and Run, or the project. */
function Holder({
  projectId,
  device,
}: {
  projectId: string;
  device: MachineDeviceView;
}) {
  const holder = device.holder;
  if (!holder) return <>—</>;
  if (holder.project !== projectId) return <>{holder.project}</>;
  return (
    <>
      {holder.card_id && (
        <>
          <IdTag
            id={holder.card_id}
            label=""
            href={routeHash({
              kind: "card",
              projectId,
              cardId: holder.card_id,
            })}
          />{" "}
        </>
      )}
      <IdTag id={holder.run_id} label="" />
    </>
  );
}
