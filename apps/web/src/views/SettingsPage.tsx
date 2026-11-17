import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CardiganClient,
  describeWriteError,
  type PreferencesView,
} from "../api.js";
import { PageTitle, StatusTag } from "../components/Foundation.js";
import {
  RequestFeedback,
  RequestFeedbackScope,
} from "../components/RequestFeedback.js";
import { categoryLabels, defaultDelegation } from "../decision-labels.js";
import { employeeCopy } from "../employee-copy.js";
import { useRouteFilters } from "../route.js";
import { useResource } from "../useResource.js";
import { CapacitySettings } from "./CapacitySettings.js";
import { EmployeesSettings } from "./EmployeesSettings.js";
import { RolesSettings } from "./RolesSettings.js";
import { SystemRulesSettings } from "./SystemRulesSettings.js";
import { TemplateSettings } from "./TemplateSettings.js";

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
  // The review round ceiling comes only from the server (domain, Q-420).
  const roundsCeiling = resource.data?.review_max_rounds_ceiling;
  return (
    <>
      <PageTitle title="设置" description={employeeCopy.settingsDescription} />
      <div className="settings-layout">
        <nav aria-label="设置分栏">
          <button
            type="button"
            onClick={() => {
              setTab("preferences");
            }}
            aria-current={tab === "preferences" ? "page" : undefined}
          >
            偏好
          </button>
          <button
            type="button"
            onClick={() => setTab("capacity")}
            aria-current={tab === "capacity" ? "page" : undefined}
          >
            并发与容量
          </button>
          <button
            type="button"
            onClick={() => setTab("authorization")}
            aria-current={tab === "authorization" ? "page" : undefined}
          >
            授权
          </button>
          <button
            type="button"
            aria-current={tab === "roles" ? "page" : undefined}
            onClick={() => {
              setTab("roles");
              requestAnimationFrame(() =>
                document.getElementById("roles")?.focus(),
              );
            }}
          >
            角色
          </button>
          <button
            type="button"
            aria-current={tab === "templates" ? "page" : undefined}
            onClick={() => setTab("templates")}
          >
            卡片模板
          </button>
          <button
            type="button"
            aria-current={tab === "employees" ? "page" : undefined}
            onClick={() => {
              setEmployeeRole("");
              setTab("employees");
            }}
          >
            {employeeCopy.tab}
          </button>
        </nav>
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
        <div hidden={tab !== "preferences" && tab !== "authorization"}>
          <RequestFeedbackScope hidden={tab !== "preferences"}>
            <section
              hidden={tab !== "preferences"}
              id="preferences"
              tabIndex={-1}
              aria-labelledby="preferences-title"
            >
              <h2 id="preferences-title">偏好</h2>
              {resource.data && (
                <SystemRulesSettings
                  key={`${projectId}:${JSON.stringify([resource.data.system_auto_assign_verifiers, resource.data.system_reminders, resource.data.system_reminder_policy])}`}
                  initial={resource.data}
                  client={client}
                  projectId={projectId}
                  saved={resource.reload}
                />
              )}
              {resource.data && (
                <CrossCardReadSetting
                  key={`cross-card-read:${projectId}`}
                  enabled={resource.data.cross_card_read !== false}
                  client={client}
                  projectId={projectId}
                  saved={resource.reload}
                />
              )}
              {resource.data && (
                <AutoMergeSetting
                  key={`auto-merge:${projectId}`}
                  enabled={
                    resource.data.auto_merge === "on" ||
                    (resource.data.auto_merge === undefined &&
                      (resource.data.flow_version ?? 1) >= 4)
                  }
                  inherited={resource.data.auto_merge === undefined}
                  client={client}
                  projectId={projectId}
                  saved={resource.reload}
                />
              )}
              {resource.data && (
                <AutoMergeSetting
                  pause
                  key={`auto-pause:${projectId}`}
                  enabled={resource.data.auto_merge_paused === true}
                  client={client}
                  projectId={projectId}
                  saved={resource.reload}
                />
              )}
              {resource.data && (
                <PreferenceForm
                  key={String(resource.data.auto_merge_after_minutes)}
                  initial={resource.data}
                  client={client}
                  projectId={projectId}
                  saved={resource.reload}
                />
              )}
              {resource.data && (
                <MergeMinutesSetting
                  kind="stall"
                  key={`stall:${resource.data.merge_confirm_stall_after_minutes}`}
                  initial={
                    resource.data.merge_confirm_stall_after_minutes ?? 60
                  }
                  client={client}
                  projectId={projectId}
                  saved={resource.reload}
                />
              )}
              {resource.data && (
                <MergeMinutesSetting
                  kind="snooze"
                  key={`snooze:${resource.data.merge_confirm_snooze_default_minutes}`}
                  initial={
                    resource.data.merge_confirm_snooze_default_minutes ?? 240
                  }
                  client={client}
                  projectId={projectId}
                  saved={resource.reload}
                />
              )}
              {resource.data && (
                <MergeMinutesSetting
                  kind="snooze-max"
                  key={`snooze-max:${resource.data.merge_confirm_snooze_max_minutes}`}
                  initial={
                    resource.data.merge_confirm_snooze_max_minutes ?? 4320
                  }
                  client={client}
                  projectId={projectId}
                  saved={resource.reload}
                />
              )}
              {roundsCeiling !== undefined &&
                (["review", "independent"] as const).map((kind) => {
                  const initial =
                    kind === "review"
                      ? (resource.data?.review_max_rounds ?? 5)
                      : (resource.data?.independent_review_max_rounds ?? 3);
                  return (
                    <ReviewRoundsSetting
                      kind={kind}
                      key={`${kind}-rounds:${initial}`}
                      initial={initial}
                      ceiling={roundsCeiling}
                      client={client}
                      projectId={projectId}
                      saved={resource.reload}
                    />
                  );
                })}
            </section>
          </RequestFeedbackScope>
          <RequestFeedbackScope hidden={tab !== "authorization"}>
            <section
              hidden={tab !== "authorization"}
              id="authorization"
              tabIndex={-1}
              aria-labelledby="authorization-title"
            >
              <h2 id="authorization-title">授权</h2>
              <p>
                PM 代拍时必须写明理由并保留授权依据。没有活跃 PM Ops
                时交给你。代拍和代确认的合并都会在 Needs You 的知会区同步给你。
              </p>
              <p className="hint">
                Flow Lite 已停用“人已拍板的改动由 PM 核对后确认合并”、
                “已拍角色正文由 PM 代确认”和“独立复核加轮授权”旧开关，
                原先保存的值不再控制新流程。审核用尽自动加轮，连续第 4 次驳回交
                PM。
              </p>
              <p className="hint">
                收回默认交人事项的授权，请关闭下方相应类别开关；
                停止系统自动合并，请在偏好中关闭“自动合并”（未设置时也可直接关闭），或开启“暂停自动合并”。
              </p>
              {resource.data && (
                <PmMergeSetting
                  key={`pm-merge:${resource.data.pm_merge_confirmation}`}
                  enabled={resource.data.pm_merge_confirmation !== false}
                  client={client}
                  projectId={projectId}
                  saved={resource.reload}
                />
              )}
              <section
                className="decision-delegation-settings"
                aria-labelledby="decision-delegation-title"
              >
                <h3 id="decision-delegation-title">按决定类别常驻授权</h3>
                <p className="hint">
                  {
                    "花钱、凭据和账号、删除数据、对外发布及敏感卡默认交你处理，只有你能逐类开启授权。授权覆盖 PM 拍板与合并确认；开启自动合并后也允许系统合并。授权不增加执行能力。"
                  }
                </p>
                {resource.data &&
                  Object.entries({
                    ...categoryLabels,
                    sensitive: "人标记的敏感卡",
                  }).map(([category, label]) => (
                    <DelegationSetting
                      key={`${category}:${resource.data?.decision_delegation?.[category]}`}
                      category={category}
                      label={label}
                      enabled={
                        resource.data?.decision_delegation?.[category] ??
                        defaultDelegation[category] ??
                        false
                      }
                      client={client}
                      projectId={projectId}
                      saved={resource.reload}
                    />
                  ))}
              </section>
            </section>
          </RequestFeedbackScope>
        </div>
      </div>
    </>
  );
}

