import { HARNESSES } from "@cardigan/domain";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  CardiganClient,
  LaunchChange,
  LaunchPreview,
  LaunchProfileFields,
  LaunchProfileReference,
  LaunchProfileView,
  LaunchProviderView,
  LaunchSettingsView,
} from "../api.js";
import {
  SettingsDialogActions,
  SettingsDialogFields,
  SettingsDiff,
  SettingsFact,
  SettingsFacts,
  SettingsField,
  SettingsSection,
  SettingsWarning,
} from "../components/layout/SettingsLayout.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { SelectControl } from "../components/ui/select-control.js";
import {
  diffLabel,
  diffValue,
  type LaunchProblem,
  launchProblem,
  nameProblem,
  optionalNameProblem,
  permissionProblem,
  textProblem,
  urlProblem,
} from "./launch-change.js";

/** What a drawer needs to know about the form inside it before closing. */
export interface LaunchFormState {
  readonly dirty: boolean;
  readonly busy: boolean;
}

interface EditorContext {
  readonly client: CardiganClient;
  /** The read the form was opened from; a stale preview refreshes it. */
  readonly settings: LaunchSettingsView;
  readonly onRefreshed: (settings: LaunchSettingsView) => void;
  readonly onSaved: (message: string) => void;
  readonly onCancel: () => void;
  readonly onState: (state: LaunchFormState) => void;
}

type FieldProblem = Extract<LaunchProblem, { kind: "field" }>;

/**
 * C-516: preview → confirm for one C-515 change. Nothing is written until the
 * person has seen the diff and confirmed it. A confirmation keeps one
 * idempotency key per preview, so retrying an unanswered one cannot write twice.
 */
