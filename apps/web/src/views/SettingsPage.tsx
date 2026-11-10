import { useCallback, useRef, useState } from "react";
import {
  type CardiganClient,
  describeWriteError,
  type PreferencesView,
} from "../api.js";
import { PageTitle, StatusTag } from "../components/Foundation.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import {
  categoryLabels,
  defaultDelegation,
  delegableCategories,
} from "../decision-labels.js";
import { useResource } from "../useResource.js";
import { RolesSettings } from "./RolesSettings.js";
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
    "preferences" | "authorization" | "roles" | "templates"
  >("preferences");
  const load = useCallback(
    () => client.preferences(projectId),
    [client, projectId],
  );
  const resource = useResource(load, revision);
  return (
    <>
      <PageTitle
        title="设置"
        description="管理当前项目的偏好、授权、角色和卡片模板。"
      />
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
        </nav>
        {tab === "roles" && (
          <section id="roles" tabIndex={-1} aria-labelledby="roles-title">
            <h2 id="roles-title">角色</h2>
            <RolesSettings
              key={projectId}
              client={client}
              projectId={projectId}
              revision={revision}
            />
          </section>
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
        <div hidden={tab === "templates" || tab === "roles"}>
          <section
            hidden={tab !== "preferences"}
            id="preferences"
            tabIndex={-1}
            aria-labelledby="preferences-title"
          >
            <h2 id="preferences-title">偏好</h2>
            {resource.data && (
              <PreferenceForm
                key={String(resource.data.auto_merge_after_minutes)}
                initial={resource.data}
                client={client}
                projectId={projectId}
                saved={resource.reload}
              />
            )}
          </section>
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
      {error && <p role="alert">{error}</p>}
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
