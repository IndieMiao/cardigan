import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  type CardiganClient,
  FEISHU_SECRET_KEYS,
  type FeishuSecretKey,
  type FeishuSettingsChange,
  type FeishuSettingsPreview,
  type FeishuSettingsView,
} from "../api.js";
import { Drawer } from "../components/Drawer.js";
import { StatusTag, Time } from "../components/Foundation.js";
import { CardDetailLayout } from "../components/layout/CardDetailLayout.js";
import {
  SettingsDialogActions,
  SettingsDialogFields,
  SettingsDiff,
  SettingsFact,
  SettingsFacts,
  SettingsField,
  SettingsSection,
  SettingsWarning,
  settingsDrawerClassName,
  useDiscardGuard,
} from "../components/layout/SettingsLayout.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Switch } from "../components/ui/switch.js";
import {
  buildChange,
  type DraftField,
  type DraftSwitch,
  diffLabel,
  draftFields,
  draftFrom,
  type FeishuDraft,
  formatSecretDiff,
  formatValue,
  maskedFields,
  netEdits,
  provedNotWritten,
  SECRET_LABELS,
  STALE,
  saveProblem,
} from "./feishu-config.js";

type SecretValues = Partial<Record<FeishuSecretKey, string>>;
type Edited = DraftField | DraftSwitch;

/** A confirmation whose outcome could not be verified. */
const UNSETTLED =
  "无法确认是否已保存，凭据输入框已清空。请刷新后核对当前配置和凭据修改时间，再决定是否重新填写。";
const UNSETTLED_PLAIN = "无法确认是否已保存，请刷新后核对当前配置。";

/**
 * C-561: the Feishu bot settings in one drawer form. Nothing is written until
 * the person has seen the server's diff and confirmed it. Credential values
 * live only in this component's state: never in the preview, a message, the
 * draft kept for a retry, or storage.
 */