function useLaunchChange(context: EditorContext) {
  const { client, onRefreshed } = context;
  const [version, setVersion] = useState(context.settings.version);
  const [preview, setPreview] = useState<{
    change: LaunchChange;
    result: LaunchPreview;
  }>();
  const [problem, setProblem] = useState<LaunchProblem>();
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const keys = useRef(new Map<string, string>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(async (work: () => Promise<void>) => {
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
  }, []);
  const requestPreview = useCallback(
    (change: LaunchChange, at: string) =>
      run(async () => {
        try {
          const result = await client.previewLaunchChange(at, change);
          if (alive.current) setPreview({ change, result });
        } catch (error) {
          if (alive.current) setProblem(launchProblem(error, change.op));
        }
      }),
    [client, run],
  );
  return {
    busy,
    problem,
    preview,
    /** Show the diff of `change`; the form stays as it was. */
    start: (change: LaunchChange) => requestPreview(change, version),
    /** Back to the form; the preview is dropped. */
    back: () => {
      setPreview(undefined);
      setProblem(undefined);
    },
    /** A snapshot changed elsewhere: read it again, then preview anew. */
    refresh: (change: LaunchChange) =>
      run(async () => {
        try {
          const settings = await client.launchSettings();
          if (!alive.current) return;
          onRefreshed(settings);
          setVersion(settings.version);
          setPreview(undefined);
          const result = await client.previewLaunchChange(
            settings.version,
            change,
          );
          if (alive.current) setPreview({ change, result });
        } catch (error) {
          if (alive.current) setProblem(launchProblem(error, change.op));
        }
      }),
    confirm: (onDone: () => void) =>
      run(async () => {
        if (!preview) return;
        const { preview_id, version: at } = preview.result;
        const key = keys.current.get(preview_id) ?? crypto.randomUUID();
        keys.current.set(preview_id, key);
        try {
          await client.confirmLaunchChange(at, preview_id, key);
          keys.current.delete(preview_id);
          // A form that is gone (the drawer closed) must not act on its reply.
          if (alive.current) onDone();
        } catch (error) {
          if (!alive.current) return;
          const next = launchProblem(error, preview.change.op);
          // The host rejected the file or a field: correct it in the form.
          if (next.kind === "field") setPreview(undefined);
          setProblem(next);
        }
      }),
  };
}

const SAVED: Record<LaunchChange["op"], (name: string) => string> = {
  create_profile: (name) => `已新建启动配置 ${name}，新运行将使用它`,
  copy_profile: (name) => `已复制为启动配置 ${name}`,
  edit_profile: (name) => `已保存启动配置 ${name}，新运行将使用新配置`,
  delete_profile: (name) => `已删除启动配置 ${name}`,
  set_model: (name) => `已更新模型别名 ${name}，新运行将使用新模型`,
  edit_provider: (name) => `已保存 Provider ${name}，新运行将使用新配置`,
};

/**
 * The shared shell of every launch settings form: fields → “预览修改” →
 * diff → “确认保存”. Field problems are shown next to their field (the form
 * renders them through `fields`); the rest appear above the actions.
 */
function LaunchEditor({
  context,
  label,
  change,
  dirty,
  fieldNames,
  fields,
  submitLabel = "预览修改",
  confirmLabel = "确认保存",
  destructive = false,
  heading = true,
}: {
  context: EditorContext;
  label: string;
  /** False when the drawer title already names the form (a new profile). */
  heading?: boolean;
  /** `undefined` while the draft is invalid or unchanged. */
  change: LaunchChange | undefined;
  dirty: boolean;
  /** Fields this form shows; a server problem with another field is general. */
  fieldNames: readonly string[];
  fields: (problem: FieldProblem | undefined) => ReactNode;
  submitLabel?: string;
  confirmLabel?: string;
  destructive?: boolean;
}) {
  const editor = useLaunchChange(context);
  const { onState, onCancel, onSaved } = context;
  const reviewing = editor.preview !== undefined;
  useEffect(
    () => onState({ dirty: dirty || reviewing, busy: editor.busy }),
    [onState, dirty, reviewing, editor.busy],
  );
  const problem = editor.problem;
  const fieldProblem =
    problem?.kind === "field" && fieldNames.includes(problem.field)
      ? problem
      : undefined;
  const general =
    problem && !fieldProblem
      ? problem.kind === "field"
        ? ({ kind: "form", message: problem.message } as const)
        : problem
      : undefined;
  const notice = general && <ProblemNote problem={general} />;
  // A stale snapshot: the main action becomes reading it again and previewing anew.
  const pending = editor.preview?.change ?? change;
  const refresh = general?.kind === "stale" && pending && (
    <Button
      variant="primary"
      disabled={editor.busy}
      onClick={() => void editor.refresh(pending)}
    >
      刷新并重新预览
    </Button>
  );
  if (editor.preview) {
    const { change: previewed, result } = editor.preview;
    return (
      <SettingsSection title="确认修改">
        <form
          aria-label={`确认${label}`}
          onSubmit={(event) => {
            event.preventDefault();
            void editor.confirm(() =>
              onSaved(SAVED[previewed.op](previewed.name)),
            );
          }}
        >
          <SettingsDialogFields>
            <LaunchDiff change={previewed} diff={result.diff} />
            {notice}
          </SettingsDialogFields>
          <SettingsDialogActions>
            <Button onClick={editor.back} disabled={editor.busy}>
              返回修改
            </Button>
            {refresh || (
              <Button
                type="submit"
                variant={destructive ? "destructive" : "primary"}
                disabled={editor.busy}
              >
                {editor.busy ? "正在保存…" : confirmLabel}
              </Button>
            )}
          </SettingsDialogActions>
        </form>
      </SettingsSection>
    );
  }
  const form = (
    <form
      aria-label={label}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (change && !editor.busy) void editor.start(change);
      }}
    >
      <SettingsDialogFields>
        <fieldset disabled={editor.busy}>{fields(fieldProblem)}</fieldset>
        {notice}
      </SettingsDialogFields>
      <SettingsDialogActions>
        <Button onClick={onCancel} disabled={editor.busy}>
          取消
        </Button>
        {refresh || (
          <Button
            type="submit"
            variant="primary"
            disabled={editor.busy || change === undefined}
          >
            {editor.busy ? "正在生成预览…" : submitLabel}
          </Button>
        )}
      </SettingsDialogActions>
    </form>
  );
  return heading ? (
    <SettingsSection title={label}>{form}</SettingsSection>
  ) : (
    form
  );
}