function PreferenceForm({
  initial,
  client,
  projectId,
  saved,
}: {
  initial: PreferencesView;
  client: CardiganClient;
  projectId: string;
  saved: () => void;
}) {
  const [enabled, setEnabled] = useState(
    initial.auto_merge_after_minutes !== null,
  );
  const [minutes, setMinutes] = useState(
    String(initial.auto_merge_after_minutes ?? 10),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const sending = useRef(false),
    keys = useRef(new Map<string, string>());
  const valid =
    !enabled ||
    (/^\d+$/.test(minutes) && Number(minutes) >= 1 && Number(minutes) <= 1440);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (sending.current || !valid) return;
        sending.current = true;
        setBusy(true);
        setError("");
        setMessage("");
        const value = enabled ? Number(minutes) : null,
          input = JSON.stringify(value);
        const key = keys.current.get(input) ?? crypto.randomUUID();
        keys.current.set(input, key);
        try {
          await client.setPreferences(projectId, value, key);
          keys.current.delete(input);
          setMessage("偏好已保存");
          saved();
        } catch (cause) {
          setError(describeWriteError(cause));
        } finally {
          sending.current = false;
          setBusy(false);
        }
      }}
    >
      <label>
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        超时自动合并
      </label>
      {!initial.merge_gate_enabled && (
        <p className="error-panel">
          没有合并闸门时，自动合并会合并未经全量测试和 e2e 的代码
        </p>
      )}
      <p className="hint">
        默认关闭。开启后，合并确认无人处理且没有其他阻塞时，按等待时间自动代批。
      </p>
      <label>
        等待分钟数
        <input
          type="number"
          min="1"
          max="1440"
          step="1"
          value={minutes}
          disabled={!enabled || busy}
          onChange={(e) => setMinutes(e.target.value)}
        />
      </label>
      <RequestFeedback
        error={!valid ? "请输入 1 到 1440 的整数分钟。" : undefined}
      />
      <button type="submit" disabled={busy || !valid}>
        保存偏好
      </button>
      <RequestFeedback
        interactive
        pending={busy}
        pendingMessage="保存中…"
        error={error}
        message={message}
      />
    </form>
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
}: {
  kind: "review" | "independent";
  initial: number;
  ceiling: number;
  client: CardiganClient;
  projectId: string;
  saved: () => void;
}) {
  const independent = kind === "independent";
  const label = independent ? "独立复核轮数上限" : "普通审核轮数上限";
  const [rounds, setRounds] = useState(String(initial));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const sending = useRef(false),
    keys = useRef(new Map<string, string>());
  const valid =
    /^\d+$/.test(rounds) && Number(rounds) >= 1 && Number(rounds) <= ceiling;
  return (
    <form
      aria-label={label}
      onSubmit={async (event) => {
        event.preventDefault();
        if (sending.current || !valid) return;
        sending.current = true;
        setBusy(true);
        setError("");
        setMessage("");
        const key = keys.current.get(rounds) ?? crypto.randomUUID();
        keys.current.set(rounds, key);
        try {
          await client.setReviewMaxRounds(projectId, kind, Number(rounds), key);
          keys.current.delete(rounds);
          setMessage("偏好已保存");
          saved();
        } catch (cause) {
          setError(describeWriteError(cause));
        } finally {
          sending.current = false;
          setBusy(false);
        }
      }}
    >
      <label>
        {label}（轮）
        <input
          type="number"
          min={1}
          max={ceiling}
          step="1"
          value={rounds}
          disabled={busy}
          onChange={(e) => setRounds(e.target.value)}
        />
      </label>
      <p className="hint">
        {independent
          ? `默认 3 轮，可设为 1 到 ${ceiling} 轮。独立复核连续这么多轮未通过就交给你；PM 不能把单个复核项放宽到超过这个值。`
          : `默认 5 轮，可设为 1 到 ${ceiling} 轮。审核连续这么多轮未通过就暂停，等待拍板是否加轮。`}
        只影响之后新建的审核项，已有审核项保留创建时的轮数。
      </p>
      <RequestFeedback
        error={!valid ? `请输入 1 到 ${ceiling} 的整数轮数。` : undefined}
      />
      <button type="submit" disabled={busy || !valid}>
        {independent ? "保存独立复核轮数" : "保存审核轮数"}
      </button>
      <RequestFeedback
        interactive
        pending={busy}
        pendingMessage="保存中…"
        error={error}
        message={message}
      />
    </form>
  );
}

