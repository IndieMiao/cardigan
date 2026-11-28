import {
  type FormEvent,
  type ReactNode,
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
  type WorkerPairingDevice,
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
  SettingsField,
  SettingsFieldHint,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSteps,
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
import { useResource } from "../useResource.js";
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
    else {
      window.localStorage.removeItem(storageKey(projectId));
      window.localStorage.removeItem(commandsKey(projectId));
    }
  } catch {
    // Without storage the wizard still works; only resuming is lost.
  }
}
/**
 * C-565: the session whose checks stopped at a target-machine step, so the
 * step bar shows “目标机命令” as done only when it was really needed (also
 * after coming back); a session that passed straight through skips it.
 */
// A separate prefix: `cardigan.worker-wizard.<project>` is the session key,
// and a project id may itself end in `.commands`, so no suffix scheme is safe.
const commandsKey = (projectId: string) =>
  `cardigan.worker-wizard-commands.${projectId}`;
function commandsNeeded(projectId: string): string | undefined {
  try {
    return window.localStorage.getItem(commandsKey(projectId)) ?? undefined;
  } catch {
    return undefined;
  }
}
function rememberCommandsNeeded(projectId: string, id: string) {
  try {
    window.localStorage.setItem(commandsKey(projectId), id);
  } catch {
    // Only the step bar's “not needed” mark depends on it.
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
  worker_mcp_url_invalid:
    "MCP 地址须为 Tailscale Serve 的 HTTPS 地址：https://<主机>.<tailnet>.ts.net/mcp，可带端口，不带账号、查询参数。",
  worker_mcp_url_conflict: "MCP 地址与这台机器已有的项目绑定不一致，请核对。",
  worker_busy: "这台机器正在检查，请等它结束后再试。",
  worker_preview_stale: "预览已过期或状态已改变，已重新读取，请核对后再确认。",
  worker_config_conflict:
    "主机上已有与此绑定冲突的配置，请在控制主机上核对后重新预览。",
  worker_config_changed: "接入配置在确认后被改动，请重新预览并确认。",
  worker_private_file_invalid:
    "主机私有配置文件的权限或归属不符，请在控制主机上核对后重试。",
  worker_check_changed: "向导状态已改变，已重新读取。",
  // C-707: device pairing.
  pairing_code_invalid:
    "配对码不存在。请核对设备上显示的码；服务重启后旧码作废，请在设备上重新运行命令。",
  pairing_code_expired:
    "配对码已过期（10 分钟内有效），请在设备上重新运行命令获取新码。",
  pairing_code_used:
    "配对码已使用，每个码只能用一次。需要重新接入时，请在设备上重新运行命令。",
  pairing_rate_limited: "配对码错误次数过多，请稍后再试。",
  capacity: "向导会话已满，请先完成或放弃其它添加 worker 的进度。",
};
/** Refusals the server ties to one field: shown beside it, not on top. */
const FIELD_ERRORS: Readonly<Record<string, keyof Form>> = {
  worker_identity_invalid: "machine_id",
  worker_identity_conflict: "machine_id",
  worker_mcp_url_invalid: "mcp_url",
  worker_mcp_url_conflict: "mcp_url",
};
function wizardError(error: unknown): string {
  if (error instanceof ApiError) {
    const known = WIZARD_ERRORS[error.code];
    // C-707: a paired device the host cannot draft keeps its code.
    if (
      typeof error.details === "object" &&
      error.details !== null &&
      "form" in error.details
    )
      return `${known ?? error.message}配对码仍可使用，处理后再确认接入。`;
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
type FieldErrors = Partial<Record<keyof Form, string>>;
/**
 * The same rules the server applies, so most mistakes show before sending,
 * each beside its own field.
 */
function validate(
  form: Form,
): { input: WorkerWizardInput } | { errors: FieldErrors } {
  const errors: FieldErrors = {};
  const machine = form.machine_id.trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(machine) ||
    machine === "local"
  )
    errors.machine_id = WIZARD_ERRORS.worker_identity_invalid as string;
  const label = form.label.trim();
  if (!label || label.length > 80)
    errors.label = "请填写名称（不超过 80 个字）。";
  const host = form.host.trim();
  if (!host) errors.host = "请填写主机地址。";
  else if (host.includes("@"))
    errors.host = "主机地址不带用户名，账号填在“专用账号”里。";
  else if (/^[^:]+:\d+$/u.test(host))
    errors.host = "主机地址不带端口，端口填在“SSH 端口”里。";
  else if (host.includes("/"))
    errors.host = "只填域名或 IP，不带 ssh:// 或路径。";
  else if (
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(host) &&
    !(/^[0-9A-Fa-f:.]+$/u.test(host) && host.split(":").length > 2)
  )
    errors.host =
      "主机地址只能是域名或 IP：字母、数字、点、下划线和连字符，或 IPv6 地址。";
  const port = integer(form.port);
  if (!(port >= 1 && port <= 65535))
    errors.port = "SSH 端口须为 1～65535 的整数。";
  if (!/^cg_[a-z0-9_]{1,26}$/u.test(form.account.trim()))
    errors.account = "专用账号须以 cg_ 开头，只含小写字母、数字和下划线。";
  const uid = integer(form.uid),
    gid = integer(form.gid);
  if (!(uid >= 501 && uid <= 2147483647))
    errors.uid = "UID 须为不小于 501 的整数。";
  if (!(gid >= 501 && gid <= 2147483647))
    errors.gid = "GID 须为不小于 501 的整数。";
  const mcp = form.mcp_url.trim();
  if (!mcp) errors.mcp_url = "请填写 MCP 地址。";
  else if (!TAILNET_MCP.test(mcp))
    errors.mcp_url = WIZARD_ERRORS.worker_mcp_url_invalid as string;
  if (Object.keys(errors).length > 0) return { errors };
  const input: WorkerWizardInput = {
    machine_id: machine,
    label,
    os: form.os,
    arch: form.os === "macos" ? "arm64" : form.arch,
    host,
    port,
    account: form.account.trim(),
    uid,
    gid,
    mcp_url: mcp,
  };
  return { input };
}

/** The account the guides recommend: `cg_` and the project's short name. */
function suggestedAccount(projectId: string): string {
  const name = projectId
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 26);
  return name ? `cg_${name}` : "";
}
/** Where a prefilled MCP address came from, for its hint. */
type McpSource = "workers" | "host" | "page" | undefined;
const TAILNET =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net(?::[0-9]+)?$/u;
/** The remote-worker MCP rule the host applies (`workerMcpConfig`). */
const TAILNET_MCP = new RegExp(`${TAILNET.source.slice(0, -1)}/mcp$`, "u");
/** This Workbench reached through Tailscale Serve: its `/mcp` on the same name. */
function pageMcpUrl(): string | undefined {
  try {
    const origin = window.location.origin;
    return TAILNET.test(origin) ? `${origin}/mcp` : undefined;
  } catch {
    return undefined;
  }
}

/** Steps of the whole wizard, shown from the first screen. */
const WIZARD_STEPS = [
  "填写",
  "预览确认",
  "9 项检查",
  "目标机命令",
  "开启远程派发",
] as const;
/** C-707: a paired device starts with the code instead of the form. */
const PAIRING_STEPS = ["配对确认", ...WIZARD_STEPS.slice(1)] as const;
/**
 * Checks an administrator fixes on the target machine with the commands:
 * SSH too, since a first onboarding logs in as the account not yet created.
 */
const TARGET_STEPS: readonly string[] = ["ssh", ...COMMAND_KEYS];
const isTargetStep = (s: WorkerWizardStep) =>
  s.command_key !== undefined || TARGET_STEPS.includes(s.step);
/**
 * Where the latest check stopped: the first blocked step. Steps run in
 * order, so a later blocked row is left over from an earlier round.
 */
function stopOf(wizard: WorkerWizardView | undefined) {
  return wizard?.phase === "failed"
    ? wizard.steps.find((s) => s.state === "blocked")
    : undefined;
}
/**
 * C-839: a paired device's init script creates the account and layout
 * itself, so the manual target-machine commands are shown only once that
 * script has finished and the checks still stop at a target-machine step.
 */
function commandsShown(wizard: WorkerWizardView): boolean {
  if (!wizard.device_init) return true;
  const stop = stopOf(wizard);
  return (
    wizard.device_init.state === "succeeded" &&
    stop !== undefined &&
    isTargetStep(stop)
  );
}
/** The step bar's index of the checks, shown failed until they pass. */
const CHECKS_STEP = 2;
/** The step bar's index of the target-machine commands (optional). */
const COMMANDS_STEP = 3;
function wizardStep(wizard: WorkerWizardView | undefined): number {
  switch (wizard?.phase) {
    case undefined:
      return 0;
    case "preview":
      return 1;
    case "failed": {
      const stop = stopOf(wizard);
      return stop && isTargetStep(stop) ? COMMANDS_STEP : CHECKS_STEP;
    }
    case "passed":
      return 4;
    case "enabled":
      return WIZARD_STEPS.length;
    default:
      return 2;
  }
}

const elapsed = (step: WorkerWizardStep) =>
  step.state === "passed" || step.state === "blocked"
    ? `${(step.elapsed_ms / 1000).toFixed(1)} 秒`
    : "—";

export function WorkerWizardDrawer({
  client,
  projectId: pageProject,
  pairing: pairingStart,
  onClose,
  onChanged,
  pollMs = 1000,
  devicePollMs = 3000,
  autoRecheckMs = 15_000,
  autoRecheckMax = 20,
}: {
  client: CardiganClient;
  projectId: string;
  /**
   * C-707: start from a device pairing code (prefilled from the QR link)
   * instead of the form. The draft may go to another project; the drawer
   * then continues that project's session.
   */
  pairing?: { readonly code: string | undefined } | undefined;
  onClose: (exit: WizardExit) => void;
  /** The host's machine registry may have changed (registered, enabled). */
  onChanged: () => void;
  pollMs?: number;
  /**
   * C-707: how often a paired draft is read while its device fetches and
   * runs the init script, which starts the recheck by itself.
   */
  devicePollMs?: number;
  /**
   * C-565: after a check stops at a step the target-machine commands fix,
   * check again this often, at most `autoRecheckMax` times for that step;
   * “继续检查” stays available throughout.
   */
  autoRecheckMs?: number;
  autoRecheckMax?: number;
}) {
  /** C-707: the project the session belongs to (a pairing may choose another). */
  const [projectId, setProjectId] = useState(pageProject);
  /** C-707: the pairing form is shown until a code became a draft. */
  const [pairingForm, setPairingForm] = useState(pairingStart !== undefined);
  const [wizard, setWizard] = useState<WorkerWizardView>();
  /** The session this browser holds for the project (also before it loads). */
  const [held, setHeld] = useState(() =>
    pairingStart ? undefined : storedWizard(projectId),
  );
  /**
   * The only session a read may still change. A reply for any other id (a
   * session given up, cancelled or replaced meanwhile) is dropped, so it
   * cannot clear or replace the current one.
   */
  const current = useRef(pairingStart ? undefined : storedWizard(projectId));
  /** Previews the server refused as stale: never sent again. */
  const [rejected, setRejected] = useState<readonly string[]>([]);
  /**
   * How the last read of `held` went. `failed` keeps the last good content
   * (a passing outage); `refused` (401/403) takes it down until a read is
   * allowed again. Neither offers a new form in place of the held session.
   */
  const [readState, setReadState] = useState<
    "ok" | "loading" | "failed" | "refused"
  >(() => (!pairingStart && storedWizard(projectId) ? "loading" : "ok"));
  const [busy, setBusy] = useState<string>();
  const sending = useRef(false);
  /** Steps sent so far: a read begun before the latest one is outdated. */
  const sends = useRef(0);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState<(() => void) | undefined>();
  const [message, setMessage] = useNotice();
  const [editing, setEditing] = useState(false);
  /** What can be inferred is prefilled; the reader's own edits are kept. */
  const [form, setForm] = useState<Form>(() => ({
    ...EMPTY_FORM,
    account: suggestedAccount(projectId),
    mcp_url: pageMcpUrl() ?? "",
  }));
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [mcpSource, setMcpSource] = useState<McpSource>(() =>
    pageMcpUrl() ? "page" : undefined,
  );
  const mcpEdited = useRef(false);
  /** The launch preview the reader ticked; another preview needs its own. */
  const [launchConfirmed, setLaunchConfirmed] = useState<string>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const shownPhase = useRef<WorkerWizardView["phase"]>(undefined);
  /** A reply for the current session; a gone session starts over. */
  const show = useCallback(
    (next: WorkerWizardView | undefined) => {
      if (!alive.current) return;
      // A check that ended may have registered the machine.
      if (shownPhase.current === "running" && next?.phase !== "running")
        changed.current();
      shownPhase.current = next?.phase;
      current.current = next?.id;
      setWizard(next);
      if (next) setHeld(next.id);
      else {
        rememberWizard(projectId, undefined);
        setHeld(undefined);
      }
    },
    [projectId],
  );
  // Every successful read re-arms polling (also after a manual retry).
  const [tick, setTick] = useState(0);
  const read = useCallback(
    /** `keep` leaves an action's error in place (the reread explains it). */
    async (id: string, keep = false): Promise<void> => {
      const get = client.workerWizard;
      if (!get) return;
      // A step sent after this read began answers for itself (C-707).
      const sent = sends.current;
      try {
        const { wizard: next } = await get.call(client, projectId, id);
        if (!alive.current || current.current !== id) return;
        if (sends.current !== sent) {
          setTick((n) => n + 1);
          return;
        }
        setReadState("ok");
        if (!keep) setError("");
        setRetry(undefined);
        show(next);
        setTick((n) => n + 1);
      } catch (cause) {
        if (!alive.current || current.current !== id) return;
        const again = () => () => {
          setError("");
          setRetry(undefined);
          void read(id);
        };
        if (cause instanceof ApiError && cause.status === 404) {
          setReadState("ok");
          show(undefined);
          setError(wizardError(cause));
          setRetry(undefined);
        } else if (
          cause instanceof ApiError &&
          (cause.status === 401 || cause.status === 403)
        ) {
          // Owner-only content the server no longer allows comes down.
          setReadState("refused");
          shownPhase.current = undefined;
          setWizard(undefined);
          setEditing(false);
          setError(`没有权限查看这个向导：${describeError(cause)}`);
          setRetry(again);
        } else {
          setReadState((state) => (state === "refused" ? state : "failed"));
          setError(`未能读取向导进度：${describeError(cause)}`);
          setRetry(again);
        }
      }
    },
    [client, projectId, show],
  );
  // Continue a session left earlier (also after reloading the page).
  const fresh = useRef(pairingStart !== undefined);
  useEffect(() => {
    // C-707: a pairing starts its own session; the one held is left as is.
    if (fresh.current) return;
    const id = storedWizard(projectId);
    if (id) void read(id);
  }, [projectId, read]);
  // The MCP address the host's workers already use, unless the reader typed one.
  useEffect(() => {
    const get = client.workerWizardDefaults;
    if (!get) return;
    let live = true;
    get
      .call(client, projectId)
      .then(({ defaults }) => {
        const url = defaults.mcp_url;
        if (!live || !url || mcpEdited.current) return;
        setForm((f) => ({ ...f, mcp_url: url }));
        setMcpSource(defaults.mcp_source === "host" ? "host" : "workers");
      })
      // Only a suggestion: without it the field keeps its hint.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, projectId]);
  // A running check is polled until it ends; leaving stops the polling only.
  const runningId =
    wizard?.phase === "running" && readState === "ok" ? wizard.id : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick schedules the next read.
  useEffect(() => {
    if (!runningId) return;
    const timer = window.setTimeout(() => void read(runningId), pollMs);
    return () => window.clearTimeout(timer);
  }, [runningId, read, pollMs, tick]);
  // C-707: a paired draft waits for its device's init script, whose report
  // starts the recheck on the server; read it until that happens.
  const deviceId =
    readState === "ok" &&
    (wizard?.phase === "ready" || wizard?.phase === "failed") &&
    wizard.device_init &&
    wizard.device_init.state !== "succeeded"
      ? wizard.id
      : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick schedules the next read.
  useEffect(() => {
    if (!deviceId) return;
    const timer = window.setTimeout(
      () => void read(deviceId, true),
      devicePollMs,
    );
    return () => window.clearTimeout(timer);
  }, [deviceId, read, devicePollMs, tick]);

  const act = async (
    name: string,
    request: () => Promise<WorkerWizardView | undefined>,
    after?: (next: WorkerWizardView | undefined) => void,
    /** Explains a refusal some other way (beside a field, or silently). */
    explained?: (cause: unknown) => boolean,
  ) => {
    if (sending.current) return;
    sending.current = true;
    sends.current += 1;
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
      if (!explained?.(cause)) setError(wizardError(cause));
      // The server is the record: show where the session really is.
      if (wizard) await read(wizard.id, true);
    } finally {
      sending.current = false;
      if (alive.current) setBusy(undefined);
    }
  };
  const step = (action: WorkerWizardAction) => async () => {
    const run = client.workerWizardAction;
    if (!run || !wizard) return undefined;
    try {
      const reply = await run.call(client, projectId, wizard.id, action);
      // Recorded whether or not this view is still open.
      if (action.kind === "cancel") {
        rememberWizard(projectId, undefined);
        if (current.current === wizard.id) current.current = undefined;
      }
      return "wizard" in reply ? reply.wizard : undefined;
    } catch (cause) {
      // The server's verdict on this preview stands, even with time left on
      // it: it is not offered for sending again.
      if (
        "preview_id" in action &&
        cause instanceof ApiError &&
        cause.code === "worker_preview_stale"
      ) {
        const id = action.preview_id;
        setRejected((list) => (list.includes(id) ? list : [...list, id]));
      }
      throw cause;
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const checked = validate(form);
    if ("errors" in checked) {
      setFieldErrors(checked.errors);
      setError("");
      setRetry(undefined);
      // The first field to correct takes focus (after the notes render).
      const target = event.currentTarget;
      window.setTimeout(() => {
        if (target instanceof HTMLElement)
          target.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
      });
      return;
    }
    setFieldErrors({});
    const { input } = checked;
    const create = client.createWorkerWizard;
    if (!create) return;
    const replaced = wizard?.id;
    void act(
      "preview",
      async () => {
        const { wizard: created } = await create.call(client, projectId, input);
        // Kept even if the reader left meanwhile: the session exists now,
        // and replies about any earlier session no longer apply.
        rememberWizard(projectId, created.id);
        current.current = created.id;
        // An edit that changed the machine leaves the old session behind on
        // the server (same machine: the server already replaced it).
        if (replaced && replaced !== created.id)
          void client
            .workerWizardAction?.(projectId, replaced, { kind: "cancel" })
            .catch(() => undefined);
        return created;
      },
      () => setEditing(false),
      (cause) => {
        // A refusal the server ties to a field is shown beside that field.
        const key =
          cause instanceof ApiError ? FIELD_ERRORS[cause.code] : undefined;
        if (!key || !(cause instanceof ApiError)) return false;
        setFieldErrors({ [key]: wizardError(cause) });
        return true;
      },
    );
  };
  /** C-707: the code becomes a draft of the chosen project, with its limit. */
  const pair = (input: PairingInput, explain: (cause: unknown) => boolean) => {
    const claim = client.pairWorkerDevice;
    if (!claim) return;
    void act(
      "pair",
      async () => {
        const { wizard: created } = await claim.call(client, input.project, {
          code: input.code,
          run_limit: input.run_limit,
        });
        // Kept even if the reader left meanwhile: the code is used now.
        rememberWizard(input.project, created.id);
        current.current = created.id;
        return created;
      },
      () => {
        fresh.current = false;
        setProjectId(input.project);
        setPairingForm(false);
      },
      explain,
    );
  };
  const cancel = () => {
    if (!wizard) return onClose("empty");
    if (wizard.phase === "running") return;
    void act("cancel", step({ kind: "cancel" }), () => onClose("cancelled"));
  };
  /** Give up a held session this browser cannot read now; start afresh. */
  const forget = () => {
    rememberWizard(projectId, undefined);
    current.current = undefined;
    setHeld(undefined);
    setReadState("ok");
    setError("");
    setRetry(undefined);
  };
  const finish = () => {
    if (sending.current) return;
    rememberWizard(projectId, undefined);
    onClose("done");
  };
  const close = () => {
    if (sending.current) return;
    onClose(held && wizard?.phase !== "enabled" ? "kept" : "empty");
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

  /**
   * C-565 auto recheck: once a check stops at a step the target-machine
   * commands fix, the same check is started again every `autoRecheckMs`
   * (at most `autoRecheckMax` times per blocked step), so the page moves on
   * by itself after the administrator ran the command. A request error, a
   * failed read, editing the form or leaving pauses it.
   */
  const [rechecks, setRechecks] = useState<{ step: string; count: number }>();
  const stop = !editing && readState === "ok" ? stopOf(wizard) : undefined;
  const [neededFor, setNeededFor] = useState(() => commandsNeeded(projectId));
  const targetStopId =
    wizard && stopOf(wizard) && isTargetStep(stopOf(wizard) as WorkerWizardStep)
      ? wizard.id
      : undefined;
  useEffect(() => {
    if (!targetStopId) return;
    rememberCommandsNeeded(projectId, targetStopId);
    setNeededFor(targetStopId);
  }, [projectId, targetStopId]);
  const blockedStep =
    stop && isTargetStep(stop) && wizard?.check_id ? stop.step : undefined;
  const recheckCount =
    blockedStep && rechecks?.step === blockedStep ? rechecks.count : 0;
  const autoRecheck =
    blockedStep !== undefined &&
    !error &&
    busy === undefined &&
    recheckCount < autoRecheckMax;
  const startRun = useRef<() => void>(undefined);
  // It continues only the failed check this page saw: once the session has
  // moved on (another page continued or passed it), the server refuses and
  // this page reads the current state instead of starting a new check.
  startRun.current = () => {
    const resume_check_id = wizard?.check_id;
    if (!resume_check_id) return;
    void act(
      "run",
      step({ kind: "run", resume_check_id }),
      undefined,
      (cause) =>
        cause instanceof ApiError && cause.code === "worker_check_changed",
    );
  };
  useEffect(() => {
    if (!autoRecheck || !blockedStep) return;
    const timer = window.setTimeout(() => {
      setRechecks({ step: blockedStep, count: recheckCount + 1 });
      startRun.current?.();
    }, autoRecheckMs);
    return () => window.clearTimeout(timer);
  }, [autoRecheck, blockedStep, recheckCount, autoRecheckMs]);
  const recheckNotice = !blockedStep
    ? undefined
    : recheckCount >= autoRecheckMax
      ? "自动复查已停止：在目标机执行命令后，请点“继续检查”。"
      : autoRecheck
        ? `自动复查中（${recheckCount}/${autoRecheckMax}）`
        : undefined;

  const phase = wizard?.phase;
  const loading = readState === "loading";
  const refused = readState === "refused";
  // C-707: until the code became a draft, the pairing form stands in for it.
  const showPairing = pairingForm && !wizard;
  // A held session that cannot be read is not replaced by a blank form.
  const showForm = !showPairing && !refused && (editing || (!wizard && !held));
  const content = !refused && !showForm ? wizard : undefined;
  const waiting = busy !== undefined || undefined;
  const run = (label: string, variant?: "primary") => (
    <Button
      variant={variant}
      aria-disabled={waiting}
      onClick={() => {
        if (sending.current) return;
        // Asked by hand: automatic rechecks start over for the next stop.
        setRechecks(undefined);
        void act("run", step({ kind: "run" }));
      }}
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
    !wizard && held && readState === "failed" ? (
      <Button aria-disabled={waiting} onClick={forget}>
        放弃并重新填写
      </Button>
    ) : !content ? undefined : phase === "preview" ? (
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
      title={
        content
          ? `添加 worker：${content.label}`
          : showPairing
            ? "新设备接入"
            : "添加 worker"
      }
      description={showPairing ? "用配对码接入新设备" : "新建 worker 向导"}
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
                    : busy === "pair"
                      ? "正在确认配对…"
                      : "正在提交…"
            }
            error={error}
            retry={retry}
            message={message}
          />
          {content?.phase === "running" && readState === "ok" && (
            <RequestFeedback
              interactive
              pending
              pendingMessage={`正在检查：${checkStepLabel(
                content.steps.find((s) => s.state === "running")?.step ??
                  "queued",
              )}…`}
            />
          )}
          {recheckNotice && (
            <RequestFeedback interactive message={recheckNotice} />
          )}
        </SettingsDrawerFeedback>
        {(showForm || showPairing || content) && (
          <SettingsSteps
            label="添加 worker 的步骤"
            steps={
              showPairing || content?.device_init ? PAIRING_STEPS : WIZARD_STEPS
            }
            current={showForm || showPairing ? 0 : wizardStep(content)}
            failed={
              !showForm && content?.phase === "failed" ? CHECKS_STEP : undefined
            }
            skipped={
              !showForm && content && neededFor !== content.id
                ? COMMANDS_STEP
                : undefined
            }
          />
        )}
        {showPairing && (
          <PairingForm
            client={client}
            initialCode={pairingStart?.code ?? ""}
            pageProject={pageProject}
            busy={busy !== undefined}
            onSubmit={pair}
            onCancel={() => onClose("empty")}
          />
        )}
        {showForm && (
          <WizardForm
            form={form}
            errors={fieldErrors}
            mcpSource={mcpSource}
            accountSuggested={form.account === suggestedAccount(projectId)}
            setForm={(next, key) => {
              if (key === "mcp_url") {
                mcpEdited.current = true;
                setMcpSource(undefined);
              }
              setForm(next);
              setFieldErrors(({ [key]: _, ...rest }) => rest);
              setError("");
            }}
            busy={busy !== undefined}
            onSubmit={submit}
            onCancel={() => (wizard ? setEditing(false) : onClose("empty"))}
            back={!!wizard}
          />
        )}
        {content && (
          <>
            <SettingsSection title="概况">
              <SettingsFacts>
                <SettingsFact label="机器编号">
                  <code>{content.machine_id}</code>
                </SettingsFact>
                <SettingsFact label="系统与架构">
                  {[content.os, content.arch].join(" / ")}
                </SettingsFact>
                <SettingsFact label="进度">
                  <StatusTag
                    status={PHASES[content.phase].status}
                    label={PHASES[content.phase].label}
                  />
                </SettingsFact>
                {content.device_init && (
                  <SettingsFact label="设备初始化">
                    <StatusTag
                      status={DEVICE_INIT[content.device_init.state].status}
                      label={DEVICE_INIT[content.device_init.state].label}
                    />
                  </SettingsFact>
                )}
                {content.run_limit && (
                  <SettingsFact label="名额">
                    {content.run_limit.state === "kept"
                      ? "沿用机器现有上限"
                      : `${content.run_limit.value} 个${
                          content.run_limit.state === "pending"
                            ? "（登记后生效）"
                            : ""
                        }`}
                  </SettingsFact>
                )}
                {content.error && (
                  <SettingsFact label="中断原因">
                    <code>{content.error}</code>
                  </SettingsFact>
                )}
              </SettingsFacts>
            </SettingsSection>
            {content.phase === "preview" && content.preview ? (
              <PreviewConfirm
                rejected={rejected.includes(content.preview.preview_id)}
                wizard={content}
                preview={content.preview}
                busy={busy !== undefined}
                onBack={() => {
                  if (!form.machine_id)
                    setForm({
                      // The prefilled port, account and MCP address stay.
                      ...form,
                      machine_id: content.machine_id,
                      label: content.label,
                      os: content.os === "linux" ? "linux" : "macos",
                      arch: content.arch === "x64" ? "x64" : "arm64",
                    });
                  setEditing(true);
                }}
                onConfirm={(preview_id) =>
                  void act("confirm", step({ kind: "confirm", preview_id }))
                }
              />
            ) : (
              <>
                <Steps wizard={content} onCopy={(key) => void copy(key)} />
                {commandsShown(content) && (
                  <Commands wizard={content} onCopy={(key) => void copy(key)} />
                )}
                {(content.phase === "passed" ||
                  content.phase === "enabled") && (
                  <HealthReport wizard={content} />
                )}
                {(content.phase === "passed" ||
                  content.phase === "enabled") && (
                  <RemoteLaunch
                    wizard={content}
                    busy={busy !== undefined}
                    confirmed={launchConfirmed}
                    rejected={rejected}
                    onConfirmed={setLaunchConfirmed}
                    onPreview={() =>
                      void act("launch", step({ kind: "launch-preview" }))
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

/** Commands that list the numbers already taken on the target machine. */
const ID_COMMANDS: Readonly<Record<Form["os"], { uid: string; gid: string }>> =
  {
    linux: {
      uid: "getent passwd | cut -d: -f3 | sort -n",
      gid: "getent group | cut -d: -f3 | sort -n",
    },
    macos: {
      uid: "dscl . -list /Users UniqueID | sort -nk2",
      gid: "dscl . -list /Groups PrimaryGroupID | sort -nk2",
    },
  };

function WizardForm({
  form,
  errors,
  mcpSource,
  accountSuggested,
  setForm,
  busy,
  back,
  onSubmit,
  onCancel,
}: {
  form: Form;
  /** The account field still holds the recommended name. */
  accountSuggested: boolean;
  /** Each mistake is shown beside its own field. */
  errors: FieldErrors;
  mcpSource: McpSource;
  setForm: (form: Form, changed: keyof Form) => void;
  busy: boolean;
  back: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const osHint = useId();
  const commands = ID_COMMANDS[form.os];
  const text = (
    key: keyof Form,
    label: string,
    hint: ReactNode,
    numeric = false,
  ) => (
    <SettingsField label={label} error={errors[key]} hint={hint}>
      {({ invalid, describedBy }) => (
        <Input
          value={form[key]}
          inputMode={numeric ? "numeric" : undefined}
          autoComplete={numeric ? undefined : "off"}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(event) =>
            setForm({ ...form, [key]: event.target.value }, key)
          }
        />
      )}
    </SettingsField>
  );
  return (
    <form aria-label="worker 接入信息" noValidate onSubmit={onSubmit}>
      <SettingsDialogFields>
        <fieldset disabled={busy}>
          {text(
            "machine_id",
            "机器编号",
            "每台物理机一个固定编号：字母、数字、点、下划线或连字符，不能是 local。已用 cardigan worker add 登记过的机器，填原来的编号。",
          )}
          {text("label", "名称", "机器列表中显示的名字，不超过 80 个字。")}
        </fieldset>
        <fieldset disabled={busy}>
          <legend>系统</legend>
          <ToggleGroup
            type="multiple"
            aria-label="系统"
            aria-describedby={osHint}
            value={[form.os]}
            onValueChange={(next) => {
              const os = next.at(-1);
              if (os === "linux" || os === "macos")
                setForm(
                  {
                    ...form,
                    os,
                    arch: os === "macos" ? "arm64" : form.arch,
                  },
                  "os",
                );
            }}
          >
            <ToggleGroupItem value="linux">Linux</ToggleGroupItem>
            <ToggleGroupItem value="macos">macOS</ToggleGroupItem>
          </ToggleGroup>
          <SettingsFieldHint id={osHint}>
            目标机的操作系统。macOS 只支持 Apple Silicon（arm64）。
          </SettingsFieldHint>
        </fieldset>
        <fieldset disabled={busy}>
          <SettingsField
            label="架构"
            hint={
              form.os === "macos" ? (
                "Apple Silicon 固定为 arm64。"
              ) : (
                <>
                  在目标机运行 <code>uname -m</code>
                  {"：x86_64 选 x64，aarch64 选 arm64。"}
                </>
              )
            }
          >
            {({ describedBy }) => (
              <SelectControl
                value={form.os === "macos" ? "arm64" : form.arch}
                aria-describedby={describedBy}
                onValueChange={(arch) => {
                  if (arch === "x64" || arch === "arm64")
                    setForm({ ...form, arch }, "arch");
                }}
              >
                {form.os === "linux" && <option value="x64">x64</option>}
                <option value="arm64">arm64</option>
              </SelectControl>
            )}
          </SettingsField>
          {text(
            "host",
            "主机地址",
            "控制主机能用 SSH 连上的目标机域名或 IP，通常是 tailnet 名（如 worker-a.<tailnet>.ts.net），不带用户名。",
          )}
          {text("port", "SSH 端口", "目标机 sshd 监听的端口，默认 22。", true)}
          {text(
            "account",
            "专用账号",
            `目标机上为本项目新建的非管理员账号：以 cg_ 开头，每个项目单独一个，不复用个人或 CI 账号。${accountSuggested ? "已按项目名推荐。" : ""}`,
          )}
          {text(
            "uid",
            "UID",
            <>
              {"不小于 501、目标机上没被占用的用户编号。在目标机查已占用的："}
              <code>{commands.uid}</code>
            </>,
            true,
          )}
          {text(
            "gid",
            "GID",
            <>
              {
                "专用账号主组的编号，不小于 501 且未被占用，通常与 UID 相同。在目标机查已占用的："
              }
              <code>{commands.gid}</code>
            </>,
            true,
          )}
          {text(
            "mcp_url",
            "MCP 地址",
            <>
              {
                "控制主机经 Tailscale Serve 提供的地址，形如 https://<主机>.<tailnet>.ts.net/mcp；只认 HTTPS 的 /mcp。"
              }
              {mcpSource === "workers"
                ? "已填入现有 worker 使用的地址。"
                : mcpSource === "host"
                  ? "已填入控制主机配置的 MCP 地址。"
                  : mcpSource === "page"
                    ? "已按当前 Workbench 的地址填入，请核对 /mcp 的转发。"
                    : ""}
            </>,
          )}
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
        {diff.map((raw) => {
          // The launch switch reports its values as "false → true".
          const pair = /^(.+?) → (.+)$/u.exec(raw.change);
          const d =
            pair && raw.before === undefined && raw.after === undefined
              ? { ...raw, change: "change", before: pair[1], after: pair[2] }
              : raw;
          return (
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
          );
        })}
      </TableBody>
    </SettingsTable>
  );
}

/** Nothing is written until the reader confirms this exact preview. */
function PreviewConfirm({
  wizard,
  preview,
  busy,
  rejected,
  onBack,
  onConfirm,
}: {
  wizard: WorkerWizardView;
  /** The server refused this preview as stale: only 返回修改 remains. */
  rejected: boolean;
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
      {rejected && (
        <SettingsWarning>
          这份预览已失效，请返回修改后重新预览。
        </SettingsWarning>
      )}
      <SettingsDialogActions>
        <Button onClick={onBack} disabled={busy}>
          返回修改
        </Button>
        <Button
          variant="primary"
          disabled={busy || rejected}
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
                      {s.next && (
                        <p>
                          {s.next.split("\n").map((line, i) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: lines of one fixed hint
                            <span key={i}>
                              {i > 0 && <br />}
                              {line}
                            </span>
                          ))}
                        </p>
                      )}
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
 * that preview; the tick belongs to one preview id, so a replaced preview
 * needs a new one. An expired preview is fetched again rather than sent.
 * The server repeats every check before turning it on.
 */
function RemoteLaunch({
  wizard,
  busy,
  confirmed,
  rejected,
  onConfirmed,
  onPreview,
  onEnable,
}: {
  wizard: WorkerWizardView;
  busy: boolean;
  /** The preview id the reader ticked, if any. */
  confirmed: string | undefined;
  /** Preview ids the server refused as stale. */
  rejected: readonly string[];
  onConfirmed: (previewId: string | undefined) => void;
  onPreview: () => void;
  onEnable: (previewId: string) => void;
}) {
  const id = useId();
  const enabled = wizard.phase === "enabled";
  const preview = enabled ? undefined : wizard.preview;
  const expires = preview ? Date.parse(preview.expires_at) : Number.NaN;
  const [now, setNow] = useState(() => Date.now());
  // Re-render when the preview expires, so it cannot be sent afterwards.
  useEffect(() => {
    if (!Number.isFinite(expires)) return;
    const wait = expires - Date.now();
    if (wait <= 0) return setNow(Date.now());
    const timer = window.setTimeout(() => setNow(Date.now()), wait + 50);
    return () => window.clearTimeout(timer);
  }, [expires]);
  const refused = preview ? rejected.includes(preview.preview_id) : false;
  const live = preview && !(expires <= now) && !refused ? preview : undefined;
  const ticked = live !== undefined && confirmed === live.preview_id;
  return (
    <>
      <SettingsGroup title="需谨慎" tone="caution">
        <SettingsRow
          label="远程派发"
          help="开启后，这台机器可以接收本项目派发的任务。只有当前所有者可以开启。"
          warning={
            !preview || live
              ? undefined
              : refused
                ? "派发预览已失效，请重新预览。"
                : "派发预览已过期，请重新预览。"
          }
          status={
            <StatusTag
              status={enabled ? "passed" : "not_run"}
              label={enabled ? "已开启" : "未开启"}
              subdued={!enabled}
            />
          }
        >
          {!enabled && !live && (
            <Button disabled={busy} onClick={onPreview}>
              {preview ? "重新预览" : "预览开启"}
            </Button>
          )}
        </SettingsRow>
        {live && (
          <SettingsRow label="我确认开启远程派发" htmlFor={id}>
            <Checkbox
              id={id}
              checked={ticked}
              disabled={busy}
              onCheckedChange={(checked) =>
                onConfirmed(checked === true ? live.preview_id : undefined)
              }
            />
            <Button
              variant="primary"
              disabled={busy || !ticked}
              onClick={() => onEnable(live.preview_id)}
            >
              开启远程派发
            </Button>
          </SettingsRow>
        )}
      </SettingsGroup>
      {live && (
        <SettingsSection title="派发配置差异">
          <SettingsFacts>
            <SettingsFact label="文件">
              <code>{live.file}</code>
            </SettingsFact>
            <SettingsFact label="预览有效至">
              <Time value={live.expires_at} />
            </SettingsFact>
          </SettingsFacts>
          <DiffTable label="派发配置差异" diff={live.diff} />
        </SettingsSection>
      )}
    </>
  );
}

/** C-707: what the pairing form sends. */
interface PairingInput {
  project: string;
  code: string;
  run_limit: number;
}
const PAIRING_CODE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/u;
/** Refusals shown beside the code field. */
const CODE_ERRORS = [
  "pairing_code_invalid",
  "pairing_code_expired",
  "pairing_code_used",
];
type PairingErrors = Partial<Record<"code" | "run_limit", string>>;

/**
 * C-707: the first step of a device pairing. The code (prefilled from the QR
 * link), the project and the new machine's Agent limit are sent together
 * with “确认接入”; nothing is written before that, and a code left unused
 * expires on its own.
 */
function PairingForm({
  client,
  initialCode,
  pageProject,
  busy,
  onSubmit,
  onCancel,
}: {
  client: CardiganClient;
  initialCode: string;
  pageProject: string;
  busy: boolean;
  onSubmit: (input: PairingInput, explain: (cause: unknown) => boolean) => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState(initialCode);
  const [project, setProject] = useState(pageProject);
  const [runLimit, setRunLimit] = useState("1");
  const [errors, setErrors] = useState<PairingErrors>({});
  const loadProjects = useCallback(() => client.projects(), [client]);
  const projects = useResource(loadProjects);
  const options = projects.data?.some((p) => p.id === pageProject)
    ? projects.data
    : [{ id: pageProject, name: pageProject, code: null }];
  const origin = window.location.origin;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = code.replace(/[\s-]/gu, "").toUpperCase();
    const limit = integer(runLimit);
    const next: PairingErrors = {};
    if (!PAIRING_CODE.test(normalized))
      next.code = "配对码为设备上显示的 8 位字母和数字，如 ABCD-EFGH。";
    if (!(limit >= 1)) next.run_limit = "名额须为正整数。";
    setErrors(next);
    const target = event.currentTarget;
    if (Object.keys(next).length > 0) {
      window.setTimeout(() =>
        target.querySelector<HTMLElement>("[aria-invalid='true']")?.focus(),
      );
      return;
    }
    onSubmit({ project, code: normalized, run_limit: limit }, (cause) => {
      if (!(cause instanceof ApiError)) return false;
      if (CODE_ERRORS.includes(cause.code))
        setErrors({ code: WIZARD_ERRORS[cause.code] ?? cause.message });
      else if (cause.code === "worker_run_limit_invalid")
        setErrors({ run_limit: `${cause.message}。` });
      else return false;
      window.setTimeout(() =>
        target.querySelector<HTMLElement>("[aria-invalid='true']")?.focus(),
      );
      return true;
    });
  };
  return (
    <form aria-label="配对确认" noValidate onSubmit={submit}>
      <SettingsDialogFields>
        <fieldset disabled={busy}>
          <SettingsField
            label="配对码"
            error={errors.code}
            hint={
              <>
                {"在新设备上运行 "}
                <code>{`curl -fsS ${origin}/pair-device.py | python3 - ${origin}`}</code>
                {"，填它显示的 8 位码。10 分钟内有效，只能用一次。"}
              </>
            }
          >
            {({ invalid, describedBy }) => (
              <Input
                value={code}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={invalid}
                aria-describedby={describedBy}
                onChange={(event) => {
                  setCode(event.target.value);
                  setErrors(({ code: _, ...rest }) => rest);
                }}
              />
            )}
          </SettingsField>
          <SettingsField
            label="项目"
            hint="设备接入这个项目，并为它新建专用账号。"
          >
            {({ describedBy }) => (
              <SelectControl
                value={project}
                aria-describedby={describedBy}
                onValueChange={setProject}
              >
                {options.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code ? `${p.name}（${p.code}）` : p.name}
                  </option>
                ))}
              </SelectControl>
            )}
          </SettingsField>
          <SettingsField
            label="名额"
            error={errors.run_limit}
            hint="这台设备同时运行的 Agent 数，默认 1，之后可在机器详情修改；已接入的机器保持原上限。"
          >
            {({ invalid, describedBy }) => (
              <Input
                value={runLimit}
                inputMode="numeric"
                aria-invalid={invalid}
                aria-describedby={describedBy}
                onChange={(event) => {
                  setRunLimit(event.target.value);
                  setErrors(({ run_limit: _, ...rest }) => rest);
                }}
              />
            )}
          </SettingsField>
        </fieldset>
        {storedWizard(project) && (
          <SettingsWarning>
            确认后将替换这个项目未完成的添加 worker 进度。
          </SettingsWarning>
        )}
      </SettingsDialogFields>
      <SettingsDialogActions>
        <Button onClick={onCancel} disabled={busy}>
          取消
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          确认接入
        </Button>
      </SettingsDialogActions>
    </form>
  );
}

const DEVICE_INIT: Readonly<
  Record<
    NonNullable<WorkerWizardView["device_init"]>["state"],
    { status: string; label: string }
  >
> = {
  waiting: { status: "waiting", label: "等待设备" },
  fetched: { status: "running", label: "设备执行中" },
  succeeded: { status: "passed", label: "已完成" },
  failed: { status: "failed", label: "未完成" },
};

const GIB = 1024 ** 3;
const size = (n: number) =>
  n >= GIB
    ? `${(n / GIB).toFixed(n >= 100 * GIB ? 0 : 1)} GiB`
    : `${Math.max(1, Math.round(n / 1024 ** 2))} MiB`;
/** Where each report value comes from, in words. */
const SOURCE = {
  device: "设备自报",
  missing: "设备未上报",
  none: "未采集",
  wizard: "向导配置",
  check: "接入检查",
  catalog: "能力目录",
} as const;
type ReportRow = { item: string; value: string; source: string };

function deviceRows(
  wizard: WorkerWizardView,
  d: WorkerPairingDevice | undefined,
): ReportRow[] {
  const fact = (item: string, value: string | undefined): ReportRow =>
    value
      ? { item, value, source: SOURCE.device }
      : { item, value: "—", source: d ? SOURCE.missing : SOURCE.none };
  const platform = [wizard.os, wizard.arch].join(" / ");
  return [
    d?.system
      ? {
          item: "系统",
          value: `${d.system} · ${platform}`,
          source: SOURCE.device,
        }
      : { item: "系统", value: platform, source: SOURCE.wizard },
    fact(
      "CPU",
      [d?.cpu, d?.cpu_cores && `${d.cpu_cores} 核`].filter(Boolean).join(" · "),
    ),
    fact("内存", d?.memory_bytes ? size(d.memory_bytes) : undefined),
    fact(
      "磁盘",
      d?.disk_total_bytes !== undefined && d.disk_free_bytes !== undefined
        ? `可用 ${size(d.disk_free_bytes)} / 共 ${size(d.disk_total_bytes)}（${d.disk_path ?? "—"}）`
        : undefined,
    ),
    fact("GPU", d?.gpu),
  ];
}

/**
 * C-707: the onboarding report once the checks passed. Every value names its
 * source: the device's own report when pairing (unverified), the wizard's
 * configuration, the checks, or the host's capability catalog.
 */
function HealthReport({ wizard }: { wizard: WorkerWizardView }) {
  const report = wizard.report;
  const verified = report?.capabilities
    .filter((c) => c.state === "verified")
    .map((c) => (c.version ? `${c.key} ${c.version}` : c.key));
  const rows: ReportRow[] = [
    ...deviceRows(wizard, wizard.device),
    {
      item: "已验证能力",
      value: verified ? verified.join("、") || "没有" : "—",
      source: SOURCE.check,
    },
    {
      item: "建议安装的工具",
      value: report ? report.suggested.join("、") || "没有" : "—",
      source: SOURCE.catalog,
    },
  ];
  return (
    <SettingsSection title="体检报告">
      <SettingsTable aria-label="体检报告">
        <TableHeader>
          <TableRow>
            <TableHead>项目</TableHead>
            <TableHead>结果</TableHead>
            <TableHead>来源</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.item}>
              <DataTableCell nowrap data-record="lead">
                {row.item}
              </DataTableCell>
              <DataTableCell data-label="结果">{row.value}</DataTableCell>
              <DataTableCell nowrap data-record="aside">
                {row.source}
              </DataTableCell>
            </TableRow>
          ))}
        </TableBody>
      </SettingsTable>
    </SettingsSection>
  );
}