export function FeishuConfigEditor({
  client,
  view,
  reread,
  onSaved,
  onClose,
  hidden = false,
}: {
  client: CardiganClient;
  view: FeishuSettingsView;
  /**
   * The Feishu panel is not shown (another settings tab, e.g. after the
   * browser went back): the drawer steps aside and keeps the draft until the
   * panel is shown again; closing the tab still asks while it is unconfirmed.
   */
  hidden?: boolean;
  /** Read the settings again through the page's ordered reader. */
  reread: () => Promise<FeishuSettingsView>;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [base, setBase] = useState(view);
  const [draft, setDraft] = useState(() => draftFrom(view));
  const [edited, setEdited] = useState<ReadonlySet<Edited>>(() => new Set());
  const [values, setValues] = useState<SecretValues>({});
  const [attempted, setAttempted] = useState(false);
  const [preview, setPreview] = useState<{
    change: FeishuSettingsChange;
    result: FeishuSettingsPreview;
  }>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  // Credential values were dropped after a failed save: retype them.
  const [dropped, setDropped] = useState(false);
  const sending = useRef(false);
  const keys = useRef(new Map<string, string>());
  const alive = useRef(true);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const built = buildChange(base, draft, values);
  const reviewing = preview !== undefined;
  const guard = useDiscardGuard(built.dirty || reviewing, onClose);
  const leave = () => {
    if (!sending.current) guard.confirmClose();
  };

  const run = async (work: () => Promise<void>) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setProblem(undefined);
    try {
      await work();
    } finally {
      sending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  /**
   * A newer read: the person's net edits against the read they started from
   * are replayed on it; everything else (also a value changed and changed
   * back) follows the new read, so another session's save is not undone.
   */
  const rebase = (next: FeishuSettingsView): FeishuDraft => {
    const fresh = draftFrom(next);
    const mine = netEdits(base, draft);
    const rebased: FeishuDraft = {
      switches: Object.fromEntries(
        Object.entries(fresh.switches).map(([k, v]) => [
          k,
          mine.has(k as DraftSwitch) ? draft.switches[k as DraftSwitch] : v,
        ]),
      ) as FeishuDraft["switches"],
      fields: Object.fromEntries(
        draftFields.map((f) => [
          f,
          mine.has(f) ? draft.fields[f] : fresh.fields[f],
        ]),
      ) as FeishuDraft["fields"],
      retyped: new Set(
        [...draft.retyped].filter((f) => maskedFields(next).includes(f)),
      ),
      secrets: draft.secrets,
    };
    setBase(next);
    setDraft(rebased);
    return rebased;
  };
  const tryReread = async () => {
    try {
      const next = await reread();
      if (alive.current) rebase(next);
      return next;
    } catch {
      return undefined;
    }
  };
  const requestPreview = (change: FeishuSettingsChange, version: string) =>
    client.previewFeishuSettings
      ? client.previewFeishuSettings(version, change)
      : Promise.reject(new Error("飞书配置服务不可用"));

  const start = () => {
    setAttempted(true);
    setDropped(false);
    const { change } = built;
    if (!change) {
      // Move to the first field to correct, in form order.
      form.current?.querySelector<HTMLElement>("[aria-invalid=true]")?.focus();
      return;
    }
    void run(async () => {
      try {
        const result = await requestPreview(change, base.version);
        if (alive.current) setPreview({ change, result });
      } catch (error) {
        if (alive.current) setProblem(saveProblem(error));
      }
    });
  };
  /** The read was stale: read again, then preview the same edits against it. */
  const refresh = () =>
    run(async () => {
      setPreview(undefined);
      let next: FeishuSettingsView;
      try {
        next = await reread();
      } catch {
        if (alive.current) setProblem(STALE);
        return;
      }
      if (!alive.current) return;
      const { change } = buildChange(next, rebase(next), values);
      if (!change) return;
      try {
        const result = await requestPreview(change, next.version);
        if (alive.current) setPreview({ change, result });
      } catch (error) {
        if (alive.current) setProblem(saveProblem(error));
      }
    });
  const confirm = () =>
    run(async () => {
      if (!preview || !client.confirmFeishuSettings) return;
      const { preview_id, version } = preview.result;
      const key = keys.current.get(preview_id) ?? crypto.randomUUID();
      keys.current.set(preview_id, key);
      const setKeys = preview.change.secrets?.set ?? [];
      const secrets = Object.fromEntries(
        setKeys.map((k) => [k, values[k] ?? ""]),
      );
      const withSecrets = setKeys.length > 0;
      try {
        await client.confirmFeishuSettings(
          version,
          preview_id,
          key,
          withSecrets ? secrets : undefined,
        );
        keys.current.delete(preview_id);
        if (alive.current) onSaved();
        return;
      } catch (error) {
        if (!alive.current) return;
        // Back to the form; credential values are never kept for a retry.
        setPreview(undefined);
        if (withSecrets) {
          setValues({});
          setDropped(true);
        }
        if (provedNotWritten(error)) {
          const next = saveProblem(error);
          setProblem(next);
          if (next === STALE) await tryReread();
          return;
        }
        if (withSecrets)
          try {
            // The reply was lost: ask again with the same key and no values.
            // A recorded receipt answers success; anything else stays unknown.
            await client.confirmFeishuSettings(version, preview_id, key);
            keys.current.delete(preview_id);
            if (alive.current) onSaved();
            return;
          } catch {
            if (!alive.current) return;
          }
        setProblem(withSecrets ? UNSETTLED : UNSETTLED_PLAIN);
        await tryReread();
      }
    });

  const setSwitch = (k: DraftSwitch, on: boolean) => {
    setEdited((old) => new Set(old).add(k));
    setDraft((old) => ({ ...old, switches: { ...old.switches, [k]: on } }));
  };
  const setField = (f: DraftField, text: string) => {
    setEdited((old) => new Set(old).add(f));
    setDraft((old) => ({
      ...old,
      fields: { ...old.fields, [f]: text },
      retyped: masked.includes(f) ? new Set(old.retyped).add(f) : old.retyped,
    }));
  };
  const setSecret = (k: FeishuSecretKey, mode: "replace" | "clear" | null) => {
    setValues((old) => {
      const { [k]: _drop, ...rest } = old;
      return rest;
    });
    setDraft((old) => {
      const { [k]: _old, ...rest } = old.secrets;
      return { ...old, secrets: mode ? { ...rest, [k]: mode } : rest };
    });
  };
  const masked = maskedFields(base);
  /** Diff values never repeat a credential being typed (defence in depth). */
  const typed = Object.values(values).filter((v): v is string => !!v);
  const safe = (text: string) =>
    typed.some((v) => text.includes(v)) ? "已隐藏" : text;
  const shown = (name: Edited | FeishuSecretKey) =>
    attempted ||
    edited.has(name as Edited) ||
    (name in values && values[name as FeishuSecretKey] !== "")
      ? built.problems[name as keyof typeof built.problems]
      : undefined;
  const notice =
    problem === STALE ? (
      <SettingsWarning role="alert">
        飞书配置已在别处修改，这次预览已作废，没有保存。
      </SettingsWarning>
    ) : problem ? (
      <SettingsWarning role="alert">{problem}</SettingsWarning>
    ) : null;
  const droppedNotice = dropped && problem !== UNSETTLED && (
    <SettingsWarning role="alert">
      凭据没有保存，输入框已清空，请重新填写。
    </SettingsWarning>
  );
  const refreshButton = problem === STALE && (
    <Button
      key="refresh"
      variant="primary"
      disabled={busy}
      onClick={(event) => {
        event.preventDefault();
        void refresh();
      }}
    >
      刷新并重新预览
    </Button>
  );

  const field = (
    f: DraftField,
    label: string,
    inputMode: "url" | "text" | "numeric" | "decimal" = "numeric",
  ) => (
    <SettingsField label={label} error={shown(f)}>
      {(props) => (
        <Input
          value={draft.fields[f]}
          autoComplete="off"
          spellCheck={false}
          inputMode={inputMode}
          disabled={busy}
          aria-invalid={props.invalid}
          aria-describedby={props.describedBy}
          onChange={(e) => setField(f, e.target.value)}
        />
      )}
    </SettingsField>
  );
  const toggle = (k: DraftSwitch, label: string) => (
    <label>
      {label}
      <Switch
        checked={draft.switches[k]}
        disabled={busy}
        onCheckedChange={(on) => setSwitch(k, on)}
      />
    </label>
  );

  let body: ReactNode;
  if (preview) {
    body = (
      <form
        aria-label="确认飞书配置修改"
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <SettingsSection title="确认修改">
          <SettingsDialogFields>
            <SettingsFacts>
              {preview.result.diff.map((line) => (
                <SettingsFact key={line.key} label={diffLabel(line.key)}>
                  <SettingsDiff op="remove">
                    {line.key.startsWith("secrets.")
                      ? formatSecretDiff("before", line.before)
                      : safe(formatValue(line.key, line.before))}
                  </SettingsDiff>
                  {" → "}
                  <SettingsDiff op="add">
                    {line.key.startsWith("secrets.")
                      ? formatSecretDiff("after", line.after)
                      : safe(formatValue(line.key, line.after))}
                  </SettingsDiff>
                </SettingsFact>
              ))}
            </SettingsFacts>
            {preview.result.restart_required && (
              <SettingsWarning role="note">
                这次修改需要重启后台才能生效。
              </SettingsWarning>
            )}
          </SettingsDialogFields>
        </SettingsSection>
        <SettingsDialogActions>
          <Button
            disabled={busy}
            onClick={() => {
              setPreview(undefined);
              setProblem(undefined);
            }}
          >
            返回修改
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "正在保存…" : "确认保存"}
          </Button>
        </SettingsDialogActions>
      </form>
    );
  } else {
    body = (
      <form
        ref={form}
        aria-label="编辑飞书配置"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) start();
        }}
      >
        {(notice || droppedNotice) && (
          <SettingsDialogFields>
            {notice}
            {droppedNotice}
          </SettingsDialogFields>
        )}
        <SettingsSection title="状态">
          <SettingsDialogFields>
            {toggle("enabled", "消息推送")}
          </SettingsDialogFields>
        </SettingsSection>
        <SettingsSection title="渠道">
          <SettingsDialogFields>
            {toggle("lark", "群机器人")}
            {toggle("lark_app", "应用机器人")}
            {field("workbench_url", "Workbench 链接", "url")}
          </SettingsDialogFields>
        </SettingsSection>
        <SettingsSection title="免打扰">
          <SettingsDialogFields>
            {toggle("quiet", "免打扰")}
            {field("quiet_start", "开始", "text")}
            {field("quiet_end", "结束", "text")}
            {field("timezone", "时区", "text")}
          </SettingsDialogFields>
        </SettingsSection>
        <SettingsSection title="限速">
          <SettingsDialogFields>
            {field("lark_rate", "群机器人（条/分钟）")}
            {field("lark_app_rate", "应用机器人（条/分钟）")}
          </SettingsDialogFields>
        </SettingsSection>
        <SettingsSection title="凭据">
          <SettingsDialogFields>
            {FEISHU_SECRET_KEYS.map((k) => (
              <SecretEditor
                key={k}
                busy={busy}
                label={SECRET_LABELS[k]}
                state={base.secrets[k]}
                mode={draft.secrets[k]}
                value={values[k] ?? ""}
                error={shown(k)}
                onMode={(mode) => setSecret(k, mode)}
                onValue={(value) =>
                  setValues((old) => ({ ...old, [k]: value }))
                }
              />
            ))}
          </SettingsDialogFields>
        </SettingsSection>
        <SettingsSection title="高级">
          <SettingsDialogFields>
            {field("timeout", "请求超时（秒）", "decimal")}
            {field("retry_delays", "重试间隔（秒）", "text")}
            {field("title_limit", "标题长度（字）")}
            {field("digest_limit", "汇总条数（条）")}
            {field("binding_ttl", "绑定码有效期（分钟）", "decimal")}
            {field("action_ttl", "按钮有效期（分钟）", "decimal")}
            {field("binding_attempts", "每分钟绑定尝试（次）")}
            {field("pending_limit", "待处理上限（条）")}
          </SettingsDialogFields>
        </SettingsSection>
        <SettingsDialogActions>
          <Button disabled={busy} onClick={leave}>
            取消
          </Button>
          {refreshButton || (
            <Button
              key="preview"
              type="submit"
              variant="primary"
              disabled={busy || !built.dirty}
            >
              {busy ? "正在生成预览…" : "预览修改"}
            </Button>
          )}
        </SettingsDialogActions>
      </form>
    );
  }
  return (
    <Drawer
      className={settingsDrawerClassName}
      open={!hidden}
      onOpenChange={(next) => !next && leave()}
      title="编辑飞书配置"
      description="编辑飞书配置"
      initialFocus="close"
    >
      <CardDetailLayout className="card-page-drawer">
        {body}
        {guard.dialog}
      </CardDetailLayout>
    </Drawer>
  );
}