function ProblemNote({
  problem,
}: {
  problem: Exclude<LaunchProblem, { kind: "field" }>;
}) {
  if (problem.kind === "stale")
    return (
      <SettingsWarning role="alert">
        启动配置已在别处修改，这次预览已作废，没有写入。
      </SettingsWarning>
    );
  if (problem.kind === "in_use")
    return (
      <SettingsWarning role="alert">
        <ReferenceNote references={problem.references} />
      </SettingsWarning>
    );
  return <SettingsWarning role="alert">{problem.message}</SettingsWarning>;
}

/** Deleting is refused while anything uses the profile; say who does. */
export function ReferenceNote({
  references,
}: {
  references: readonly LaunchProfileReference[];
}) {
  return (
    <>
      <p>仍有角色或员工使用这个配置，不能删除：</p>
      <ul aria-label="使用者">
        {references.map((ref) =>
          "role_id" in ref ? (
            <li key={`role:${ref.project_id}:${ref.role_id}:${ref.version}`}>
              角色 {ref.name}（{ref.project_id} / {ref.role_id} v{ref.version}）
            </li>
          ) : (
            <li key={`employee:${ref.employee_id}`}>
              员工 {ref.name}（{ref.employee_id}）
            </li>
          ),
        )}
      </ul>
    </>
  );
}

function LaunchDiff({
  change,
  diff,
}: {
  change: LaunchChange;
  diff: LaunchPreview["diff"];
}) {
  return (
    <SettingsFacts>
      {diff.map((line) => {
        const whole = line.field === `profiles.${change.name}`;
        return (
          <SettingsFact
            key={line.field}
            label={diffLabel(line.field, change.name)}
          >
            {whole && line.after === null ? (
              <SettingsDiff op="remove">删除</SettingsDiff>
            ) : whole ? (
              <SettingsDiff op="add">
                新建，{diffValue(line.after)}
              </SettingsDiff>
            ) : (
              <>
                <SettingsDiff op="remove">
                  {diffValue(line.before)}
                </SettingsDiff>
                {" → "}
                <SettingsDiff op="add">{diffValue(line.after)}</SettingsDiff>
              </>
            )}
          </SettingsFact>
        );
      })}
    </SettingsFacts>
  );
}

