import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  ApiError,
  type CardiganClient,
  describeError,
  describeWriteError,
  type WorkerWizardAction,
  type WorkerWizardCommandKey,
  type WorkerWizardInput,
  type WorkerWizardStep,
  type WorkerWizardView,
} from "../api.js";
import { Drawer } from "../components/Drawer.js";
import { StatusTag, Time } from "../components/Foundation.js";
import { CardDetailLayout } from "../components/layout/CardDetailLayout.js";
import { DataTableCell } from "../components/layout/DataTableLayout.js";
import {
  SettingsDialogActions,
  SettingsDialogFields,
  SettingsDiff,
  SettingsDrawerFeedback,
  SettingsFact,
  SettingsFacts,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsTable,
  SettingsText,
  SettingsWarning,
  settingsDrawerClassName,
} from "../components/layout/SettingsLayout.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { Button } from "../components/ui/button.js";
import { Checkbox } from "../components/ui/checkbox.js";
import { Input } from "../components/ui/input.js";
import { SelectControl } from "../components/ui/select-control.js";
import {
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.js";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group.js";
import { checkStepLabel, wizardStepLabel } from "../machine-labels.js";
import { useNotice } from "./useSettingWrite.js";

/**
 * C-511: the add-worker wizard (C-510 backend). The server keeps the session
 * for 24 hours in its own process; the browser only remembers its id per
 * project, so leaving and coming back continues from the current step.
 */
const storageKey = (projectId: string) => `cardigan.worker-wizard.${projectId}`;
export function storedWizard(projectId: string): string | undefined {
  try {
    return window.localStorage.getItem(storageKey(projectId)) ?? undefined;
  } catch {
    return undefined;
  }
}
function rememberWizard(projectId: string, id: string | undefined) {
  try {
    if (id) window.localStorage.setItem(storageKey(projectId), id);
    else window.localStorage.removeItem(storageKey(projectId));
  } catch {
    // Without storage the wizard still works; only resuming is lost.
  }
}

/** How the wizard drawer was closed, for the panel's notice. */
export type WizardExit = "kept" | "cancelled" | "done" | "empty";

const PHASES: Readonly<
  Record<WorkerWizardView["phase"], { status: string; label: string }>
> = {
  preview: { status: "waiting", label: "待确认配置" },
  ready: { status: "not_run", label: "待检查" },
  running: { status: "running", label: "检查中" },
  failed: { status: "failed", label: "未通过" },
  passed: { status: "passed", label: "已通过" },
  enabled: { status: "passed", label: "已接入" },
};
const STEP_STATES: Readonly<
  Record<
    WorkerWizardStep["state"],
    { status: string; label: string; subdued: boolean }
  >
> = {
  pending: { status: "not_run", label: "待执行", subdued: true },
  running: { status: "running", label: "进行中", subdued: false },
  passed: { status: "passed", label: "通过", subdued: false },
  blocked: { status: "failed", label: "受阻", subdued: false },
};
const CHANGES: Readonly<Record<string, string>> = {
  add: "新增",
  remove: "删除",
  change: "修改",
  reset: "重置",
};
const COMMAND_KEYS: readonly WorkerWizardCommandKey[] = [
  "account",
  "directories",
  "tools",
  "helpers",
];

/** Known refusals in words; the fix is part of the message. */
const WIZARD_ERRORS: Readonly<Record<string, string>> = {
  worker_form_invalid:
    "填写有误：专用账号须以 cg_ 开头，UID/GID 为不小于 501 的整数。",
  worker_identity_invalid:
    "机器编号无效：只能用字母、数字、点、下划线和连字符，且不能是 local。",
  worker_identity_conflict:
    "这个机器编号已按不同的系统或架构登记，请换一个编号或核对已有登记。",
  worker_mcp_url_invalid: "MCP 地址无效，请填写控制主机的 MCP 地址。",
  worker_mcp_url_conflict: "MCP 地址与这台机器已有的项目绑定不一致，请核对。",
  worker_busy: "这台机器正在检查，请等它结束后再试。",
  worker_preview_stale: "预览已过期或状态已改变，已重新读取，请核对后再确认。",
  worker_config_conflict:
    "主机上已有与此绑定冲突的配置，请在控制主机上核对后重新预览。",
  worker_config_changed: "接入配置在确认后被改动，请重新预览并确认。",
  worker_private_file_invalid:
    "主机私有配置文件的权限或归属不符，请在控制主机上核对后重试。",
};
function wizardError(error: unknown): string {
  if (error instanceof ApiError) {
    const known = WIZARD_ERRORS[error.code];
    if (known) return known;
    if (error.status === 404)
      return "向导已失效（服务重启或超过 24 小时），请重新填写。";
    if (error.status === 503) return "向导服务不可用，请稍后再试。";
  }
  return describeWriteError(error);
}

interface Form {
  machine_id: string;
  label: string;
  os: "linux" | "macos";
  arch: "x64" | "arm64";
  host: string;
  port: string;
  account: string;
  uid: string;
  gid: string;
  mcp_url: string;
}
const EMPTY_FORM: Form = {
  machine_id: "",
  label: "",
  os: "linux",
  arch: "x64",
  host: "",
  port: "22",
  account: "",
  uid: "",
  gid: "",
  mcp_url: "",
};
const integer = (value: string) =>
  /^\d+$/u.test(value.trim()) ? Number(value.trim()) : Number.NaN;
/** The same rules the server applies, so most mistakes show before sending. */
function validate(form: Form): WorkerWizardInput | string {
  const machine = form.machine_id.trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(machine) ||
    machine === "local"
  )
    return WIZARD_ERRORS.worker_identity_invalid as string;
  const label = form.label.trim();
  if (!label || label.length > 80) return "请填写名称（不超过 80 个字）。";
  if (!form.host.trim()) return "请填写主机地址。";
  const port = integer(form.port);
  if (!(port >= 1 && port <= 65535)) return "SSH 端口须为 1～65535 的整数。";
  if (!/^cg_[a-z0-9_]{1,26}$/u.test(form.account.trim()))
    return "专用账号须以 cg_ 开头，只含小写字母、数字和下划线。";
  const uid = integer(form.uid),
    gid = integer(form.gid);
  if (![uid, gid].every((v) => v >= 501 && v <= 2147483647))
    return "UID 和 GID 须为不小于 501 的整数。";
  if (!form.mcp_url.trim()) return "请填写 MCP 地址。";
  return {
    machine_id: machine,
    label,
    os: form.os,
    arch: form.os === "macos" ? "arm64" : form.arch,
    host: form.host.trim(),
    port,
    account: form.account.trim(),
    uid,
    gid,
    mcp_url: form.mcp_url.trim(),
  };
}

