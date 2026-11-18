import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  type CardiganClient,
  describeWriteError,
  type PreferencesView,
} from "../api.js";
import { PageTitle, StatusTag } from "../components/Foundation.js";
import {
  SettingsGroup,
  SettingsLayout,
  SettingsNavItem,
  SettingsNumberField,
  SettingsPanel,
  SettingsRow,
} from "../components/layout/SettingsLayout.js";
import {
  RequestFeedback,
  RequestFeedbackScope,
} from "../components/RequestFeedback.js";
import { Button } from "../components/ui/button.js";
import { Switch } from "../components/ui/switch.js";
import { categoryLabels, defaultDelegation } from "../decision-labels.js";
import { employeeCopy } from "../employee-copy.js";
import { useRouteFilters } from "../route.js";
import { useResource } from "../useResource.js";
import { CapacitySettings } from "./CapacitySettings.js";
import { EmployeesSettings } from "./EmployeesSettings.js";
import { RolesSettings } from "./RolesSettings.js";
import { SystemRulesSettings } from "./SystemRulesSettings.js";
import { TemplateSettings } from "./TemplateSettings.js";

/** Categories that go to the human unless the human delegates them. */
const humanCategories = [
  ...Object.keys(categoryLabels).filter((c) => !defaultDelegation[c]),
  "sensitive",
];
const categoryLabel = (category: string) =>
  category === "sensitive"
    ? "人标记的敏感卡"
    : (categoryLabels[category] ?? "");

