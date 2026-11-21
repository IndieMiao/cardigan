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
  LaunchProviderSecret,
  LaunchProviderView,
  LaunchSettingsView,
} from "../api.js";
import { StatusTag, Time } from "../components/Foundation.js";
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
  envNameProblem,
  envValueProblem,
  type LaunchProblem,
  launchProblem,
  nameProblem,
  optionalNameProblem,
  permissionProblem,
  provedNotWritten,
  secretValueProblem,
  sharedKeyProblem,
  textProblem,
  UNSETTLED,
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
  /**
   * Read the settings again through the page's one ordered reader (Q-1052).
   * Resolves with what the page shows once this read has settled: its own
   * result, or a newer one another read already showed — never an older one.
   */
  readonly reread: () => Promise<LaunchSettingsView>;
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
  const { client, reread } = context;
  const [version, setVersion] = useState(context.settings.version);
  const [preview, setPreview] = useState<{
    change: LaunchChange;
    result: LaunchPreview;
  }>();
  const [problem, setProblem] = useState<LaunchProblem>();
  const [busy, setBusy] = useState(false);
  // C-549 / V-2708: after a failed confirmation the secret inputs are empty;
  // "dropped" when the host proved nothing was written, "unknown" otherwise.
  const [secretsOutcome, setSecretsOutcome] = useState<"dropped" | "unknown">();
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
  /**
   * A reference appeared since the read (a delete answered `profile_in_use`):
   * drop the preview and read the settings again, so the form shows who uses
   * it. The delete stays unavailable in this form (see `LaunchEditor`).
   */
  const refused = useCallback(
    async (next: LaunchProblem) => {
      setPreview(undefined);
      setProblem(next);
      try {
        const settings = await reread();
        if (alive.current) setVersion(settings.version);
      } catch {
        // The notice from the refusal stays; the delete stays unavailable.
      }
    },
    [reread],
  );
  const requestPreview = useCallback(
    (change: LaunchChange, at: string) =>
      run(async () => {
        try {
          const result = await client.previewLaunchChange(at, change);
          if (alive.current) setPreview({ change, result });
        } catch (error) {
          if (!alive.current) return;
          const next = launchProblem(error, change.op);
          if (next.kind === "in_use" || next.kind === "provider_in_use")
            await refused(next);
          else setProblem(next);
        }
      }),
    [client, run, refused],
  );
  return {
    busy,
    problem,
    preview,
    secretsOutcome,
    /** Show the diff of `change`; the form stays as it was. */
    start: (change: LaunchChange) => {
      setSecretsOutcome(undefined);
      return requestPreview(change, version);
    },
    /** Back to the form; the preview is dropped. */
    back: () => {
      setPreview(undefined);
      setProblem(undefined);
    },
    /** A snapshot changed elsewhere: read it again, then preview anew. */
    refresh: (change: LaunchChange) =>
      run(async () => {
        // V-2571: the rejected preview can never be confirmed again.
        setPreview(undefined);
        let settings: LaunchSettingsView;
        try {
          settings = await reread();
        } catch {
          // Nothing newer could be read: the snapshot is still known to be
          // stale, so "刷新并重新预览" stays as the retry, in place.
          if (alive.current) setProblem({ kind: "stale" });
          return;
        }
        if (!alive.current) return;
        setVersion(settings.version);
        try {
          const result = await client.previewLaunchChange(
            settings.version,
            change,
          );
          if (alive.current) setPreview({ change, result });
        } catch (error) {
          if (alive.current) setProblem(launchProblem(error, change.op));
        }
      }),
    confirm: (
      onDone: () => void,
      secrets?: Readonly<Record<string, string>>,
      /** C-549: the values were not written; the form clears its secret inputs. */
      onSecretsDropped?: () => void,
    ) =>
      run(async () => {
        if (!preview) return;
        const { preview_id, version: at } = preview.result;
        const key = keys.current.get(preview_id) ?? crypto.randomUUID();
        keys.current.set(preview_id, key);
        const withSecrets = secrets && Object.keys(secrets).length > 0;
        try {
          if (withSecrets)
            await client.confirmLaunchChange(at, preview_id, key, secrets);
          else await client.confirmLaunchChange(at, preview_id, key);
          keys.current.delete(preview_id);
          // A form that is gone (the drawer closed) must not act on its reply.
          if (alive.current) onDone();
        } catch (error) {
          if (!alive.current) return;
          const next = launchProblem(error, preview.change.op);
          if (next.kind === "in_use" || next.kind === "provider_in_use")
            return await refused(next);
          if (withSecrets) {
            // Secret values are never kept for a retry: back to the form,
            // inputs emptied, the rest of the draft as it was.
            setPreview(undefined);
            onSecretsDropped?.();
            if (!provedNotWritten(error)) {
              // V-2708: the reply was lost or unclear, so the host may have
              // written. Ask again with the same key and no values: a settled
              // receipt answers success; anything else stays unknown.
              try {
                await client.confirmLaunchChange(at, preview_id, key);
                keys.current.delete(preview_id);
                if (alive.current) onDone();
                return;
              } catch {
                if (!alive.current) return;
                setSecretsOutcome("unknown");
                try {
                  const settings = await reread();
                  if (alive.current) setVersion(settings.version);
                } catch {
                  // The notice already says to refresh before retyping.
                }
                return;
              }
            }
            setSecretsOutcome("dropped");
            setProblem(next);
            if (next.kind === "stale")
              try {
                const settings = await reread();
                if (alive.current) setVersion(settings.version);
              } catch {
                // The next preview answers stale again and offers the refresh.
              }
            return;
          }
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
  create_provider: (name) => `已新建 Provider ${name}`,
  delete_provider: (name) => `已删除 Provider ${name}`,
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
  reviewFacts,
  secrets,
  onSecretsDropped,
}: {
  context: EditorContext;
  label: string;
  /** C-549: secret values sent with the confirmation only (never the preview). */
  secrets?: Readonly<Record<string, string>>;
  onSecretsDropped?: () => void;
  /** What the confirmation names besides the diff (a shared alias or Provider and its users). */
  reviewFacts?: ReactNode;
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
  // Known to be referenced: no further delete from this form.
  const inUse =
    problem?.kind === "in_use" || problem?.kind === "provider_in_use";
  // When the new read already lists the users, the form shows them instead.
  const notice = general && !(inUse && change === undefined) && (
    <ProblemNote problem={general} />
  );
  // A stale snapshot: the main action becomes reading it again and previewing anew.
  const pending = editor.preview?.change ?? change;
  // V-2577: the refresh and the form's submit button take the same spot. A
  // distinct key keeps them separate elements, and the click's default action
  // is cancelled, so a refresh that answers at once can never also submit
  // (confirm) the new preview; that needs its own click.
  const refresh = general?.kind === "stale" && pending && (
    <Button
      key="refresh"
      variant="primary"
      disabled={editor.busy}
      onClick={(event) => {
        event.preventDefault();
        void editor.refresh(pending);
      }}
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
            if (inUse) return;
            void editor.confirm(
              () => onSaved(SAVED[previewed.op](previewed.name)),
              secrets,
              onSecretsDropped,
            );
          }}
        >
          <SettingsDialogFields>
            {reviewFacts}
            <LaunchDiff change={previewed} diff={result.diff} />
            {notice}
          </SettingsDialogFields>
          <SettingsDialogActions>
            <Button onClick={editor.back} disabled={editor.busy}>
              返回修改
            </Button>
            {refresh || (
              <Button
                key="confirm"
                type="submit"
                variant={destructive ? "destructive" : "primary"}
                disabled={editor.busy || inUse}
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
        if (change && !editor.busy && !inUse) void editor.start(change);
      }}
    >
      <SettingsDialogFields>
        <fieldset disabled={editor.busy}>{fields(fieldProblem)}</fieldset>
        {notice}
        {editor.secretsOutcome && (
          <SettingsWarning role="alert">
            {editor.secretsOutcome === "unknown"
              ? UNSETTLED
              : "密钥没有写入，输入框已清空，请重新输入。"}
          </SettingsWarning>
        )}
      </SettingsDialogFields>
      <SettingsDialogActions>
        <Button onClick={onCancel} disabled={editor.busy}>
          取消
        </Button>
        {refresh || (
          <Button
            key="preview"
            type="submit"
            variant="primary"
            disabled={editor.busy || change === undefined || inUse}
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
  if (problem.kind === "provider_in_use")
    return (
      <SettingsWarning role="alert">
        <ProviderUsersNote
          profiles={problem.profiles}
          models={problem.models}
        />
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
        const whole =
          line.field === `profiles.${change.name}` ||
          line.field === `providers.${change.name}`;
        if (line.field.startsWith("secrets."))
          return (
            <SettingsFact
              key={line.field}
              label={diffLabel(line.field, change.name)}
            >
              <SettingsDiff op="remove">
                {line.before === "set" ? "已设置" : "未设置"}
              </SettingsDiff>
              {" → "}
              <SettingsDiff op="add">
                {line.after === "new" ? "写入新密钥" : "清除"}
              </SettingsDiff>
            </SettingsFact>
          );
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
  // Only what the person edited; untouched fields follow the latest read,
  // so a refreshed snapshot never turns someone else's change into ours.
  const [edits, setEdits] = useState<Partial<ProfileDraft>>({});
  const draft: ProfileDraft = { ...initial, ...edits };
  const [custom, setCustom] = useState(
    initial.model !== "" && !aliases.includes(initial.model),
  );
  // A field put back to the read's value is no longer an edit.
  const patch = (next: Partial<ProfileDraft>) =>
    setEdits((old) => {
      const out = { ...old };
      for (const [key, value] of Object.entries(next) as [
        keyof ProfileDraft,
        string,
      ][]) {
        if (value === initial[key]) delete out[key];
        else out[key] = value;
      }
      return out;
    });
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
  const dirty = Object.entries(edits).some(
    ([key, value]) => value !== initial[key as keyof ProfileDraft],
  );
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

/** Who still uses a Provider, so it cannot be deleted. */
export function ProviderUsersNote({
  profiles,
  models,
}: {
  profiles: readonly string[];
  models: readonly string[];
}) {
  return (
    <>
      <p>仍有启动配置或模型别名使用这个 Provider，不能删除：</p>
      <ul aria-label="使用者">
        {profiles.map((name) => (
          <li key={`profile:${name}`}>启动配置 {name}</li>
        ))}
        {models.map((alias) => (
          <li key={`model:${alias}`}>模型别名 {alias}</li>
        ))}
      </ul>
    </>
  );
}

/** Deleting a Provider: refused up front while a profile or alias uses it. */
export function DeleteProviderForm({
  context,
  provider,
}: {
  context: EditorContext;
  provider: LaunchProviderView;
}) {
  const profiles = provider.profiles ?? [];
  const models = provider.models ?? [];
  const used = profiles.length + models.length > 0;
  return (
    <LaunchEditor
      context={context}
      label="删除 Provider"
      change={used ? undefined : { op: "delete_provider", name: provider.id }}
      dirty={false}
      fieldNames={[]}
      submitLabel="预览删除"
      confirmLabel="确认删除"
      destructive
      fields={() =>
        used ? (
          <SettingsWarning role="alert">
            <ProviderUsersNote profiles={profiles} models={models} />
          </SettingsWarning>
        ) : (
          <SettingsFacts>
            <SettingsFact label="删除">{provider.id}</SettingsFact>
          </SettingsFacts>
        )
      }
    />
  );
}

export const PROVIDER_APIS = [
  "anthropic-messages",
  "openai-responses",
  "openai-completions",
] as const;

/** The secret variables of a read; older reads only carry `secret_env`. */
export function providerSecrets(
  provider: LaunchProviderView | undefined,
  keys: readonly string[],
): readonly LaunchProviderSecret[] {
  if (!provider) return [];
  return (
    provider.secrets ??
    Object.entries(provider.secret_env ?? {}).map(([env, key]) => ({
      env,
      key,
      set: keys.includes(key),
      updated_at: null,
    }))
  );
}

type Scalar = "id" | "name" | "harness" | "api" | "base_url";
interface EnvEdit {
  readonly value?: string;
  readonly removed?: boolean;
}
interface AddedEnv {
  readonly row: number;
  readonly name: string;
  readonly value: string;
}
interface SecretEdit {
  readonly key?: string | undefined;
  readonly mode?: "replace" | "clear" | undefined;
  readonly removed?: boolean | undefined;
}
interface AddedSecret {
  readonly row: number;
  readonly env: string;
  /** Follows the variable name until the person edits it. */
  readonly key: string | undefined;
}
interface ProviderEdits {
  readonly scalars: Partial<Record<Scalar, string>>;
  readonly env: Readonly<Record<string, EnvEdit>>;
  readonly addedEnv: readonly AddedEnv[];
  readonly secrets: Readonly<Record<string, SecretEdit>>;
  readonly addedSecrets: readonly AddedSecret[];
}
const NO_EDITS: ProviderEdits = {
  scalars: {},
  env: {},
  addedEnv: [],
  secrets: {},
  addedSecrets: [],
};
/** The secrets.env key a new variable suggests: `<ID>_<VARIABLE>`. */
const suggestedKey = (id: string, env: string) =>
  [id.toUpperCase().replace(/[^A-Z0-9]+/gu, "_"), env]
    .filter(Boolean)
    .join("_")
    .replace(/^[0-9]/u, "_$&")
    .slice(0, 128);

/**
 * C-549: a new or edited Provider. Plain variables are edited in place;
 * secret values are write-only: typed here, sent only with the confirmation,
 * never kept in the draft and cleared when the write fails.
 */
export function ProviderForm({
  context,
  provider,
  onCreated,
}: {
  context: EditorContext;
  provider?: LaunchProviderView;
  /** A new Provider opens its detail afterwards (to probe it). */
  onCreated?: (id: string) => void;
}) {
  const { settings } = context;
  const creating = provider === undefined;
  const keys = settings.secret_keys ?? [];
  const initial: Record<Scalar, string> = {
    id: provider?.id ?? "",
    name: provider?.name ?? "",
    harness: provider ? (provider.harness ?? "") : (HARNESSES[0] ?? ""),
    api: provider?.api ?? "",
    base_url: provider?.base_url ?? "",
  };
  const envRows = provider?.env ?? [];
  const secretRows = providerSecrets(provider, keys);
  // Only what the person edited, over the latest read (see `ProfileForm`).
  const [edits, setEdits] = useState<ProviderEdits>(NO_EDITS);
  // Secret values by row: component state only, never part of the draft.
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const nextRow = useRef(0);
  const draft = { ...initial, ...edits.scalars };
  const id = creating ? draft.id.trim() : initial.id;
  const patchScalar = (key: Scalar, value: string) =>
    setEdits((old) => {
      const scalars = { ...old.scalars };
      if (value === initial[key]) delete scalars[key];
      else scalars[key] = value;
      return { ...old, scalars };
    });

  // Problems, in place, before any preview.
  const taken = creating && settings.providers.some((p) => p.id === id);
  const problems: Record<string, string | undefined> = {
    id: creating
      ? (nameProblem(id) ??
        (taken ? "已有同一 ID 的 Provider，换一个 ID。" : undefined))
      : undefined,
    name: creating && draft.name === "" ? undefined : textProblem(draft.name),
    harness:
      creating && draft.harness === "" && draft.api === ""
        ? "请选择 Harness 或协议。"
        : undefined,
    base_url:
      draft.base_url === "" && initial.base_url === ""
        ? undefined
        : urlProblem(draft.base_url),
  };
  const names = new Map<string, number>();
  const count = (name: string) => names.set(name, (names.get(name) ?? 0) + 1);
  for (const row of envRows) if (!edits.env[row.name]?.removed) count(row.name);
  for (const row of edits.addedEnv) count(row.name.trim());
  for (const row of secretRows)
    if (!edits.secrets[row.env]?.removed) count(row.env);
  for (const row of edits.addedSecrets) count(row.env.trim());
  const duplicate = (name: string) =>
    (names.get(name) ?? 0) > 1 ? "变量名重复。" : undefined;

  // The change: scalars, plain env, secret references and the secrets plan.
  const fields: Record<string, unknown> = {};
  for (const key of ["name", "harness", "api", "base_url"] as const) {
    const value = draft[key];
    if (creating) {
      if (value !== "") fields[key] = value;
    } else if (value !== initial[key])
      fields[key] = key === "harness" || key === "api" ? value || null : value;
  }
  const env: Record<string, string | null> = {};
  for (const row of envRows) {
    const edit = edits.env[row.name];
    if (edit?.removed) env[row.name] = null;
    else if (edit?.value !== undefined && edit.value !== (row.value ?? ""))
      env[row.name] = edit.value;
    if (!edit?.removed && edit?.value !== undefined)
      problems[`env:${row.name}`] = envValueProblem(edit.value);
  }
  for (const row of edits.addedEnv) {
    const name = row.name.trim();
    problems[`env+${row.row}`] =
      envNameProblem(name) ?? duplicate(name) ?? envValueProblem(row.value);
    env[name] = row.value;
  }
  const secretEnv: Record<string, string | null> = {};
  const set: string[] = [];
  const clear: string[] = [];
  const secretValuesOut: Record<string, string> = {};
  const writes = new Map<string, number>();
  for (const row of secretRows) {
    const edit = edits.secrets[row.env];
    if (edit?.removed) {
      secretEnv[row.env] = null;
      continue;
    }
    const key = edit?.key ?? row.key;
    if (key !== row.key) secretEnv[row.env] = key;
    if (edit?.mode === "clear") clear.push(row.key);
    if (edit?.mode === "replace") {
      const value = values[`s:${row.env}`] ?? "";
      problems[`secret:${row.env}`] = secretValueProblem(value);
      set.push(key);
      secretValuesOut[key] = value;
      writes.set(key, (writes.get(key) ?? 0) + 1);
    }
  }
  for (const row of edits.addedSecrets) {
    const name = row.env.trim();
    const key = (row.key ?? suggestedKey(id, name)).trim();
    const value = values[`n:${row.row}`] ?? "";
    // A new variable needs a value unless it names a key secrets.env has.
    const needed = value !== "" || !keys.includes(key);
    problems[`secret+${row.row}`] =
      envNameProblem(name) ??
      duplicate(name) ??
      envNameProblem(key) ??
      (needed ? secretValueProblem(value) : undefined);
    secretEnv[name] = key;
    if (needed) {
      set.push(key);
      secretValuesOut[key] = value;
      writes.set(key, (writes.get(key) ?? 0) + 1);
    }
  }
  for (const [key, n] of writes)
    if (n > 1) problems.secrets = `密钥键 ${key} 填了不止一次。`;
  // V-2708: secrets.env is shared. A key another Provider reads is not
  // rewritten or cleared from this form (the server refuses it too).
  for (const key of [...set, ...clear]) {
    const others = settings.providers
      .filter(
        (p) =>
          p.id !== id &&
          (p.secrets?.some((s) => s.key === key) ||
            Object.values(p.secret_env ?? {}).includes(key)),
      )
      .map((p) => p.id);
    if (others.length) problems.secrets ??= sharedKeyProblem(key, others);
  }
  if (Object.keys(env).length) fields.env = env;
  if (Object.keys(secretEnv).length) fields.secret_env = secretEnv;
  const plan = {
    ...(set.length ? { set } : {}),
    ...(clear.length ? { clear } : {}),
  };
  const valid = Object.values(problems).every((p) => p === undefined);
  const changed =
    creating || Object.keys(fields).length > 0 || set.length + clear.length > 0;
  const change: LaunchChange | undefined =
    valid && changed
      ? {
          op: creating ? "create_provider" : "edit_provider",
          name: id,
          fields,
          ...(set.length + clear.length ? { secrets: plan } : {}),
        }
      : undefined;
  const dirty =
    Object.keys(edits.scalars).length > 0 ||
    Object.keys(edits.env).length > 0 ||
    edits.addedEnv.length > 0 ||
    Object.keys(edits.secrets).length > 0 ||
    edits.addedSecrets.length > 0 ||
    Object.values(values).some(Boolean);
  const used = provider
    ? (provider.profiles ??
      settings.profiles
        .filter((p) => p.provider === provider.id)
        .map((p) => p.name))
    : [];
  const label = creating ? "新建 Provider" : "编辑 Provider";
  return (
    <LaunchEditor
      context={{
        ...context,
        onSaved: (note) => {
          context.onSaved(note);
          if (creating) onCreated?.(id);
        },
      }}
      label={label}
      heading={!creating}
      change={change}
      dirty={dirty}
      secrets={secretValuesOut}
      onSecretsDropped={() => setValues({})}
      // Editing: a `name` refusal means the Provider is gone; say so above the actions.
      fieldNames={[
        ...(creating ? ["name"] : []),
        "base_url",
        "secret_env",
        "secrets",
        "env",
      ]}
      reviewFacts={
        creating ? undefined : (
          <SharedFacts label="Provider" name={id} used={used} />
        )
      }
      fields={(server) => (
        <ProviderFields
          creating={creating}
          id={id}
          used={used}
          keys={keys}
          draft={draft}
          envRows={envRows}
          secretRows={secretRows}
          edits={edits}
          setEdits={setEdits}
          values={values}
          setValue={(row, value) =>
            setValues((old) => ({ ...old, [row]: value }))
          }
          patchScalar={patchScalar}
          addRow={() => nextRow.current++}
          problems={{
            ...problems,
            id:
              problems.id ??
              (server?.field === "name" ? server.message : undefined),
            base_url:
              problems.base_url ??
              (server?.field === "base_url" ? server.message : undefined),
            secrets:
              problems.secrets ??
              (server?.field === "secrets" ||
              server?.field === "secret_env" ||
              server?.field === "env"
                ? server.message
                : undefined),
          }}
        />
      )}
    />
  );
}

function ProviderFields({
  creating,
  id,
  used,
  keys,
  draft,
  envRows,
  secretRows,
  edits,
  setEdits,
  values,
  setValue,
  patchScalar,
  addRow,
  problems,
}: {
  creating: boolean;
  id: string;
  used: readonly string[];
  keys: readonly string[];
  draft: Record<Scalar, string>;
  envRows: NonNullable<LaunchProviderView["env"]>;
  secretRows: readonly LaunchProviderSecret[];
  edits: ProviderEdits;
  setEdits: (update: (old: ProviderEdits) => ProviderEdits) => void;
  values: Readonly<Record<string, string>>;
  setValue: (row: string, value: string) => void;
  patchScalar: (key: Scalar, value: string) => void;
  addRow: () => number;
  problems: Record<string, string | undefined>;
}) {
  const harnesses = HARNESSES.includes(draft.harness as never)
    ? HARNESSES
    : [draft.harness, ...HARNESSES].filter(Boolean);
  const editEnv = (name: string, edit: EnvEdit | undefined) =>
    setEdits((old) => {
      const env = { ...old.env };
      if (edit) env[name] = edit;
      else delete env[name];
      return { ...old, env };
    });
  const editSecret = (env: string, edit: SecretEdit | undefined) =>
    setEdits((old) => {
      const secrets = { ...old.secrets };
      if (edit && Object.values(edit).some((v) => v !== undefined))
        secrets[env] = edit;
      else delete secrets[env];
      return { ...old, secrets };
    });
  const patchAddedEnv = (row: number, next: Partial<AddedEnv> | null) =>
    setEdits((old) => ({
      ...old,
      addedEnv: old.addedEnv.flatMap((r) =>
        r.row !== row ? [r] : next ? [{ ...r, ...next }] : [],
      ),
    }));
  const patchAddedSecret = (row: number, next: Partial<AddedSecret> | null) =>
    setEdits((old) => ({
      ...old,
      addedSecrets: old.addedSecrets.flatMap((r) =>
        r.row !== row ? [r] : next ? [{ ...r, ...next }] : [],
      ),
    }));
  return (
    <>
      {creating ? (
        <TextField
          label="ID"
          error={problems.id}
          value={draft.id}
          onChange={(value) => patchScalar("id", value)}
        />
      ) : (
        <SettingsFacts>
          <SettingsFact label="ID">
            <code>{id}</code>
          </SettingsFact>
          <SettingsFact label="使用它的配置">
            {used.length ? used.join("、") : "—"}
          </SettingsFact>
        </SettingsFacts>
      )}
      <TextField
        label="名称"
        error={problems.name}
        value={draft.name}
        onChange={(value) => patchScalar("name", value)}
      />
      <SettingsField label="Harness" error={problems.harness}>
        {(field) => (
          <SelectControl
            value={draft.harness}
            aria-invalid={field.invalid}
            aria-describedby={field.describedBy}
            onValueChange={(value) => patchScalar("harness", value)}
          >
            <option value="">不指定</option>
            {harnesses.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </SelectControl>
        )}
      </SettingsField>
      <label>
        协议
        <SelectControl
          value={draft.api}
          onValueChange={(value) => patchScalar("api", value)}
        >
          <option value="">不指定</option>
          {PROVIDER_APIS.map((api) => (
            <option key={api} value={api}>
              {api}
            </option>
          ))}
        </SelectControl>
      </label>
      <TextField
        label="端点"
        error={problems.base_url}
        value={draft.base_url}
        url
        onChange={(value) => patchScalar("base_url", value)}
      />
      {envRows.map((row) => {
        const edit = edits.env[row.name];
        if (edit?.removed)
          return (
            <fieldset key={`env:${row.name}`}>
              <legend>环境变量 {row.name}</legend>
              <SettingsDiff op="remove">将移除</SettingsDiff>
              <SettingsDialogActions>
                <Button onClick={() => editEnv(row.name, undefined)}>
                  撤销移除
                </Button>
              </SettingsDialogActions>
            </fieldset>
          );
        const hidden = row.value === null && edit?.value === undefined;
        return (
          <fieldset key={`env:${row.name}`}>
            <legend>环境变量 {row.name}</legend>
            {hidden ? (
              <SettingsFacts>
                <SettingsFact label="值">已隐藏</SettingsFact>
              </SettingsFacts>
            ) : (
              <TextField
                label="值"
                error={problems[`env:${row.name}`]}
                value={edit?.value ?? row.value ?? ""}
                onChange={(value) =>
                  editEnv(row.name, value === row.value ? undefined : { value })
                }
              />
            )}
            <SettingsDialogActions>
              {hidden && (
                <Button onClick={() => editEnv(row.name, { value: "" })}>
                  替换
                </Button>
              )}
              <Button onClick={() => editEnv(row.name, { removed: true })}>
                移除
              </Button>
            </SettingsDialogActions>
          </fieldset>
        );
      })}
      {edits.addedEnv.map((row) => (
        <fieldset key={`env+${row.row}`}>
          <legend>新环境变量</legend>
          <TextField
            label="变量名"
            error={problems[`env+${row.row}`]}
            value={row.name}
            onChange={(name) => patchAddedEnv(row.row, { name })}
          />
          <TextField
            label="值"
            error={undefined}
            value={row.value}
            onChange={(value) => patchAddedEnv(row.row, { value })}
          />
          <SettingsDialogActions>
            <Button onClick={() => patchAddedEnv(row.row, null)}>移除</Button>
          </SettingsDialogActions>
        </fieldset>
      ))}
      <SettingsDialogActions>
        <Button
          onClick={() =>
            setEdits((old) => ({
              ...old,
              addedEnv: [
                ...old.addedEnv,
                { row: addRow(), name: "", value: "" },
              ],
            }))
          }
        >
          添加环境变量
        </Button>
      </SettingsDialogActions>
      {secretRows.map((row) => {
        const edit = edits.secrets[row.env];
        if (edit?.removed)
          return (
            <fieldset key={`secret:${row.env}`}>
              <legend>密钥变量 {row.env}</legend>
              <SettingsDiff op="remove">
                将移除（secrets.env 中的值保留）
              </SettingsDiff>
              <SettingsDialogActions>
                <Button onClick={() => editSecret(row.env, undefined)}>
                  撤销移除
                </Button>
              </SettingsDialogActions>
            </fieldset>
          );
        const key = edit?.key ?? row.key;
        return (
          <fieldset key={`secret:${row.env}`}>
            <legend>密钥变量 {row.env}</legend>
            <SettingsFacts>
              <SettingsFact label="状态">
                {edit?.mode === "clear" ? (
                  <SettingsDiff op="remove">将清除</SettingsDiff>
                ) : (
                  <SecretStatus secret={row} />
                )}
              </SettingsFact>
            </SettingsFacts>
            <SettingsField label={`密钥引用 ${row.env}`} error={undefined}>
              {(field) => (
                <SelectControl
                  value={key}
                  aria-invalid={field.invalid}
                  aria-describedby={field.describedBy}
                  onValueChange={(next) =>
                    editSecret(row.env, {
                      ...edit,
                      key: next === row.key ? undefined : next,
                    })
                  }
                >
                  {/* A key secrets.env does not have yet stays visible, not choosable; “填写” sets it. */}
                  {!keys.includes(key) && (
                    <option value={key} disabled>
                      {key}（未设置）
                    </option>
                  )}
                  {keys.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </SelectControl>
              )}
            </SettingsField>
            {edit?.mode === "replace" && (
              <SecretInput
                label={`新密钥 ${key}`}
                error={problems[`secret:${row.env}`]}
                value={values[`s:${row.env}`] ?? ""}
                onChange={(value) => setValue(`s:${row.env}`, value)}
              />
            )}
            <SettingsDialogActions>
              {edit?.mode ? (
                <Button
                  onClick={() => {
                    setValue(`s:${row.env}`, "");
                    editSecret(row.env, { ...edit, mode: undefined });
                  }}
                >
                  {edit.mode === "clear" ? "撤销清除" : "撤销替换"}
                </Button>
              ) : (
                <>
                  <Button
                    onClick={() =>
                      editSecret(row.env, { ...edit, mode: "replace" })
                    }
                  >
                    {row.set ? "替换" : "填写"}
                  </Button>
                  {row.set && (
                    <Button
                      onClick={() =>
                        editSecret(row.env, { ...edit, mode: "clear" })
                      }
                    >
                      清除
                    </Button>
                  )}
                </>
              )}
              <Button
                onClick={() => {
                  setValue(`s:${row.env}`, "");
                  editSecret(row.env, { removed: true });
                }}
              >
                移除
              </Button>
            </SettingsDialogActions>
          </fieldset>
        );
      })}
      {edits.addedSecrets.map((row) => {
        const key = row.key ?? suggestedKey(id, row.env.trim());
        return (
          <fieldset key={`secret+${row.row}`}>
            <legend>新密钥变量</legend>
            <TextField
              label="变量名"
              error={undefined}
              value={row.env}
              onChange={(env) => patchAddedSecret(row.row, { env })}
            />
            <TextField
              label="secrets.env 键名"
              error={undefined}
              value={key}
              onChange={(next) => patchAddedSecret(row.row, { key: next })}
            />
            <SecretInput
              label="密钥"
              error={problems[`secret+${row.row}`]}
              value={values[`n:${row.row}`] ?? ""}
              onChange={(value) => setValue(`n:${row.row}`, value)}
            />
            <SettingsDialogActions>
              <Button
                onClick={() => {
                  setValue(`n:${row.row}`, "");
                  patchAddedSecret(row.row, null);
                }}
              >
                移除
              </Button>
            </SettingsDialogActions>
          </fieldset>
        );
      })}
      {problems.secrets && (
        <SettingsWarning role="alert">{problems.secrets}</SettingsWarning>
      )}
      <SettingsDialogActions>
        <Button
          onClick={() =>
            setEdits((old) => ({
              ...old,
              addedSecrets: [
                ...old.addedSecrets,
                { row: addRow(), env: "", key: undefined },
              ],
            }))
          }
        >
          添加密钥变量
        </Button>
      </SettingsDialogActions>
    </>
  );
}

/** Set or not, and when the Web last wrote it; never a value. */
export function SecretStatus({ secret }: { secret: LaunchProviderSecret }) {
  return (
    <>
      <StatusTag
        status={secret.set ? "passed" : "blocked"}
        label={secret.set ? "已设置" : "未设置"}
      />
      {secret.updated_at && (
        <>
          {" "}
          最后修改 <Time value={secret.updated_at} />
        </>
      )}
    </>
  );
}

/** A write-only secret: a password field the browser must not remember. */
function SecretInput({
  label,
  error,
  value,
  onChange,
}: {
  label: string;
  error: string | undefined;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <SettingsField label={label} error={error}>
      {(field) => (
        <Input
          type="password"
          value={value}
          autoComplete="new-password"
          spellCheck={false}
          aria-invalid={field.invalid}
          aria-describedby={field.describedBy}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </SettingsField>
  );
}

/** A shared alias or Provider and the profiles that follow a change to it. */
function SharedFacts({
  label,
  name,
  used,
}: {
  label: string;
  name: string;
  used: readonly string[];
}) {
  return (
    <SettingsFacts>
      <SettingsFact label={label}>
        <code>{name}</code>
      </SettingsFact>
      <SettingsFact label="使用它的配置">
        {used.length ? used.join("、") : "—"}
      </SettingsFact>
    </SettingsFacts>
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
  // The person's edit, if any; otherwise the latest read (see `ProfileForm`).
  const [edit, setEdit] = useState<string>();
  const id = edit ?? initial;
  // Typing the read's value back is no longer an edit.
  const setId = (value: string) =>
    setEdit(value === initial ? undefined : value);
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
      reviewFacts={<SharedFacts label="别名" name={alias} used={used} />}
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