const elapsed = (step: WorkerWizardStep) =>
  step.state === "passed" || step.state === "blocked"
    ? `${(step.elapsed_ms / 1000).toFixed(1)} 秒`
    : "—";

export function WorkerWizardDrawer({
  client,
  projectId,
  onClose,
  onChanged,
  pollMs = 1000,
}: {
  client: CardiganClient;
  projectId: string;
  onClose: (exit: WizardExit) => void;
  /** The host's machine registry may have changed (registered, enabled). */
  onChanged: () => void;
  pollMs?: number;
}) {
  const [wizard, setWizard] = useState<WorkerWizardView>();
  const [loading, setLoading] = useState(() => !!storedWizard(projectId));
  const [busy, setBusy] = useState<string>();
  const sending = useRef(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState<(() => void) | undefined>();
  const [message, setMessage] = useNotice();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [launch, setLaunch] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  /** A reply for the current session; a gone session starts over. */
  const shownPhase = useRef<WorkerWizardView["phase"]>(undefined);
  const show = useCallback(
    (next: WorkerWizardView | undefined) => {
      if (!alive.current) return;
      // A check that ended may have registered the machine.
      if (shownPhase.current === "running" && next?.phase !== "running")
        changed.current();
      shownPhase.current = next?.phase;
      setWizard(next);
      if (!next) rememberWizard(projectId, undefined);
    },
    [projectId],
  );
  const read = useCallback(
    async (id: string) => {
      const get = client.workerWizard;
      if (!get) return;
      try {
        const { wizard: next } = await get.call(client, projectId, id);
        show(next);
        setRetry(undefined);
        return true;
      } catch (cause) {
        if (!alive.current) return false;
        if (cause instanceof ApiError && cause.status === 404) {
          show(undefined);
          setError(wizardError(cause));
          setRetry(undefined);
        } else {
          setError(`未能读取向导进度：${describeError(cause)}`);
          setRetry(() => () => {
            setError("");
            void read(id);
          });
        }
        return false;
      } finally {
        if (alive.current) setLoading(false);
      }
    },
    [client, projectId, show],
  );
  // Continue a session left earlier (also after reloading the page).
  useEffect(() => {
    const id = storedWizard(projectId);
    if (id) void read(id);
  }, [projectId, read]);
  // A running check is polled until it ends; leaving stops the polling only.
  const runningId = wizard?.phase === "running" ? wizard.id : undefined;
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick schedules the next read.
  useEffect(() => {
    if (!runningId) return;
    const timer = window.setTimeout(async () => {
      if (await read(runningId)) setTick((n) => n + 1);
    }, pollMs);
    return () => window.clearTimeout(timer);
  }, [runningId, read, pollMs, tick]);

  const act = async (
    name: string,
    request: () => Promise<WorkerWizardView | undefined>,
    after?: (next: WorkerWizardView | undefined) => void,
  ) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(name);
    setError("");
    setRetry(undefined);
    try {
      const next = await request();
      if (!alive.current) return;
      show(next);
      after?.(next);
    } catch (cause) {
      if (!alive.current) return;
      setError(wizardError(cause));
      // The server is the record: show where the session really is.
      if (wizard) await read(wizard.id);
    } finally {
      sending.current = false;
      if (alive.current) setBusy(undefined);
    }
  };
  const step = (action: WorkerWizardAction) => async () => {
    const run = client.workerWizardAction;
    if (!run || !wizard) return undefined;
    const reply = await run.call(client, projectId, wizard.id, action);
    return "wizard" in reply ? reply.wizard : undefined;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = validate(form);
    if (typeof input === "string") {
      setError(input);
      setRetry(undefined);
      return;
    }
    const create = client.createWorkerWizard;
    if (!create) return;
    void act(
      "preview",
      async () => (await create.call(client, projectId, input)).wizard,
      (next) => {
        if (!next) return;
        rememberWizard(projectId, next.id);
        setEditing(false);
      },
    );
  };
  const cancel = () => {
    if (!wizard) return onClose("empty");
    if (wizard.phase === "running") return;
    void act("cancel", step({ kind: "cancel" }), () => {
      rememberWizard(projectId, undefined);
      onClose("cancelled");
    });
  };
  const finish = () => {
    if (sending.current) return;
    rememberWizard(projectId, undefined);
    onClose("done");
  };
  const close = () => {
    if (sending.current) return;
    onClose(wizard && wizard.phase !== "enabled" ? "kept" : "empty");
  };
  const copy = async (key: WorkerWizardCommandKey) => {
    const text = wizard?.commands[key];
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      if (alive.current) setMessage(`已复制“${checkStepLabel(key)}”命令`);
    } catch {
      if (alive.current)
        setError("无法写入剪贴板，请在命令框中选中文字后手动复制。");
    }
  };

  const phase = wizard?.phase;
  const showForm = !loading && (!wizard || editing);
  const waiting = busy !== undefined || undefined;
  const run = (label: string, variant?: "primary") => (
    <Button
      variant={variant}
      aria-disabled={waiting}
      onClick={() => void act("run", step({ kind: "run" }))}
    >
      {label}
    </Button>
  );
  const done = (
    <Button variant="primary" aria-disabled={waiting} onClick={finish}>
      完成
    </Button>
  );
  const giveUp = (
    <Button aria-disabled={waiting} onClick={cancel}>
      放弃
    </Button>
  );
  // Header actions by phase; the primary one is last, next to close.
  const actions =
    !wizard || showForm ? undefined : phase === "preview" ? (
      giveUp
    ) : phase === "ready" ? (
      <>
        {giveUp}
        {run("开始检查", "primary")}
      </>
    ) : phase === "failed" ? (
      <>
        {giveUp}
        {run("继续检查", "primary")}
      </>
    ) : phase === "running" ? (
      <Button variant="primary" aria-disabled>
        检查中…
      </Button>
    ) : phase === "passed" ? (
      <>
        {run("复查")}
        {done}
      </>
    ) : (
      done
    );
  return (
    <Drawer
      className={settingsDrawerClassName}
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={wizard ? `添加 worker：${wizard.label}` : "添加 worker"}
      description="新建 worker 向导"
      initialFocus="close"
      actions={actions}
    >
      <CardDetailLayout className="card-page-drawer" aria-label="添加 worker">
        <SettingsDrawerFeedback>
          <RequestFeedback
            interactive
            pending={loading || busy !== undefined}
            pendingMessage={
              loading
                ? "正在读取向导…"
                : busy === "run"
                  ? "正在开始检查…"
                  : busy === "cancel"
                    ? "正在放弃…"
                    : "正在提交…"
            }
            error={error}
            retry={retry}
            message={message}
          />
          {wizard?.phase === "running" && (
            <RequestFeedback
              interactive
              pending
              pendingMessage={`正在检查：${checkStepLabel(
                wizard.steps.find((s) => s.state === "running")?.step ??
                  "queued",
              )}…`}
            />
          )}
        </SettingsDrawerFeedback>
        {showForm && (
          <WizardForm
            form={form}
            setForm={(next) => {
              setForm(next);
              setError("");
            }}
            busy={busy !== undefined}
            onSubmit={submit}
            onCancel={() => (wizard ? setEditing(false) : onClose("empty"))}
            back={!!wizard}
          />
        )}
        {wizard && !showForm && (
          <>
            <SettingsSection title="概况">
              <SettingsFacts>
                <SettingsFact label="机器编号">
                  <code>{wizard.machine_id}</code>
                </SettingsFact>
                <SettingsFact label="系统与架构">
                  {[wizard.os, wizard.arch].join(" / ")}
                </SettingsFact>
                <SettingsFact label="进度">
                  <StatusTag
                    status={PHASES[wizard.phase].status}
                    label={PHASES[wizard.phase].label}
                  />
                </SettingsFact>
                {wizard.error && (
                  <SettingsFact label="中断原因">
                    <code>{wizard.error}</code>
                  </SettingsFact>
                )}
              </SettingsFacts>
            </SettingsSection>
            {wizard.phase === "preview" && wizard.preview ? (
              <PreviewConfirm
                wizard={wizard}
                preview={wizard.preview}
                busy={busy !== undefined}
                onBack={() => {
                  if (!form.machine_id)
                    setForm({
                      ...EMPTY_FORM,
                      machine_id: wizard.machine_id,
                      label: wizard.label,
                      os: wizard.os === "linux" ? "linux" : "macos",
                      arch: wizard.arch === "x64" ? "x64" : "arm64",
                    });
                  setEditing(true);
                }}
                onConfirm={(preview_id) =>
                  void act("confirm", step({ kind: "confirm", preview_id }))
                }
              />
            ) : (
              <>
                <Steps wizard={wizard} onCopy={(key) => void copy(key)} />
                <Commands wizard={wizard} onCopy={(key) => void copy(key)} />
                {(wizard.phase === "passed" || wizard.phase === "enabled") && (
                  <RemoteLaunch
                    wizard={wizard}
                    busy={busy !== undefined}
                    confirmed={launch}
                    onConfirmed={setLaunch}
                    onPreview={() =>
                      void act("launch", step({ kind: "launch-preview" }), () =>
                        setLaunch(false),
                      )
                    }
                    onEnable={(preview_id) =>
                      void act(
                        "enable",
                        step({
                          kind: "enable",
                          preview_id,
                          allow_remote_launch: true,
                        }),
                        (next) => {
                          if (next?.phase !== "enabled") return;
                          setMessage("已开启远程派发");
                          onChanged();
                        },
                      )
                    }
                  />
                )}
              </>
            )}
          </>
        )}
      </CardDetailLayout>
    </Drawer>
  );
}

