import { useCallback, useRef, useState } from "react";
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
import {
  categoryLabels,
  defaultDelegation,
  delegableCategories,
} from "../decision-labels.js";
import { employeeCopy } from "../employee-copy.js";
import { useResource } from "../useResource.js";
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
  const [tab, setTab] = useState<
    "preferences" | "authorization" | "roles" | "templates" | "employees"
  >("preferences");
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
        <div
          hidden={tab === "templates" || tab === "roles" || tab === "employees"}
        >
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
              {resource.data && (
                <PmMergeSetting
                  key={`pm-merge:${resource.data.pm_merge_confirmation}`}
                  enabled={resource.data.pm_merge_confirmation !== false}
                  client={client}
                  projectId={projectId}
                  saved={resource.reload}
                />
              )}
              {resource.data &&
                Object.entries(categoryLabels).map(([category, label]) => (
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
          label={enabled ? "由 PM 代确认" : "由人确认"}
        />
      </label>
      <p className="hint">
        默认开启。PM 只有在合并闸门检查、全部验证通过且没有未处理的 must_fix
        时才能确认合并；涉及花钱、账号、权限、删除数据或需求范围变化的卡片始终由你确认。关闭后由你确认，超时自动合并作为兜底。
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
  const fixed = !delegableCategories.includes(category);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const sending = useRef(false),
    key = useRef<string | undefined>(undefined);
  return (
    <div>
      <label>
        <input
          type="checkbox"
          checked={!fixed && enabled}
          disabled={fixed || busy}
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
          status={!fixed && enabled ? "active" : "waiting_decision"}
          label={
            fixed
              ? "固定由人确认（Workbench 或本机 CLI）"
              : enabled
                ? "由 PM 代拍"
                : "由人拍板"
          }
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