export function SettingsPage({
  client,
  projectId,
  revision = 0,
}: {
  client: CardiganClient;
  projectId: string;
  revision?: number;
}) {
  const [filters] = useRouteFilters({ kind: "settings", projectId });
  const [tab, setTab] = useState<
    | "preferences"
    | "authorization"
    | "roles"
    | "templates"
    | "employees"
    | "capacity"
  >(filters.tab === "authorization" ? "authorization" : "preferences");
  useEffect(() => {
    if (filters.tab === "authorization") setTab("authorization");
  }, [filters.tab]);
  const [employeeRole, setEmployeeRole] = useState("");
  const load = useCallback(
    () => client.preferences(projectId),
    [client, projectId],
  );
  const resource = useResource(load, revision);
  const data = resource.data;
  // The review round ceiling comes only from the server (domain, Q-420).
  const roundsCeiling = data?.review_max_rounds_ceiling;
  const common = { client, projectId, saved: resource.reload };
  return (
    <SettingsLayout
      header={<PageTitle title="设置" />}
      nav={
        <>
          <SettingsNavItem
            current={tab === "preferences"}
            onClick={() => setTab("preferences")}
          >
            偏好
          </SettingsNavItem>
          <SettingsNavItem
            current={tab === "capacity"}
            onClick={() => setTab("capacity")}
          >
            并发与容量
          </SettingsNavItem>
          <SettingsNavItem
            current={tab === "authorization"}
            onClick={() => setTab("authorization")}
          >
            授权
          </SettingsNavItem>
          <SettingsNavItem
            current={tab === "roles"}
            onClick={() => {
              setTab("roles");
              requestAnimationFrame(() =>
                document.getElementById("roles")?.focus(),
              );
            }}
          >
            角色
          </SettingsNavItem>
          <SettingsNavItem
            current={tab === "templates"}
            onClick={() => setTab("templates")}
          >
            卡片模板
          </SettingsNavItem>
          <SettingsNavItem
            current={tab === "employees"}
            onClick={() => {
              setEmployeeRole("");
              setTab("employees");
            }}
          >
            {employeeCopy.tab}
          </SettingsNavItem>
        </>
      }
    >
      {tab === "capacity" && (
        <CapacitySettings client={client} projectId={projectId} />
      )}
      {tab === "roles" && (
        <section id="roles" tabIndex={-1} aria-labelledby="roles-title">
          <h2 id="roles-title">角色</h2>
          <RolesSettings
            key={projectId}
            client={client}
            projectId={projectId}
            revision={revision}
            onNewEmployee={(roleId) => {
              setEmployeeRole(roleId);
              setTab("employees");
            }}
          />
        </section>
      )}
      {tab === "employees" && (
        <EmployeesSettings
          key={projectId}
          client={client}
          projectId={projectId}
          initialRole={employeeRole}
          revision={revision}
        />
      )}
      {tab === "templates" && (
        <TemplateSettings
          key={projectId}
          client={client}
          projectId={projectId}
          revision={revision}
        />
      )}
      {(tab === "preferences" || tab === "authorization") && (
        <RequestFeedback
          {...resource}
          retry={resource.reload}
          pendingMessage="正在加载偏好…"
        />
      )}
      <RequestFeedbackScope hidden={tab !== "preferences"}>
        <SettingsPanel
          hidden={tab !== "preferences"}
          id="preferences"
          tabIndex={-1}
          title="偏好"
          titleId="preferences-title"
        >
          {data && (
            <SystemRulesSettings
              key={`system-rules:${projectId}`}
              initial={data}
              {...common}
            />
          )}
          {data && (
            <SettingsGroup title="协作">
              <CrossCardReadSetting
                key={`cross-card-read:${projectId}`}
                enabled={data.cross_card_read !== false}
                {...common}
              />
            </SettingsGroup>
          )}
          {data && (
            <SettingsGroup title="合并确认">
              {(["stall", "snooze", "snooze-max"] as const).map((kind) => (
                <MergeMinutesSetting
                  key={`${kind}:${projectId}`}
                  kind={kind}
                  initial={
                    kind === "stall"
                      ? (data.merge_confirm_stall_after_minutes ?? 60)
                      : kind === "snooze"
                        ? (data.merge_confirm_snooze_default_minutes ?? 240)
                        : (data.merge_confirm_snooze_max_minutes ?? 4320)
                  }
                  {...common}
                />
              ))}
            </SettingsGroup>
          )}
          {roundsCeiling !== undefined && (
            <SettingsGroup title="审核轮数">
              {(["review", "independent"] as const).map((kind) => (
                <ReviewRoundsSetting
                  kind={kind}
                  key={`${kind}-rounds:${projectId}`}
                  initial={
                    kind === "review"
                      ? (data?.review_max_rounds ?? 5)
                      : (data?.independent_review_max_rounds ?? 3)
                  }
                  ceiling={roundsCeiling}
                  {...common}
                />
              ))}
            </SettingsGroup>
          )}
          {data && (
            <SettingsGroup
              title="需谨慎"
              tone="caution"
              description="只有你能修改；会让系统在无人确认时合并代码。"
            >
              <AutoMergeSetting
                key={`auto-merge:${projectId}`}
                enabled={
                  data.auto_merge === "on" ||
                  (data.auto_merge === undefined &&
                    (data.flow_version ?? 1) >= 4)
                }
                inherited={data.auto_merge === undefined}
                {...common}
              />
              <AutoMergeSetting
                pause
                key={`auto-pause:${projectId}`}
                enabled={data.auto_merge_paused === true}
                {...common}
              />
              <TimeoutMergeSetting
                key={`timeout:${projectId}`}
                initial={data}
                {...common}
              />
            </SettingsGroup>
          )}
        </SettingsPanel>
      </RequestFeedbackScope>
      <RequestFeedbackScope hidden={tab !== "authorization"}>
        <SettingsPanel
          hidden={tab !== "authorization"}
          id="authorization"
          tabIndex={-1}
          title="授权"
          titleId="authorization-title"
          help={
            <>
              PM 代拍时必须写明理由并保留授权依据；没有活跃 PM Ops
              时交给你，代拍和代确认的合并都会在 Needs You 的知会区同步给你。
              Flow Lite 已停用“人已拍板的改动由 PM 核对后确认合并”、
              “已拍角色正文由 PM 代确认”和“独立复核加轮授权”旧开关，
              原先保存的值不再控制新流程；审核用尽自动加轮，连续第 4 次驳回交
              PM。收回默认交人事项的授权，请关闭相应类别开关；
              停止系统自动合并，请在偏好中关闭“自动合并”或开启“暂停自动合并”。
            </>
          }
        >
          {data && (
            <SettingsGroup
              title="常驻授权"
              description="这些类别默认由 PM 代拍；授权不增加执行能力。"
            >
              {Object.keys(categoryLabels)
                .filter((category) => defaultDelegation[category])
                .map((category) => (
                  <DelegationSetting
                    key={`${category}:${projectId}`}
                    category={category}
                    label={categoryLabel(category)}
                    enabled={
                      data.decision_delegation?.[category] ??
                      defaultDelegation[category] ??
                      false
                    }
                    {...common}
                  />
                ))}
            </SettingsGroup>
          )}
          {data && (
            <SettingsGroup
              title="需谨慎"
              tone="caution"
              description="默认交你处理，只有你能逐类开启；授权覆盖 PM 拍板与合并确认。"
            >
              <PmMergeSetting
                key={`pm-merge:${projectId}`}
                enabled={data.pm_merge_confirmation !== false}
                {...common}
              />
              {humanCategories.map((category) => (
                <DelegationSetting
                  key={`${category}:${projectId}`}
                  category={category}
                  label={categoryLabel(category)}
                  enabled={
                    data.decision_delegation?.[category] ??
                    defaultDelegation[category] ??
                    false
                  }
                  {...common}
                />
              ))}
            </SettingsGroup>
          )}
        </SettingsPanel>
      </RequestFeedbackScope>
    </SettingsLayout>
  );
}