function WizardForm({
  form,
  setForm,
  busy,
  back,
  onSubmit,
  onCancel,
}: {
  form: Form;
  setForm: (form: Form) => void;
  busy: boolean;
  back: boolean;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}) {
  const field = (key: keyof Form) => (event: { target: { value: string } }) =>
    setForm({ ...form, [key]: event.target.value });
  return (
    <form aria-label="worker 接入信息" noValidate onSubmit={onSubmit}>
      <SettingsDialogFields>
        <fieldset disabled={busy}>
          <label>
            机器编号
            <Input
              value={form.machine_id}
              autoComplete="off"
              onChange={field("machine_id")}
            />
          </label>
          <label>
            名称
            <Input value={form.label} onChange={field("label")} />
          </label>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>系统</legend>
          <ToggleGroup
            type="multiple"
            aria-label="系统"
            value={[form.os]}
            onValueChange={(next) => {
              const os = next.at(-1);
              if (os === "linux" || os === "macos")
                setForm({
                  ...form,
                  os,
                  arch: os === "macos" ? "arm64" : form.arch,
                });
            }}
          >
            <ToggleGroupItem value="linux">Linux</ToggleGroupItem>
            <ToggleGroupItem value="macos">macOS</ToggleGroupItem>
          </ToggleGroup>
        </fieldset>
        <fieldset disabled={busy}>
          <label>
            架构
            <SelectControl
              value={form.os === "macos" ? "arm64" : form.arch}
              onValueChange={(arch) => {
                if (arch === "x64" || arch === "arm64")
                  setForm({ ...form, arch });
              }}
            >
              {form.os === "linux" && <option value="x64">x64</option>}
              <option value="arm64">arm64</option>
            </SelectControl>
          </label>
          <label>
            主机地址
            <Input
              value={form.host}
              autoComplete="off"
              onChange={field("host")}
            />
          </label>
          <label>
            SSH 端口
            <Input
              value={form.port}
              inputMode="numeric"
              onChange={field("port")}
            />
          </label>
          <label>
            专用账号
            <Input
              value={form.account}
              autoComplete="off"
              onChange={field("account")}
            />
          </label>
          <label>
            UID
            <Input
              value={form.uid}
              inputMode="numeric"
              onChange={field("uid")}
            />
          </label>
          <label>
            GID
            <Input
              value={form.gid}
              inputMode="numeric"
              onChange={field("gid")}
            />
          </label>
          <label>
            MCP 地址
            <Input
              value={form.mcp_url}
              autoComplete="off"
              onChange={field("mcp_url")}
            />
          </label>
        </fieldset>
      </SettingsDialogFields>
      <SettingsDialogActions>
        <Button onClick={onCancel} disabled={busy}>
          {back ? "返回" : "取消"}
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          预览配置
        </Button>
      </SettingsDialogActions>
    </form>
  );
}