/** A text input whose problem is shown right below it (C-516). */
function TextField({
  label,
  error,
  value,
  url = false,
  onChange,
}: {
  label: string;
  error: string | undefined;
  value: string;
  url?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <SettingsField label={label} error={error}>
      {(field) => (
        <Input
          value={value}
          autoComplete="off"
          inputMode={url ? "url" : "text"}
          aria-invalid={field.invalid}
          aria-describedby={field.describedBy}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </SettingsField>
  );
}

const CUSTOM = "__custom__";
type ProfileDraft = Record<
  | "name"
  | "harness"
  | "provider"
  | "model"
  | "effort"
  | "permission_mode"
  | "provider_flag"
  | "auto_update",
  string
>;
const modelText = (p: LaunchProfileView | undefined) =>
  p ? (p.model_alias ?? p.model_id ?? "") : "";

/** New or edited profile. An edit sends only the fields the person changed. */
export function ProfileForm({
  context,
  profile,
}: {
  context: EditorContext;
  profile?: LaunchProfileView;
}) {
  const { settings } = context;
  const models = settings.models ?? {};
  const aliases = Object.keys(models);
  const initial: ProfileDraft = {
    name: profile?.name ?? "",
    harness: profile?.harness ?? HARNESSES[0] ?? "",
    provider: profile?.provider ?? "",
    model: modelText(profile),
    effort: profile?.parameters.effort ?? "",
    permission_mode: profile?.parameters.permission_mode ?? "",
    provider_flag: profile?.parameters.provider_flag ?? "",
    auto_update:
      profile?.parameters.auto_update == null
        ? ""
        : String(profile.parameters.auto_update),
  };
  const [draft, setDraft] = useState(initial);
  const [custom, setCustom] = useState(
    initial.model !== "" && !aliases.includes(initial.model),
  );
  const patch = (next: Partial<typeof draft>) =>
    setDraft((old) => ({ ...old, ...next }));
  const creating = profile === undefined;
  const taken =
    creating && settings.profiles.some((p) => p.name === draft.name.trim());
  const problems = {
    name: creating
      ? (nameProblem(draft.name.trim()) ??
        (taken ? "已有同名配置，换一个名称。" : undefined))
      : undefined,
    model: custom && draft.model !== "" ? textProblem(draft.model) : undefined,
    effort: optionalNameProblem(draft.effort.trim()),
    permission_mode: permissionProblem(draft.permission_mode.trim()),
    provider_flag: optionalNameProblem(draft.provider_flag.trim()),
  };
  const fields: LaunchProfileFields = {};
  const set = <K extends keyof LaunchProfileFields>(
    key: K,
    value: LaunchProfileFields[K],
    before: LaunchProfileFields[K],
  ) => {
    if (creating ? value !== null : value !== before)
      (fields as Record<string, unknown>)[key] = value;
  };
  const orNull = (value: string) => (value.trim() === "" ? null : value.trim());
  const flag = (value: string) => (value === "" ? null : value === "true");
  set("harness", draft.harness, initial.harness);
  set("provider", orNull(draft.provider), orNull(initial.provider));
  set("model", orNull(draft.model), orNull(initial.model));
  set("effort", orNull(draft.effort), orNull(initial.effort));
  set(
    "permission_mode",
    orNull(draft.permission_mode),
    orNull(initial.permission_mode),
  );
  set(
    "provider_flag",
    orNull(draft.provider_flag),
    orNull(initial.provider_flag),
  );
  set("auto_update", flag(draft.auto_update), flag(initial.auto_update));
  const valid = Object.values(problems).every((p) => p === undefined);
  const changed = creating || Object.keys(fields).length > 0;
  const name = creating ? draft.name.trim() : (profile?.name ?? "");
  const change: LaunchChange | undefined =
    valid && changed
      ? { op: creating ? "create_profile" : "edit_profile", name, fields }
      : undefined;
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  return (
    <LaunchEditor
      context={context}
      label={creating ? "新建启动配置" : "编辑启动配置"}
      heading={!creating}
      change={change}
      dirty={dirty}
      fieldNames={creating ? ["name"] : []}
      fields={(server) => (
        <ProfileFields
          draft={draft}
          patch={patch}
          creating={creating}
          custom={custom}
          setCustom={setCustom}
          settings={settings}
          problems={{
            ...problems,
            name: problems.name ?? server?.message,
          }}
        />
      )}
    />
  );
}

function ProfileFields({
  draft,
  patch,
  creating,
  custom,
  setCustom,
  settings,
  problems,
}: {
  draft: ProfileDraft;
  patch: (next: Partial<ProfileDraft>) => void;
  creating: boolean;
  custom: boolean;
  setCustom: (custom: boolean) => void;
  settings: LaunchSettingsView;
  problems: Partial<Record<keyof ProfileDraft, string | undefined>>;
}) {
  const models = settings.models ?? {};
  const harnesses = HARNESSES.includes(draft.harness as never)
    ? HARNESSES
    : [draft.harness, ...HARNESSES];
  const providers: readonly LaunchProviderView[] =
    draft.provider === "" ||
    settings.providers.some((p) => p.id === draft.provider)
      ? settings.providers
      : [
          { id: draft.provider, name: draft.provider, base_url: null },
          ...settings.providers,
        ];
  return (
    <>
      {creating && (
        <TextField
          label="名称"
          error={problems.name}
          value={draft.name}
          onChange={(value) => patch({ name: value })}
        />
      )}
      <label>
        Harness
        <SelectControl
          value={draft.harness}
          onValueChange={(harness) => patch({ harness })}
        >
          {harnesses.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </SelectControl>
      </label>
      <label>
        Provider
        <SelectControl
          value={draft.provider}
          onValueChange={(provider) => patch({ provider })}
        >
          <option value="">不使用 Provider</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}（{p.id}）
            </option>
          ))}
        </SelectControl>
      </label>
      <label>
        模型
        <SelectControl
          value={custom ? CUSTOM : draft.model}
          onValueChange={(value) => {
            if (value === CUSTOM) {
              setCustom(true);
              patch({ model: "" });
            } else {
              setCustom(false);
              patch({ model: value });
            }
          }}
        >
          <option value="">未设置</option>
          {Object.entries(models).map(([alias, m]) => (
            <option key={alias} value={alias}>
              {alias} → {m.id}
            </option>
          ))}
          <option value={CUSTOM}>填写模型标识</option>
        </SelectControl>
      </label>
      {custom && (
        <TextField
          label="模型标识"
          error={problems.model}
          value={draft.model}
          onChange={(value) => patch({ model: value })}
        />
      )}
      <TextField
        label="推理强度"
        error={problems.effort}
        value={draft.effort}
        onChange={(value) => patch({ effort: value })}
      />
      <TextField
        label="权限模式"
        error={problems.permission_mode}
        value={draft.permission_mode}
        onChange={(value) => patch({ permission_mode: value })}
      />
      <TextField
        label="Provider 参数"
        error={problems.provider_flag}
        value={draft.provider_flag}
        onChange={(value) => patch({ provider_flag: value })}
      />
      <label>
        自动更新
        <SelectControl
          value={draft.auto_update}
          onValueChange={(auto_update) => patch({ auto_update })}
        >
          <option value="">未设置</option>
          <option value="true">自动更新</option>
          <option value="false">不自动更新</option>
        </SelectControl>
      </label>
    </>
  );
}

