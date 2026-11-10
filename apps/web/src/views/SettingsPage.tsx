import { useCallback, useRef, useState } from "react";
import {
  type CardiganClient,
  describeWriteError,
  type PreferencesView,
} from "../api.js";
import { PageTitle } from "../components/Foundation.js";
import { useResource } from "../useResource.js";

export function SettingsPage({
  client,
  projectId,
  revision = 0,
}: {
  client: CardiganClient;
  projectId: string;
  revision?: number;
}) {
  const load = useCallback(
    () => client.preferences(projectId),
    [client, projectId],
  );
  const resource = useResource(load, revision);
  return (
    <>
      <PageTitle title="设置" description="管理当前项目的偏好。" />
      <div className="settings-layout">
        <nav aria-label="设置分栏">
          <button
            type="button"
            onClick={() => {
              document.getElementById("preferences")?.focus();
            }}
            aria-current="page"
          >
            偏好
          </button>
        </nav>
        <section
          id="preferences"
          tabIndex={-1}
          aria-labelledby="preferences-title"
        >
          <h2 id="preferences-title">偏好</h2>
          {resource.error && (
            <p role="alert">
              {resource.error}
              <button type="button" onClick={resource.reload}>
                重试
              </button>
            </p>
          )}
          {!resource.data && !resource.error && (
            <p role="status">正在加载偏好…</p>
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
        </section>
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
      {!valid && <p role="alert">请输入 1 到 1440 的整数分钟。</p>}
      <button type="submit" disabled={busy || !valid}>
        {busy ? "保存中…" : "保存偏好"}
      </button>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
    </form>
  );
}