function DiffTable({
  label,
  diff,
}: {
  label: string;
  diff: NonNullable<WorkerWizardView["preview"]>["diff"];
}) {
  const value = (v: string | number | boolean | undefined) =>
    v === undefined ? "—" : String(v);
  return (
    <SettingsTable aria-label={label}>
      <TableHeader>
        <TableRow>
          <TableHead>字段</TableHead>
          <TableHead>原值</TableHead>
          <TableHead>新值</TableHead>
          <TableHead>变化</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {diff.map((d) => (
          <TableRow key={d.field}>
            <DataTableCell data-record="lead">
              <code>{d.field}</code>
            </DataTableCell>
            <DataTableCell data-label="原值">{value(d.before)}</DataTableCell>
            <DataTableCell data-label="新值">{value(d.after)}</DataTableCell>
            <DataTableCell nowrap data-record="aside">
              <SettingsDiff
                op={
                  d.change === "add"
                    ? "add"
                    : d.change === "remove"
                      ? "remove"
                      : undefined
                }
              >
                {CHANGES[d.change] ?? d.change}
              </SettingsDiff>
            </DataTableCell>
          </TableRow>
        ))}
      </TableBody>
    </SettingsTable>
  );
}

/** Nothing is written until the reader confirms this exact preview. */
function PreviewConfirm({
  wizard,
  preview,
  busy,
  onBack,
  onConfirm,
}: {
  wizard: WorkerWizardView;
  preview: NonNullable<WorkerWizardView["preview"]>;
  busy: boolean;
  onBack: () => void;
  onConfirm: (previewId: string) => void;
}) {
  return (
    <SettingsSection title="写入前核对">
      <SettingsFacts>
        <SettingsFact label="文件">
          <code>{preview.file}</code>
        </SettingsFact>
        <SettingsFact label="预览有效至">
          <Time value={preview.expires_at} />
        </SettingsFact>
      </SettingsFacts>
      {preview.diff.length === 0 ? (
        <p>与现有配置相同</p>
      ) : (
        <DiffTable label={`${wizard.label} 配置差异`} diff={preview.diff} />
      )}
      <SettingsDialogActions>
        <Button onClick={onBack} disabled={busy}>
          返回修改
        </Button>
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => onConfirm(preview.preview_id)}
        >
          确认写入配置
        </Button>
      </SettingsDialogActions>
    </SettingsSection>
  );
}