/** C-177: wording set by PM Ops per Q-279 (C-177#7). */
function MergeMinutesSetting({
  kind,
  initial,
  client,
  projectId,
  saved,
}: {
  kind: "stall" | "snooze" | "snooze-max";
  initial: number;
  client: CardiganClient;
  projectId: string;
  saved: () => void;
}) {
  const snooze = kind === "snooze";
  const snoozeMax = kind === "snooze-max";
  const label = snoozeMax
    ? "合并确认最长暂缓时长"
    : snooze
      ? "合并确认默认暂缓时长"
      : "PM 合并确认停留告警";
  const min = snoozeMax ? 60 : 1;
  const max = snoozeMax ? 10080 : 1440;
  const [minutes, setMinutes] = useState(String(initial));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const sending = useRef(false),
    keys = useRef(new Map<string, string>());
  const valid =
    /^\d+$/.test(minutes) && Number(minutes) >= min && Number(minutes) <= max;
  return (
    <form
      aria-label={label}
      onSubmit={async (event) => {
        event.preventDefault();
        if (sending.current || !valid) return;
        sending.current = true;
        setBusy(true);
        setError("");
        setMessage("");
        const key = keys.current.get(minutes) ?? crypto.randomUUID();
        keys.current.set(minutes, key);
        try {
          if (snoozeMax)
            await client.setMergeConfirmSnoozeMax(
              projectId,
              Number(minutes),
              key,
            );
          else if (snooze)
            await client.setMergeConfirmSnoozeDefault(
              projectId,
              Number(minutes),
              key,
            );
          else
            await client.setMergeConfirmStallAfter(
              projectId,
              Number(minutes),
              key,
            );
          keys.current.delete(minutes);
          setMessage("偏好已保存");
          saved();
        } catch (cause) {
          setError(describeWriteError(cause));
        } finally {
          sending.current = false;
          setBusy(false);
        }
      }}
    >
      <label>
        {label}（分钟）
        <input
          type="number"
          min={min}
          max={max}
          step="1"
          value={minutes}
          disabled={busy}
          onChange={(e) => setMinutes(e.target.value)}
        />
      </label>
      <p className="hint">
        {snoozeMax
          ? "默认 4320 分钟（72 小时），可设为 60 到 10080 分钟。同一合并确认从首次暂缓开始累计计时，续期或到期后再次暂缓不能超过上限；达到上限后请交人或处理确认。"
          : snooze
            ? "PM 或人暂缓一条合并确认时，没有填到期时间就用这个时长，到期后自动放回待处理"
            : "PM 持有的合并确认在合并检查出结论后，超过这么久还没处理，就提醒 PM Ops，并在 Needs You 知会人"}
      </p>
      <RequestFeedback
        error={!valid ? `请输入 ${min} 到 ${max} 的整数分钟。` : undefined}
      />
      <button type="submit" disabled={busy || !valid}>
        {snoozeMax ? "保存暂缓上限" : snooze ? "保存暂缓时长" : "保存停留告警"}
      </button>
      <RequestFeedback
        interactive
        pending={busy}
        pendingMessage="保存中…"
        error={error}
        message={message}
      />
    </form>
  );
}