/** A new profile with the same raw settings under another name. */
export function CopyProfileForm({
  context,
  source,
}: {
  context: EditorContext;
  source: LaunchProfileView;
}) {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const taken = context.settings.profiles.some((p) => p.name === trimmed);
  const local =
    name === ""
      ? undefined
      : (nameProblem(trimmed) ??
        (taken ? "已有同名配置，换一个名称。" : undefined));
  return (
    <LaunchEditor
      context={context}
      label="复制启动配置"
      change={
        trimmed && !local
          ? { op: "copy_profile", name: trimmed, source: source.name }
          : undefined
      }
      dirty={name !== ""}
      fieldNames={["name"]}
      fields={(server) => (
        <CopyFields
          source={source.name}
          name={name}
          setName={setName}
          problem={local ?? server?.message}
        />
      )}
    />
  );
}
function CopyFields({
  source,
  name,
  setName,
  problem,
}: {
  source: string;
  name: string;
  setName: (name: string) => void;
  problem: string | undefined;
}) {
  return (
    <>
      <SettingsFacts>
        <SettingsFact label="来源">{source}</SettingsFact>
      </SettingsFacts>
      <TextField
        label="新配置名称"
        error={problem}
        value={name}
        onChange={(value) => setName(value)}
      />
    </>
  );
}

/** Deleting: refused up front while referenced; otherwise preview, then confirm. */
export function DeleteProfileForm({
  context,
  profile,
}: {
  context: EditorContext;
  profile: LaunchProfileView;
}) {
  const used = profile.references.length > 0;
  return (
    <LaunchEditor
      context={context}
      label="删除启动配置"
      change={used ? undefined : { op: "delete_profile", name: profile.name }}
      dirty={false}
      fieldNames={[]}
      submitLabel="预览删除"
      confirmLabel="确认删除"
      destructive
      fields={() =>
        used ? (
          <SettingsWarning role="alert">
            <ReferenceNote references={profile.references} />
          </SettingsWarning>
        ) : (
          <SettingsFacts>
            <SettingsFact label="删除">{profile.name}</SettingsFact>
          </SettingsFacts>
        )
      }
    />
  );
}