function Steps({
  wizard,
  onCopy,
}: {
  wizard: WorkerWizardView;
  onCopy: (key: WorkerWizardCommandKey) => void;
}) {
  return (
    <SettingsSection title="接入步骤">
      <SettingsTable aria-label="接入步骤">
        <TableHeader>
          <TableRow>
            <TableHead>步骤</TableHead>
            <TableHead>耗时</TableHead>
            <TableHead>原因与修复</TableHead>
            <TableHead>状态</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {wizard.steps.map((s) => {
            const state = STEP_STATES[s.state];
            const command =
              s.state === "blocked"
                ? (s.command_key ??
                  (COMMAND_KEYS as readonly string[]).find((k) => k === s.step))
                : undefined;
            return (
              <TableRow key={s.step}>
                <DataTableCell nowrap data-record="lead">
                  {wizardStepLabel(s.step)}
                </DataTableCell>
                <DataTableCell nowrap data-label="耗时">
                  {elapsed(s)}
                </DataTableCell>
                <DataTableCell data-label="原因与修复">
                  {s.state === "blocked" ? (
                    <>
                      {s.reason && <code>{s.reason}</code>}
                      {s.next && <SettingsText>{s.next}</SettingsText>}
                      {command && (
                        <Button
                          onClick={() =>
                            onCopy(command as WorkerWizardCommandKey)
                          }
                        >
                          复制“{checkStepLabel(command)}”命令
                        </Button>
                      )}
                    </>
                  ) : (
                    "—"
                  )}
                </DataTableCell>
                <DataTableCell nowrap data-record="aside">
                  <StatusTag
                    status={state.status}
                    label={state.label}
                    subdued={state.subdued}
                  />
                </DataTableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </SettingsTable>
    </SettingsSection>
  );
}

/** Admin commands for the target machine: copied and run there by a person. */
function Commands({
  wizard,
  onCopy,
}: {
  wizard: WorkerWizardView;
  onCopy: (key: WorkerWizardCommandKey) => void;
}) {
  return (
    <SettingsSection title="目标机命令">
      <SettingsWarning>{wizard.command_prerequisites}</SettingsWarning>
      <SettingsFacts>
        <SettingsFact label="操作手册">
          <code>{wizard.command_guide}</code>
        </SettingsFact>
      </SettingsFacts>
      <SettingsTable aria-label="目标机命令">
        <TableHeader>
          <TableRow>
            <TableHead>步骤</TableHead>
            <TableHead>命令</TableHead>
            <TableHead>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {COMMAND_KEYS.map((key) => (
            <TableRow key={key}>
              <DataTableCell nowrap data-record="lead">
                {wizardStepLabel(key)}
              </DataTableCell>
              <DataTableCell data-label="命令">
                <SettingsText>{wizard.commands[key]}</SettingsText>
              </DataTableCell>
              <DataTableCell nowrap data-record="aside">
                <Button
                  aria-label={`复制“${checkStepLabel(key)}”命令`}
                  onClick={() => onCopy(key)}
                >
                  复制
                </Button>
              </DataTableCell>
            </TableRow>
          ))}
        </TableBody>
      </SettingsTable>
    </SettingsSection>
  );
}

/**
 * Remote launch stays off unless the reader previews the change and confirms
 * it separately; the server repeats every check before turning it on.
 */
function RemoteLaunch({
  wizard,
  busy,
  confirmed,
  onConfirmed,
  onPreview,
  onEnable,
}: {
  wizard: WorkerWizardView;
  busy: boolean;
  confirmed: boolean;
  onConfirmed: (value: boolean) => void;
  onPreview: () => void;
  onEnable: (previewId: string) => void;
}) {
  const id = useId();
  const enabled = wizard.phase === "enabled";
  const preview = enabled ? undefined : wizard.preview;
  return (
    <>
      <SettingsGroup title="需谨慎" tone="caution">
        <SettingsRow
          label="远程派发"
          help="开启后，这台机器可以接收本项目派发的任务。只有当前所有者可以开启。"
          status={
            <StatusTag
              status={enabled ? "passed" : "not_run"}
              label={enabled ? "已开启" : "未开启"}
              subdued={!enabled}
            />
          }
        >
          {!enabled && !preview && (
            <Button disabled={busy} onClick={onPreview}>
              预览开启
            </Button>
          )}
        </SettingsRow>
        {preview && (
          <SettingsRow label="我确认开启远程派发" htmlFor={id}>
            <Checkbox
              id={id}
              checked={confirmed}
              disabled={busy}
              onCheckedChange={(checked) => onConfirmed(checked === true)}
            />
            <Button
              variant="primary"
              disabled={busy || !confirmed}
              onClick={() => onEnable(preview.preview_id)}
            >
              开启远程派发
            </Button>
          </SettingsRow>
        )}
      </SettingsGroup>
      {preview && (
        <SettingsSection title="派发配置差异">
          <SettingsFacts>
            <SettingsFact label="文件">
              <code>{preview.file}</code>
            </SettingsFact>
            <SettingsFact label="预览有效至">
              <Time value={preview.expires_at} />
            </SettingsFact>
          </SettingsFacts>
          <DiffTable label="派发配置差异" diff={preview.diff} />
        </SettingsSection>
      )}
    </>
  );
}
