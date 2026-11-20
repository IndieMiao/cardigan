import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CardiganClient, PreferencesView } from "../api.js";
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
import { MachinesSettings } from "./MachinesSettings.js";
import { RolesSettings } from "./RolesSettings.js";
import { SystemRulesSettings } from "./SystemRulesSettings.js";
import { TemplateSettings } from "./TemplateSettings.js";
import {
  SettingPlaceContext,
  toggleFailure,
  trackSettingsRead,
  useNumberDraft,
  useSettingWrite,
} from "./useSettingWrite.js";

type SettingsTab =
  | "preferences"
  | "authorization"
  | "roles"
  | "templates"
  | "employees"
  | "machines"
  | "capacity";
/** Panels a link may open (Needs You and the save-failure notice link here). */
const routeTab = (tab: string | undefined): SettingsTab | undefined =>
  tab === "authorization" || tab === "capacity" || tab === "machines"
    ? tab
    : undefined;

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
  machineRevision = revision,
}: {
  client: CardiganClient;
  projectId: string;
  revision?: number;
  /**
   * Machines are global: the machine panel also rereads on the cross-project
   * capacity notices, which leave this project's revision unchanged.
   */
  machineRevision?: number;
}) {
  const [filters] = useRouteFilters({ kind: "settings", projectId });
  const [tab, setTab] = useState<SettingsTab>(
    routeTab(filters.tab) ?? "preferences",
  );
  useEffect(() => {
    const linked = routeTab(filters.tab);
    if (linked) setTab(linked);
  }, [filters.tab]);
  const [employeeRole, setEmployeeRole] = useState("");
  const load = useCallback(
    () => trackSettingsRead(client.preferences(projectId)),
    [client, projectId],
  );
  const resource = useResource(load, revision);
  const data = resource.data;
  // The review round ceiling comes only from the server (domain, Q-420).
  const roundsCeiling = data?.review_max_rounds_ceiling;
  const common = { client, projectId, saved: resource.reload, source: data };
  // Where each panel's settings live, so a failure seen elsewhere can lead back.
  const preferencesPlace = useMemo(
    () => ({
      project: projectId,
      panel: "preferences" as const,
      reveal: () => setTab("preferences"),
    }),
    [projectId],
  );
  const capacityPlace = useMemo(
    () => ({
      project: projectId,
      panel: "capacity" as const,
      reveal: () => setTab("capacity"),
    }),
    [projectId],
  );
  const authorizationPlace = useMemo(
    () => ({
      project: projectId,
      panel: "authorization" as const,
      reveal: () => setTab("authorization"),
    }),
    [projectId],
  );
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
          <SettingsNavItem
            current={tab === "machines"}
            onClick={() => setTab("machines")}
          >
            机器
          </SettingsNavItem>
        </>
      }
    >
      <RequestFeedbackScope hidden={tab !== "capacity"}>
        <SettingPlaceContext.Provider value={capacityPlace}>
          <CapacitySettings
            client={client}
            projectId={projectId}
            hidden={tab !== "capacity"}
          />
        </SettingPlaceContext.Provider>
      </RequestFeedbackScope>
      {tab === "roles" && (
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
      {tab === "machines" && (
        <MachinesSettings
          key={projectId}
          client={client}
          projectId={projectId}
          revision={machineRevision}
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
        <SettingPlaceContext.Provider value={preferencesPlace}>
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
                description="只有你能修改；跨卡只读会扩大卡片读取范围，自动合并会让系统在无人确认时合并代码。"
              >
                <CrossCardReadSetting
                  key={`cross-card-read:${projectId}`}
                  enabled={data.cross_card_read !== false}
                  {...common}
                />
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
                  minutes={data.auto_merge_after_minutes}
                  gate={data.merge_gate_enabled}
                  {...common}
                />
              </SettingsGroup>
            )}
          </SettingsPanel>
        </SettingPlaceContext.Provider>
      </RequestFeedbackScope>
      <RequestFeedbackScope hidden={tab !== "authorization"}>
        <SettingPlaceContext.Provider value={authorizationPlace}>
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
                原先保存的值不再控制新流程；审核用尽自动加轮，连续第 3 次驳回交
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
        </SettingPlaceContext.Provider>
      </RequestFeedbackScope>
    </SettingsLayout>
  );
}

interface SettingProps {
  client: CardiganClient;
  projectId: string;
  saved: () => void;
  /** The preferences read that produced this setting's props. */
  source: PreferencesView | undefined;
}