/** Provider name, endpoint and which existing secrets.env key each variable uses. */
export function ProviderForm({
  context,
  provider,
}: {
  context: EditorContext;
  provider: LaunchProviderView;
}) {
  const { settings } = context;
  const keys = settings.secret_keys ?? [];
  const initial = {
    name: provider.name,
    base_url: provider.base_url ?? "",
    secret_env: { ...(provider.secret_env ?? {}) },
  };
  const [draft, setDraft] = useState(initial);
  const problems = {
    name: textProblem(draft.name),
    base_url:
      draft.base_url === "" && initial.base_url === ""
        ? undefined
        : urlProblem(draft.base_url),
  };
  const fields: Record<string, unknown> = {};
  if (draft.name !== initial.name) fields.name = draft.name;
  if (draft.base_url !== initial.base_url) fields.base_url = draft.base_url;
  const secrets = Object.fromEntries(
    Object.entries(draft.secret_env).filter(
      ([env, key]) => initial.secret_env[env] !== key,
    ),
  );
  if (Object.keys(secrets).length) fields.secret_env = secrets;
  const valid = Object.values(problems).every((p) => p === undefined);
  const used = settings.profiles
    .filter((p) => p.provider === provider.id)
    .map((p) => p.name);
  return (
    <LaunchEditor
      context={context}
      label="编辑 Provider"
      change={
        valid && Object.keys(fields).length
          ? { op: "edit_provider", name: provider.id, fields }
          : undefined
      }
      dirty={JSON.stringify(draft) !== JSON.stringify(initial)}
      fieldNames={["base_url", "secret_env"]}
      fields={(server) => (
        <ProviderFields
          id={provider.id}
          used={used}
          keys={keys}
          draft={draft}
          setDraft={setDraft}
          problems={{
            ...problems,
            base_url:
              problems.base_url ??
              (server?.field === "base_url" ? server.message : undefined),
            secret_env:
              server?.field === "secret_env" ? server.message : undefined,
          }}
        />
      )}
    />
  );
}
function ProviderFields({
  id,
  used,
  keys,
  draft,
  setDraft,
  problems,
}: {
  id: string;
  used: readonly string[];
  keys: readonly string[];
  draft: {
    name: string;
    base_url: string;
    secret_env: Record<string, string>;
  };
  setDraft: (next: {
    name: string;
    base_url: string;
    secret_env: Record<string, string>;
  }) => void;
  problems: Record<"name" | "base_url" | "secret_env", string | undefined>;
}) {
  return (
    <>
      <SettingsFacts>
        <SettingsFact label="编号">
          <code>{id}</code>
        </SettingsFact>
        <SettingsFact label="使用它的配置">
          {used.length ? used.join("、") : "—"}
        </SettingsFact>
      </SettingsFacts>
      <TextField
        label="名称"
        error={problems.name}
        value={draft.name}
        onChange={(value) => setDraft({ ...draft, name: value })}
      />
      <TextField
        label="端点"
        error={problems.base_url}
        value={draft.base_url}
        url
        onChange={(value) => setDraft({ ...draft, base_url: value })}
      />
      {Object.entries(draft.secret_env).map(([env, key]) => (
        <SettingsField
          key={env}
          label={`密钥引用 ${env}`}
          error={problems.secret_env}
        >
          {(field) => (
            <SelectControl
              value={key}
              aria-invalid={field.invalid}
              aria-describedby={field.describedBy}
              onValueChange={(next) =>
                setDraft({
                  ...draft,
                  secret_env: { ...draft.secret_env, [env]: next },
                })
              }
            >
              {(keys.includes(key) ? keys : [key, ...keys]).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </SelectControl>
          )}
        </SettingsField>
      ))}
    </>
  );
}

/** Point a model alias at another concrete id; every profile using it follows. */
export function AliasForm({
  context,
  alias,
}: {
  context: EditorContext;
  alias: string;
}) {
  const model = context.settings.models?.[alias];
  const initial = model?.id ?? "";
  const [id, setId] = useState(initial);
  const local = textProblem(id);
  const used = context.settings.profiles
    .filter((p) => p.model_alias === alias)
    .map((p) => p.name);
  return (
    <LaunchEditor
      context={context}
      label="编辑模型别名"
      change={
        !local && id.trim() !== initial
          ? { op: "set_model", name: alias, id: id.trim() }
          : undefined
      }
      dirty={id !== initial}
      fieldNames={["id"]}
      fields={(server) => (
        <AliasFields
          alias={alias}
          used={used}
          id={id}
          setId={setId}
          problem={local ?? server?.message}
        />
      )}
    />
  );
}
function AliasFields({
  alias,
  used,
  id,
  setId,
  problem,
}: {
  alias: string;
  used: readonly string[];
  id: string;
  setId: (id: string) => void;
  problem: string | undefined;
}) {
  return (
    <>
      <SettingsFacts>
        <SettingsFact label="别名">{alias}</SettingsFact>
        <SettingsFact label="使用它的配置">
          {used.length ? used.join("、") : "—"}
        </SettingsFact>
      </SettingsFacts>
      <TextField
        label="模型标识"
        error={problem}
        value={id}
        onChange={(value) => setId(value)}
      />
    </>
  );
}

export type { EditorContext };