function PmMergeSetting({
  enabled,
  client,
  projectId,
  saved,
}: {
  enabled: boolean;
  client: CardiganClient;
  projectId: string;
  saved: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const sending = useRef(false),
    key = useRef<string | undefined>(undefined);
  return (
    <div>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={async (e) => {
            if (sending.current) return;
            const next = e.target.checked;
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
        合并由 PM 代确认：
        <StatusTag
          status={enabled ? "active" : "waiting_decision"}
          label={enabled ? "由 PM 代确认" : "PM 代确认已关闭"}
        />
      </label>
      <p className="hint">
        默认开启。PM 只有在合并检查、全部验证通过且没有待修问题时才能确认合并。
        五类默认交人事项按你的逐类授权处理。此开关只控制 PM
        代确认；系统自动合并由偏好中的“自动合并”和“暂停自动合并”单独控制。
      </p>
      <RequestFeedback
        interactive
        pending={busy}
        pendingMessage="保存合并授权中…"
        error={error}
      />
    </div>
  );
}

function DelegationSetting({
  category,
  label,
  enabled,
  client,
  projectId,
  saved,
}: {
  category: string;
  label: string;
  enabled: boolean;
  client: CardiganClient;
  projectId: string;
  saved: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const sending = useRef(false),
    key = useRef<string | undefined>(undefined);
  return (
    <div>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={async (e) => {
            if (sending.current) return;
            const next = e.target.checked;
            sending.current = true;
            setBusy(true);
            setError("");
            key.current ??= crypto.randomUUID();
            try {
              await client.setDelegation(
                projectId,
                category,
                next,
                key.current,
              );
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
        {label}：
        <StatusTag
          status={enabled ? "active" : "waiting_decision"}
          label={enabled ? "由 PM 代拍" : "由人拍板"}
        />
      </label>
      <RequestFeedback
        interactive
        pending={busy}
        pendingMessage="保存授权中…"
        error={error}
      />
    </div>
  );
}

function AutoMergeSetting({
  pause = false,
  enabled,
  inherited = false,
  client,
  projectId,
  saved,
}: {
  pause?: boolean;
  enabled: boolean;
  inherited?: boolean;
  client: CardiganClient;
  projectId: string;
  saved: () => void;
}) {
  const title = pause ? "暂停自动合并" : "自动合并";
  const prefix = pause ? "auto-merge-pause" : "auto-merge";
  const status = pause
    ? enabled
      ? "已暂停"
      : "未暂停"
    : inherited
      ? enabled
        ? "未设置，按流程级别由系统合并"
        : "未设置，按各卡流程级别处理"
      : enabled
        ? "已开启"
        : "已关闭";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
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
    if (!inherited && pending.current?.value === enabled) {
      pending.current = undefined;
      setError("");
    }
  }, [enabled, inherited]);
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
      if (pause) await client.setAutoMergePaused(projectId, next, key);
      else await client.setAutoMerge(projectId, next, key);
      if (!mounted.current) return;
      if (pending.current?.key === key) pending.current = undefined;
      saved();
      setMessage(
        pause
          ? next
            ? "已暂停自动合并"
            : "已恢复自动合并"
          : next
            ? "已开启自动合并"
            : "已关闭自动合并",
      );
    } catch (cause) {
      if (mounted.current) setError(describeWriteError(cause));
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section
      className={`${prefix}-setting`}
      aria-labelledby={`${prefix}-title`}
    >
      <h3 id={`${prefix}-title`}>{title}</h3>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          disabled={!pause && busy}
          aria-disabled={pause ? busy : undefined}
          aria-describedby={`${prefix}-help`}
          onChange={(event) => save(event.target.checked)}
        />
        {title}
        <span>{status}</span>
      </label>
      {!pause && inherited && (
        <button type="button" disabled={busy} onClick={() => save(false)}>
          关闭自动合并
        </button>
      )}
      <p className="hint" id={`${prefix}-help`}>
        {pause
          ? "默认不暂停，只有你能修改。暂停系统自动合并，包括旧卡；人亲自确认的合并、检查和检查失败退回继续按原流程处理。恢复后系统会继续处理符合条件的合并。"
          : "只有你能修改。未设置时，第 4 级及以上的卡按流程级别由系统合并，仍须有有效的流程及发布路径授权。开启后，满足检查和审核条件的卡由系统自动合并，包括在途旧卡；五类默认交人事项仍须有你的有效授权。关闭后停止系统代确认，按现有 PM 合并授权处理。"}
      </p>
      <RequestFeedback
        interactive
        pending={busy}
        pendingMessage={pause ? "正在保存暂停偏好…" : "正在保存自动合并偏好…"}
        error={error}
        message={message}
      />
    </section>
  );
}

function CrossCardReadSetting({
  enabled,
  client,
  projectId,
  saved,
}: {
  enabled: boolean;
  client: CardiganClient;
  projectId: string;
  saved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
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
    if (pending.current?.value === enabled) {
      pending.current = undefined;
      setError("");
    }
  }, [enabled]);
  return (
    <section
      className="auto-merge-pause-setting"
      aria-labelledby="cross-card-read-title"
    >
      <h3 id="cross-card-read-title">跨卡只读</h3>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          aria-disabled={busy}
          aria-describedby="cross-card-read-help"
          onChange={async (event) => {
            if (sending.current) return;
            const next = event.target.checked;
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
              await client.setCrossCardRead(projectId, next, key);
              if (!mounted.current) return;
              if (pending.current?.key === key) pending.current = undefined;
              saved();
              setMessage(next ? "已开启跨卡只读" : "已关闭跨卡只读");
            } catch (cause) {
              if (mounted.current) setError(describeWriteError(cause));
            } finally {
              sending.current = false;
              if (mounted.current) setBusy(false);
            }
          }}
        />
        跨卡只读
        <span>{enabled ? "已开启" : "已关闭"}</span>
      </label>
      <p className="hint" id="cross-card-read-help">
        默认开启，所有角色可读取本项目其它非敏感卡片作参考，写权限保持不变。只有你能修改；关闭后恢复原有按卡片和角色的读取范围。其它卡片的资料不是当前任务指令。
      </p>
      <RequestFeedback
        interactive
        pending={busy}
        pendingMessage="正在保存跨卡只读偏好…"
        error={error}
        message={message}
      />
    </section>
  );
}