/** Integer setting saved on blur or Enter. */
function useNumberSetting({
  name,
  initial,
  min,
  max,
  write,
  saved,
  source,
}: {
  name: string;
  initial: number;
  min: number;
  max: number;
  write: (value: number, key: string) => Promise<void>;
  saved: () => void;
  source: unknown;
}) {
  const setting = useSettingWrite({
    name,
    server: initial,
    source,
    write,
    saved,
    success: () => "偏好已保存",
  });
  const draft = useNumberDraft(setting.value, min, max);
  return {
    ...setting,
    ...draft,
    setDraft: (value: string) => {
      draft.setDraft(value);
      setting.clear();
    },
    commit: () => draft.commit(setting.save),
  };
}

/** Enabling writes the chosen minutes in the same request (C-455 review). */
function TimeoutMergeSetting({
  minutes: serverMinutes,
  gate,
  client,
  projectId,
  saved,
  source,
}: SettingProps & {
  minutes: number | null | undefined;
  gate: boolean | undefined;
}) {
  const id = useId();
  const setting = useSettingWrite<number | null>({
    name: "超时自动合并",
    failure: (value) =>
      value === null ? "未能关闭“超时自动合并”" : "未能保存“超时自动合并”",
    server: serverMinutes ?? null,
    source,
    write: (value, key) => client.setPreferences(projectId, value, key),
    saved,
    success: (value) => (value === null ? "已关闭超时自动合并" : "偏好已保存"),
  });
  const enabled = setting.value !== null;
  const [lastMinutes, setLastMinutes] = useState(setting.value ?? 10);
  if (setting.value !== null && setting.value !== lastMinutes)
    setLastMinutes(setting.value);
  const minutes = useNumberDraft(lastMinutes, 1, 1440);
  // A blur caused by pressing the switch (mouse, pen or touch tap) leaves the
  // decision to the switch. The press ends when the switch toggles, a new
  // pointer press starts elsewhere, the gesture is cancelled, or the minutes
  // field is focused or edited again, so it never affects later edits.
  const pressing = useRef(false);
  const skipBlur = useRef(false);
  const switchRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const press = (event: PointerEvent) => {
      if (!switchRef.current?.contains(event.target as Node))
        pressing.current = false;
    };
    const cancel = () => {
      pressing.current = false;
    };
    window.addEventListener("pointerdown", press, true);
    window.addEventListener("pointercancel", cancel, true);
    return () => {
      window.removeEventListener("pointerdown", press, true);
      window.removeEventListener("pointercancel", cancel, true);
    };
  }, []);
  const toggle = (next: boolean) => {
    pressing.current = false;
    // While saving the switch is aria-disabled: the press changes nothing.
    if (setting.busy) return;
    // The switch decides: turning off drops the unsaved minutes as a pending
    // commit (they stay visible for a later activation); turning on writes them.
    minutes.settle();
    if (!next) return setting.save(null);
    if (minutes.valid) return setting.save(Number(minutes.draft));
  };
  return (
    <>
      <SettingsRow
        label="超时自动合并"
        labelId={`${id}-label`}
        description="合并确认无人处理且没有其他阻塞时，按等待时间自动代批。"
        descriptionId={`${id}-help`}
        warning={
          gate
            ? undefined
            : "没有合并闸门时，自动合并会合并未经全量测试和 e2e 的代码"
        }
      >
        <Switch
          checked={enabled}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-help`}
          ref={switchRef}
          aria-disabled={setting.busy}
          onPointerDown={() => {
            pressing.current = true;
          }}
          onCheckedChange={toggle}
        />
      </SettingsRow>
      <SettingsRow label="等待分钟数" htmlFor={`${id}-minutes`}>
        <SettingsNumberField
          id={`${id}-minutes`}
          unit="分钟"
          dirty={enabled && minutes.dirty}
          invalid={!minutes.valid}
          min="1"
          max="1440"
          value={minutes.draft}
          readOnly={setting.busy}
          onFocus={() => {
            pressing.current = false;
          }}
          onChange={(e) => {
            pressing.current = false;
            minutes.setDraft(e.target.value);
            setting.clear();
          }}
          onBlur={() => {
            skipBlur.current = pressing.current;
          }}
          onKeyDown={() => {
            pressing.current = false;
            skipBlur.current = false;
          }}
          onCommit={() => {
            if (skipBlur.current) {
              skipBlur.current = false;
              return;
            }
            if (enabled) minutes.commit(setting.save);
          }}
        />
      </SettingsRow>
      <RequestFeedback
        error={minutes.valid ? undefined : "请输入 1 到 1440 的整数分钟。"}
      />
      <RequestFeedback
        interactive
        pending={setting.saving}
        pendingMessage="保存中…"
        error={setting.error}
        message={setting.message}
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
  source,
}: SettingProps & {
  kind: "review" | "independent";
  initial: number;
  ceiling: number;
}) {
  const id = useId();
  const independent = kind === "independent";
  const label = independent ? "独立复核轮数上限" : "普通审核轮数上限";
  const setting = useNumberSetting({
    name: label,
    initial,
    min: 1,
    max: ceiling,
    write: (value, key) =>
      client.setReviewMaxRounds(projectId, kind, value, key),
    saved,
    source,
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
        pending={setting.saving}
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
  source,
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
    name: label,
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
    source,
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
        pending={setting.saving}
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
  source,
}: SettingProps & { enabled: boolean }) {
  const id = useId();
  const setting = useSettingWrite({
    name: "合并由 PM 代确认",
    failure: toggleFailure("合并由 PM 代确认"),
    server: enabled,
    source,
    write: (next, key) => client.setPmMergeConfirmation(projectId, next, key),
    saved,
    success: (next) => (next ? "已开启 PM 代确认" : "已关闭 PM 代确认"),
  });
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
            status={setting.value ? "active" : "waiting_decision"}
            label={setting.value ? "由 PM 代确认" : "PM 代确认已关闭"}
          />
        </span>
      }
    >
      <Switch
        checked={setting.value}
        aria-disabled={setting.busy}
        aria-labelledby={`${id}-label ${id}-status`}
        aria-describedby={`${id}-help`}
        onCheckedChange={setting.save}
      />
      <RequestFeedback
        interactive
        pending={setting.saving}
        pendingMessage="保存合并授权中…"
        error={setting.error}
        message={setting.message}
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
  source,
}: SettingProps & { category: string; label: string; enabled: boolean }) {
  const id = useId();
  const setting = useSettingWrite({
    name: label,
    failure: (next) =>
      next ? `未能开启“${label}”授权` : `未能撤销“${label}”授权`,
    server: enabled,
    source,
    write: (next, key) => client.setDelegation(projectId, category, next, key),
    saved,
    success: (next) =>
      next ? `${label}：已授权 PM 代拍` : `${label}：已改为由人拍板`,
  });
  return (
    <SettingsRow
      label={label}
      labelId={`${id}-label`}
      status={
        <span id={`${id}-status`}>
          <StatusTag
            status={setting.value ? "active" : "waiting_decision"}
            label={setting.value ? "由 PM 代拍" : "由人拍板"}
          />
        </span>
      }
    >
      <Switch
        checked={setting.value}
        aria-disabled={setting.busy}
        aria-labelledby={`${id}-label ${id}-status`}
        onCheckedChange={setting.save}
      />
      <RequestFeedback
        interactive
        pending={setting.saving}
        pendingMessage="保存授权中…"
        error={setting.error}
        message={setting.message}
      />
    </SettingsRow>
  );
}

function AutoMergeSetting({
  pause = false,
  enabled,
  inherited = false,
  client,
  projectId,
  saved,
  source,
}: SettingProps & {
  pause?: boolean;
  enabled: boolean;
  inherited?: boolean;
}) {
  const id = useId();
  const title = pause ? "暂停自动合并" : "自动合并";
  const setting = useSettingWrite({
    name: title,
    failure: toggleFailure(title),
    server: enabled,
    source,
    // An inherited default is not a stored value and cannot confirm a write.
    confirmable: !inherited,
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
        <Button
          aria-disabled={setting.busy}
          onClick={() => setting.save(false)}
        >
          关闭自动合并
        </Button>
      )}
      <Switch
        checked={setting.value}
        aria-disabled={setting.busy}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-help`}
        onCheckedChange={setting.save}
      />
      <RequestFeedback
        interactive
        pending={setting.saving}
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
  source,
}: SettingProps & { enabled: boolean }) {
  const id = useId();
  const setting = useSettingWrite({
    name: "跨卡只读",
    failure: toggleFailure("跨卡只读"),
    server: enabled,
    source,
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
        checked={setting.value}
        aria-disabled={setting.busy}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-help`}
        onCheckedChange={setting.save}
      />
      <RequestFeedback
        interactive
        pending={setting.saving}
        pendingMessage="正在保存跨卡只读偏好…"
        error={setting.error}
        message={setting.message}
      />
    </SettingsRow>
  );
}