/** One write-only credential: its state, and replace or clear for this save. */
function SecretEditor({
  busy,
  label,
  state,
  mode,
  value,
  error,
  onMode,
  onValue,
}: {
  busy: boolean;
  label: string;
  state: FeishuSettingsView["secrets"][FeishuSecretKey];
  mode: "replace" | "clear" | undefined;
  value: string;
  error: string | undefined;
  onMode: (mode: "replace" | "clear" | null) => void;
  onValue: (value: string) => void;
}) {
  return (
    <fieldset>
      <legend>{label}</legend>
      <SettingsFacts>
        <SettingsFact label="状态">
          {mode === "clear" ? (
            <SettingsDiff op="remove">将清除</SettingsDiff>
          ) : (
            <>
              <StatusTag
                status={state.set ? "done" : "pending"}
                label={state.set ? "已设置" : "未设置"}
              />
              {state.updated_at && (
                <>
                  {" "}
                  最后修改 <Time value={state.updated_at} />
                </>
              )}
            </>
          )}
        </SettingsFact>
      </SettingsFacts>
      {mode === "replace" && (
        <SettingsField label={`新${label}`} error={error}>
          {(field) => (
            <Input
              type="password"
              value={value}
              disabled={busy}
              autoComplete="new-password"
              spellCheck={false}
              aria-invalid={field.invalid}
              aria-describedby={field.describedBy}
              onChange={(e) => onValue(e.target.value)}
            />
          )}
        </SettingsField>
      )}
      {mode !== "replace" && error && (
        <SettingsWarning>{error}</SettingsWarning>
      )}
      <SettingsDialogActions>
        {mode ? (
          <Button disabled={busy} onClick={() => onMode(null)}>
            {mode === "clear"
              ? "撤销清除"
              : state.set
                ? "撤销替换"
                : "撤销填写"}
          </Button>
        ) : (
          <>
            <Button disabled={busy} onClick={() => onMode("replace")}>
              {state.set ? "替换" : "填写"}
            </Button>
            {state.set && (
              <Button disabled={busy} onClick={() => onMode("clear")}>
                清除
              </Button>
            )}
          </>
        )}
      </SettingsDialogActions>
    </fieldset>
  );
}