interface SettingProps {
  client: CardiganClient;
  projectId: string;
  saved: () => void;
}

/** Success notices leave the shared feedback stack after a short while. */
function useNotice() {
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(""), 4000);
    return () => window.clearTimeout(timer);
  }, [message]);
  return [message, setMessage] as const;
}

/**
 * Integer setting saved on blur or Enter. Drafts follow fresh server values
 * unless they hold an unsaved edit; a retry of the same value reuses its key.
 */
function useNumberSetting({
  initial,
  min,
  max,
  write,
  saved,
}: {
  initial: number;
  min: number;
  max: number;
  write: (value: number, key: string) => Promise<void>;
  saved: () => void;
}) {
  const [draft, setDraft] = useState(String(initial));
  const [base, setBase] = useState(initial);
  const [committed, setCommitted] = useState<string>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useNotice();
  const sending = useRef(false),
    keys = useRef(new Map<string, string>());
  if (base !== initial) {
    setBase(initial);
    if (draft === String(base) || draft === committed)
      setDraft(String(initial));
    setCommitted(undefined);
  }
  const valid =
    /^\d+$/.test(draft) && Number(draft) >= min && Number(draft) <= max;
  const dirty = draft !== String(initial) && draft !== committed;
  const commit = async () => {
    if (sending.current || !valid || !dirty) return;
    sending.current = true;
    const value = draft;
    setBusy(true);
    setError("");
    setMessage("");
    const key = keys.current.get(value) ?? crypto.randomUUID();
    keys.current.set(value, key);
    try {
      await write(Number(value), key);
      keys.current.delete(value);
      setCommitted(value);
      setMessage("偏好已保存");
      saved();
    } catch (cause) {
      setError(describeWriteError(cause));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  return {
    draft,
    setDraft: (value: string) => {
      setDraft(value);
      setMessage("");
      setError("");
    },
    valid,
    busy,
    error,
    message,
    commit,
    dirty,
  };
}

function TimeoutMergeSetting({
  initial,
  client,
  projectId,
  saved,
}: SettingProps & { initial: PreferencesView }) {
  const id = useId();
  const enabled = initial.auto_merge_after_minutes !== null;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useNotice();
  const sending = useRef(false),
    keys = useRef(new Map<string, string>());
  const write = async (value: number | null) => {
    const input = JSON.stringify(value);
    const key = keys.current.get(input) ?? crypto.randomUUID();
    keys.current.set(input, key);
    await client.setPreferences(projectId, value, key);
    keys.current.delete(input);
  };
  const minutes = useNumberSetting({
    initial: initial.auto_merge_after_minutes ?? 10,
    min: 1,
    max: 1440,
    write: (value) => write(value),
    saved,
  });
  const toggle = async (next: boolean) => {
    if (sending.current || minutes.busy || (next && !minutes.valid)) return;
    sending.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await write(next ? Number(minutes.draft) : null);
      setMessage("偏好已保存");
      saved();
    } catch (cause) {
      setError(describeWriteError(cause));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <SettingsRow
        label="超时自动合并"
        labelId={`${id}-label`}
        description="合并确认无人处理且没有其他阻塞时，按等待时间自动代批。"
        descriptionId={`${id}-help`}
        warning={
          initial.merge_gate_enabled
            ? undefined
            : "没有合并闸门时，自动合并会合并未经全量测试和 e2e 的代码"
        }
      >
        <Switch
          checked={enabled}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-help`}
          aria-disabled={busy}
          onCheckedChange={toggle}
        />
      </SettingsRow>
      <SettingsRow label="等待分钟数" htmlFor={`${id}-minutes`}>
        <SettingsNumberField
          id={`${id}-minutes`}
          unit="分钟"
          dirty={enabled && minutes.dirty}
          invalid={enabled && !minutes.valid}
          min="1"
          max="1440"
          value={minutes.draft}
          disabled={!enabled || busy}
          readOnly={minutes.busy}
          onChange={(e) => minutes.setDraft(e.target.value)}
          onCommit={minutes.commit}
        />
      </SettingsRow>
      <RequestFeedback
        error={
          enabled && !minutes.valid
            ? "请输入 1 到 1440 的整数分钟。"
            : undefined
        }
      />
      <RequestFeedback
        interactive
        pending={busy || minutes.busy}
        pendingMessage="保存中…"
        error={error || minutes.error}
        message={message || minutes.message}
      />
    </>
  );
}

/** C-253: review limits of new verifiers; only the human may change them. */
function ReviewRoundsSetting({
  kind,
  initial,
  ceiling,
  client,
  projectId,
  saved,
}: SettingProps & {
  kind: "review" | "independent";
  initial: number;
  ceiling: number;
}) {
  const id = useId();
  const independent = kind === "independent";
  const label = independent ? "独立复核轮数上限" : "普通审核轮数上限";
  const setting = useNumberSetting({
    initial,
    min: 1,
    max: ceiling,
    write: (value, key) =>
      client.setReviewMaxRounds(projectId, kind, value, key),
    saved,
  });
  return (
    <SettingsRow
      label={label}
      htmlFor={id}
      description={`默认 ${independent ? 3 : 5} 轮，可设为 1 到 ${ceiling} 轮；只影响之后新建的审核项。`}
      help={
        independent
          ? "独立复核连续这么多轮未通过就交给你；PM 不能把单个复核项放宽到超过这个值。已有审核项保留创建时的轮数。"
          : "审核连续这么多轮未通过就暂停，等待拍板是否加轮。已有审核项保留创建时的轮数。"
      }
    >
      <SettingsNumberField
        id={id}
        dirty={setting.dirty}
        invalid={!setting.valid}
        aria-label={`${label}（轮）`}
        unit="轮"
        min={1}
        max={ceiling}
        value={setting.draft}
        readOnly={setting.busy}
        onChange={(e) => setting.setDraft(e.target.value)}
        onCommit={setting.commit}
      />
      <RequestFeedback
        error={
          !setting.valid ? `请输入 1 到 ${ceiling} 的整数轮数。` : undefined
        }
      />
      <RequestFeedback
        interactive
        pending={setting.busy}
        pendingMessage="保存中…"
        error={setting.error}
        message={setting.message}
      />
    </SettingsRow>
  );
}

/** C-177: wording set by PM Ops per Q-279 (C-177#7). */
function MergeMinutesSetting({
  kind,
  initial,
  client,
  projectId,
  saved,
}: SettingProps & {
  kind: "stall" | "snooze" | "snooze-max";
  initial: number;
}) {
  const id = useId();
  const snooze = kind === "snooze";
  const snoozeMax = kind === "snooze-max";
  const label = snoozeMax
    ? "合并确认最长暂缓时长"
    : snooze
      ? "合并确认默认暂缓时长"
      : "PM 合并确认停留告警";
  const min = snoozeMax ? 60 : 1;
  const max = snoozeMax ? 10080 : 1440;
  const setting = useNumberSetting({
    initial,
    min,
    max,
    write: (value, key) =>
      snoozeMax
        ? client.setMergeConfirmSnoozeMax(projectId, value, key)
        : snooze
          ? client.setMergeConfirmSnoozeDefault(projectId, value, key)
          : client.setMergeConfirmStallAfter(projectId, value, key),
    saved,
  });
  return (
    <SettingsRow
      label={label}
      htmlFor={id}
      description={
        snoozeMax
          ? "同一合并确认累计暂缓不超过此时长，默认 72 小时。"
          : snooze
            ? "暂缓未填到期时间时使用，到期后自动放回待处理。"
            : "合并检查出结论后 PM 超时未处理，就提醒 PM Ops 并知会你。"
      }
      help={
        snoozeMax
          ? "默认 4320 分钟（72 小时），可设为 60 到 10080 分钟。同一合并确认从首次暂缓开始累计计时，续期或到期后再次暂缓不能超过上限；达到上限后请交人或处理确认。"
          : snooze
            ? "PM 或人暂缓一条合并确认时，没有填到期时间就用这个时长，到期后自动放回待处理。默认 240 分钟，可设为 1 到 1440 分钟。"
            : "PM 持有的合并确认在合并检查出结论后，超过这么久还没处理，就提醒 PM Ops，并在 Needs You 知会人。默认 60 分钟，可设为 1 到 1440 分钟。"
      }
    >
      <SettingsNumberField
        id={id}
        dirty={setting.dirty}
        invalid={!setting.valid}
        aria-label={`${label}（分钟）`}
        unit="分钟"
        min={min}
        max={max}
        value={setting.draft}
        readOnly={setting.busy}
        onChange={(e) => setting.setDraft(e.target.value)}
        onCommit={setting.commit}
      />
      <RequestFeedback
        error={
          !setting.valid ? `请输入 ${min} 到 ${max} 的整数分钟。` : undefined
        }
      />
      <RequestFeedback
        interactive
        pending={setting.busy}
        pendingMessage="保存中…"
        error={setting.error}
        message={setting.message}
      />
    </SettingsRow>
  );
}

function PmMergeSetting({
  enabled,
  client,
  projectId,
  saved,
}: SettingProps & { enabled: boolean }) {
  const id = useId();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const sending = useRef(false),
    key = useRef<string | undefined>(undefined);
  return (
    <SettingsRow
      label="合并由 PM 代确认"
      labelId={`${id}-label`}
      description="PM 只在合并检查、全部验证通过且没有待修问题时确认合并。"
      descriptionId={`${id}-help`}
      help="默认开启。五类默认交人事项按你的逐类授权处理。此开关只控制 PM 代确认；系统自动合并由偏好中的“自动合并”和“暂停自动合并”单独控制。"
      status={
        <span id={`${id}-status`}>
          <StatusTag
            status={enabled ? "active" : "waiting_decision"}
            label={enabled ? "由 PM 代确认" : "PM 代确认已关闭"}
          />
        </span>
      }
    >
      <Switch
        checked={enabled}
        disabled={busy}
        aria-labelledby={`${id}-label ${id}-status`}
        aria-describedby={`${id}-help`}
        onCheckedChange={async (next) => {
          if (sending.current) return;
          sending.current = true;
          setBusy(true);
          setError("");
          key.current ??= crypto.randomUUID();
          try {
            await client.setPmMergeConfirmation(projectId, next, key.current);
            key.current = undefined;
            saved();
          } catch (cause) {
            setError(describeWriteError(cause));
          } finally {
            sending.current = false;
            setBusy(false);
          }
        }}
      />
      <RequestFeedback
        interactive
        pending={busy}
        pendingMessage="保存合并授权中…"
        error={error}
      />
    </SettingsRow>
  );
}

function DelegationSetting({
  category,
  label,
  enabled,
  client,
  projectId,
  saved,
}: SettingProps & { category: string; label: string; enabled: boolean }) {
  const id = useId();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const sending = useRef(false),
    key = useRef<string | undefined>(undefined);
  return (
    <SettingsRow
      label={label}
      labelId={`${id}-label`}
      status={
        <span id={`${id}-status`}>
          <StatusTag
            status={enabled ? "active" : "waiting_decision"}
            label={enabled ? "由 PM 代拍" : "由人拍板"}
          />
        </span>
      }
    >
      <Switch
        checked={enabled}
        disabled={busy}
        aria-labelledby={`${id}-label ${id}-status`}
        onCheckedChange={async (next) => {
          if (sending.current) return;
          sending.current = true;
          setBusy(true);
          setError("");
          key.current ??= crypto.randomUUID();
          try {
            await client.setDelegation(projectId, category, next, key.current);
            key.current = undefined;
            saved();
          } catch (cause) {
            setError(describeWriteError(cause));
          } finally {
            sending.current = false;
            setBusy(false);
          }
        }}
      />
      <RequestFeedback
        interactive
        pending={busy}
        pendingMessage="保存授权中…"
        error={error}
      />
    </SettingsRow>
  );
}

/** Boolean preference that waits for the server and never replays a stale key. */
function useConfirmedSwitch({
  enabled,
  confirmed,
  write,
  saved,
  success,
}: {
  enabled: boolean;
  confirmed: boolean;
  write: (next: boolean, key: string) => Promise<void>;
  saved: () => void;
  success: (next: boolean) => string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useNotice();
  const sending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const pending = useRef<{ value: boolean; key: string } | undefined>(
    undefined,
  );
  useEffect(() => {
    // A refreshed server value confirms the operation even if its response was lost.
    if (confirmed && pending.current?.value === enabled) {
      pending.current = undefined;
      setError("");
    }
  }, [enabled, confirmed]);
  const save = async (next: boolean) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    // Reuse only the outstanding operation; a later switch gets a new key.
    const key =
      pending.current?.value === next
        ? pending.current.key
        : crypto.randomUUID();
    pending.current = { value: next, key };
    try {
      await write(next, key);
      if (!mounted.current) return;
      if (pending.current?.key === key) pending.current = undefined;
      saved();
      setMessage(success(next));
    } catch (cause) {
      if (mounted.current) setError(describeWriteError(cause));
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return {
    busy,
    error,
    message,
    save,
  };
}

function AutoMergeSetting({
  pause = false,
  enabled,
  inherited = false,
  client,
  projectId,
  saved,
}: SettingProps & {
  pause?: boolean;
  enabled: boolean;
  inherited?: boolean;
}) {
  const id = useId();
  const title = pause ? "暂停自动合并" : "自动合并";
  const setting = useConfirmedSwitch({
    enabled,
    confirmed: !inherited,
    write: (next, key) =>
      pause
        ? client.setAutoMergePaused(projectId, next, key)
        : client.setAutoMerge(projectId, next, key),
    saved,
    success: (next) =>
      pause
        ? next
          ? "已暂停自动合并"
          : "已恢复自动合并"
        : next
          ? "已开启自动合并"
          : "已关闭自动合并",
  });
  const status = pause
    ? "暂停系统自动合并，包括旧卡；人亲自确认的合并照常处理。"
    : inherited
      ? enabled
        ? "未设置，按流程级别由系统合并"
        : "未设置，按各卡流程级别处理"
      : enabled
        ? "已开启，满足检查和审核条件的卡由系统合并"
        : "已关闭";
  return (
    <SettingsRow
      label={title}
      labelId={`${id}-label`}
      description={status}
      descriptionId={`${id}-help`}
      help={
        pause
          ? "默认不暂停，只有你能修改。暂停系统自动合并，包括旧卡；人亲自确认的合并、检查和检查失败退回继续按原流程处理。恢复后系统会继续处理符合条件的合并。"
          : "只有你能修改。未设置时，第 4 级及以上的卡按流程级别由系统合并，仍须有有效的流程及发布路径授权。开启后，满足检查和审核条件的卡由系统自动合并，包括在途旧卡；五类默认交人事项仍须有你的有效授权。关闭后停止系统代确认，按现有 PM 合并授权处理。"
      }
    >
      {!pause && inherited && (
        <Button disabled={setting.busy} onClick={() => setting.save(false)}>
          关闭自动合并
        </Button>
      )}
      <Switch
        checked={enabled}
        disabled={!pause && setting.busy}
        aria-disabled={pause ? setting.busy : undefined}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-help`}
        onCheckedChange={setting.save}
      />
      <RequestFeedback
        interactive
        pending={setting.busy}
        pendingMessage={pause ? "正在保存暂停偏好…" : "正在保存自动合并偏好…"}
        error={setting.error}
        message={setting.message}
      />
    </SettingsRow>
  );
}

function CrossCardReadSetting({
  enabled,
  client,
  projectId,
  saved,
}: SettingProps & { enabled: boolean }) {
  const id = useId();
  const setting = useConfirmedSwitch({
    enabled,
    confirmed: true,
    write: (next, key) => client.setCrossCardRead(projectId, next, key),
    saved,
    success: (next) => (next ? "已开启跨卡只读" : "已关闭跨卡只读"),
  });
  return (
    <SettingsRow
      label="跨卡只读"
      labelId={`${id}-label`}
      description="所有角色可读取本项目其它非敏感卡片作参考，写权限不变。"
      descriptionId={`${id}-help`}
      help="默认开启，只有你能修改；关闭后恢复原有按卡片和角色的读取范围。其它卡片的资料不是当前任务指令。"
    >
      <Switch
        checked={enabled}
        aria-disabled={setting.busy}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-help`}
        onCheckedChange={setting.save}
      />
      <RequestFeedback
        interactive
        pending={setting.busy}
        pendingMessage="正在保存跨卡只读偏好…"
        error={setting.error}
        message={setting.message}
      />
    </SettingsRow>
  );
}
