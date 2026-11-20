import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CardiganClient,
  LaunchModelMetadata,
  LaunchProfileCheck,
  LaunchProfileReference,
  LaunchProfileView,
  LaunchSettingsView,
} from "../api.js";
import { Drawer } from "../components/Drawer.js";
import { EmptyState, StatusTag, Time } from "../components/Foundation.js";
import { CardDetailLayout } from "../components/layout/CardDetailLayout.js";
import { DataTableCell } from "../components/layout/DataTableLayout.js";
import {
  SettingsDialogActions,
  SettingsFact,
  SettingsFacts,
  SettingsPanel,
  SettingsSection,
  SettingsTable,
  SettingsWarning,
  settingsDrawerClassName,
  useDiscardGuard,
  useDrawerReturnFocus,
} from "../components/layout/SettingsLayout.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { Button } from "../components/ui/button.js";
import {
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.js";
import { routeHash } from "../route.js";
import { useResource } from "../useResource.js";
import {
  AliasForm,
  CopyProfileForm,
  DeleteProfileForm,
  type EditorContext,
  type LaunchFormState,
  ProfileForm,
  ProviderForm,
} from "./LaunchForms.js";
import {
  checkLabel,
  checkModeLabel,
  type LaunchProblem,
  launchProblem,
  problemLabel,
} from "./launch-change.js";

/** While a check runs, the list is read again this often (GET only). */
const CHECK_POLL_MS = 2000;

/**
 * C-518: global launch profiles (C-515 read contract). Secret values are never
 * in the response; only key names and whether each one is set.
 * C-516: create, copy, edit and delete profiles, edit model aliases and
 * providers (preview → confirm), and person-started checks.
 */
export function ModelsSettings({
  client,
  projectId,
}: {
  client: CardiganClient;
  projectId: string;
}) {
  const load = useCallback(() => client.launchSettings(), [client]);
  const settings = useResource(load);
  // The clicked row of this response: names may be redacted to the same mask.
  const [open, setOpen] = useState<{ index: number; name: string }>();
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState("");
  const newProfile = useRef<HTMLButtonElement>(null);
  const { remember } = useDrawerReturnFocus(
    open !== undefined || creating,
    () => newProfile.current,
  );
  const data = settings.data;
  const profile = data && open && locate(data.profiles, open);
  const running = data?.profiles.some(
    (p) => p.last_check?.status === "running",
  );
  const { refresh } = settings;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new read re-arms the poll.
  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(refresh, CHECK_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [running, refresh, data]);
  const saved = (note: string) => {
    setMessage(note);
    settings.reload();
  };
  return (
    <SettingsPanel
      id="models"
      tabIndex={-1}
      title="模型"
      titleId="models-title"
      actions={
        <Button
          ref={newProfile}
          variant="primary"
          aria-haspopup="dialog"
          disabled={!data}
          onClick={() => {
            remember();
            setMessage("");
            setCreating(true);
          }}
        >
          新建启动配置
        </Button>
      }
    >
      <RequestFeedback message={message} />
      <RequestFeedback
        {...settings}
        retry={settings.reload}
        pendingMessage="正在加载启动配置…"
      />
      {data && data.profiles.length === 0 && (
        <EmptyState>没有启动配置</EmptyState>
      )}
      {data && data.profiles.length > 0 && (
        <SettingsTable aria-label="启动配置">
          <TableHeader>
            <TableRow>
              <TableHead>配置</TableHead>
              <TableHead>Harness</TableHead>
              <TableHead>模型</TableHead>
              <TableHead>参数</TableHead>
              <TableHead>密钥</TableHead>
              <TableHead>引用</TableHead>
              <TableHead>最近检查</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.profiles.map((p, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: names are not unique once redacted; the response order is the identity.
              <TableRow key={index}>
                <DataTableCell data-record="lead">
                  <Button
                    variant="link"
                    aria-haspopup="dialog"
                    onClick={() => {
                      remember();
                      setMessage("");
                      setOpen({ index, name: p.name });
                    }}
                  >
                    {p.name}
                  </Button>
                </DataTableCell>
                <DataTableCell nowrap data-label="Harness">
                  {p.harness}
                </DataTableCell>
                <DataTableCell data-label="模型">
                  <ModelName profile={p} />
                </DataTableCell>
                <DataTableCell data-label="参数">
                  {parameterSummary(p.parameters)}
                </DataTableCell>
                <DataTableCell nowrap data-label="密钥">
                  {secretSummary(p.secrets)}
                </DataTableCell>
                <DataTableCell nowrap data-label="引用">
                  {p.references.length}
                </DataTableCell>
                <DataTableCell nowrap data-record="aside">
                  <CheckStatus check={p.last_check} />
                </DataTableCell>
              </TableRow>
            ))}
          </TableBody>
        </SettingsTable>
      )}
      {data && profile && (
        <ProfileDetail
          client={client}
          settings={data}
          profile={profile}
          projectId={projectId}
          onRefreshed={settings.replace}
          onRefresh={refresh}
          onSaved={saved}
          onDeleted={(note) => {
            setOpen(undefined);
            saved(note);
          }}
          onClose={() => setOpen(undefined)}
        />
      )}
      {data && creating && (
        <NewProfile
          client={client}
          settings={data}
          onRefreshed={settings.replace}
          onSaved={(note) => {
            setCreating(false);
            saved(note);
          }}
          onClose={() => setCreating(false)}
        />
      )}
    </SettingsPanel>
  );
}

/** The opened row after a new read: same position and name, else the only one by that name. */
function locate(
  profiles: readonly LaunchProfileView[],
  open: { index: number; name: string },
) {
  if (profiles[open.index]?.name === open.name) return profiles[open.index];
  const named = profiles.filter((p) => p.name === open.name);
  return named.length === 1 ? named[0] : undefined;
}

/**
 * A drawer holding a launch settings form: closing it with unapplied edits
 * asks first, and nothing closes it while a preview or save is in flight.
 */
function useFormDrawer() {
  const [form, setForm] = useState<LaunchFormState>({
    dirty: false,
    busy: false,
  });
  const target = useRef<() => void>(() => {});
  const guard = useDiscardGuard(
    form.dirty,
    useCallback(() => target.current(), []),
  );
  const onState = useCallback(
    (next: LaunchFormState) =>
      setForm((old) =>
        old.dirty === next.dirty && old.busy === next.busy ? old : next,
      ),
    [],
  );
  return {
    busy: form.busy,
    onState,
    /** Leave the form by `go`, asking first when it holds unapplied edits. */
    leave: (go: () => void) => {
      if (form.busy) return;
      target.current = go;
      guard.confirmClose();
    },
    reset: () => setForm({ dirty: false, busy: false }),
    dialog: guard.dialog,
  };
}

function NewProfile({
  client,
  settings,
  onRefreshed,
  onSaved,
  onClose,
}: {
  client: CardiganClient;
  settings: LaunchSettingsView;
  onRefreshed: (settings: LaunchSettingsView) => void;
  onSaved: (message: string) => void;
  onClose: () => void;
}) {
  const drawer = useFormDrawer();
  const context: EditorContext = {
    client,
    settings,
    onRefreshed,
    onSaved,
    onCancel: () => drawer.leave(onClose),
    onState: drawer.onState,
  };
  return (
    <Drawer
      className={settingsDrawerClassName}
      open
      onOpenChange={(next) => !next && drawer.leave(onClose)}
      title="新建启动配置"
      description="新建启动配置"
      initialFocus="close"
    >
      <CardDetailLayout className="card-page-drawer">
        <ProfileForm context={context} />
        {drawer.dialog}
      </CardDetailLayout>
    </Drawer>
  );
}

function ModelName({ profile }: { profile: LaunchProfileView }) {
  if (!profile.model_id) return <>—</>;
  return profile.model_alias && profile.model_alias !== profile.model_id ? (
    <>
      {profile.model_alias} → <code>{profile.model_id}</code>
    </>
  ) : (
    <code>{profile.model_id}</code>
  );
}

const parameterSummary = (p: LaunchProfileView["parameters"]) => {
  const parts = [
    p.effort && `effort ${p.effort}`,
    p.permission_mode,
    p.provider_flag && `provider ${p.provider_flag}`,
    p.auto_update !== null && (p.auto_update ? "自动更新" : "不自动更新"),
    p.custom_args_count > 0 && `自定义参数 ${p.custom_args_count}`,
    p.custom_config_count > 0 && `自定义配置 ${p.custom_config_count}`,
  ].filter(Boolean);
  return parts.length ? parts.join("、") : "—";
};

const secretSummary = (secrets: LaunchProfileView["secrets"]) => {
  if (secrets.length === 0) return "—";
  const missing = secrets.filter((s) => !s.set).length;
  return missing ? `${missing} 项未设置` : "已设置";
};

function CheckStatus({ check }: { check: LaunchProfileCheck | null }) {
  return check ? (
    <StatusTag status={check.status} label={checkLabel(check)} />
  ) : (
    <StatusTag status="not_run" label="未检查" />
  );
}

const count = new Intl.NumberFormat("zh-CN");
const tokens = (value: number | undefined) =>
  value === undefined ? "—" : `${count.format(value)} tokens`;
const price = (cost: LaunchModelMetadata["cost"]) =>
  cost ? `输入 $${cost.input} · 输出 $${cost.output}（每百万 tokens）` : "—";
const list = (values: readonly string[] | undefined) =>
  values?.length ? values.join("、") : "—";

type DetailMode =
  | { readonly kind: "view" }
  | { readonly kind: "edit" | "copy" | "delete" }
  | { readonly kind: "provider"; readonly id: string }
  | { readonly kind: "alias"; readonly alias: string };

function ProfileDetail({
  client,
  settings,
  profile,
  projectId,
  onRefreshed,
  onRefresh,
  onSaved,
  onDeleted,
  onClose,
}: {
  client: CardiganClient;
  settings: LaunchSettingsView;
  profile: LaunchProfileView;
  projectId: string;
  onRefreshed: (settings: LaunchSettingsView) => void;
  onRefresh: () => void;
  onSaved: (message: string) => void;
  onDeleted: (message: string) => void;
  onClose: () => void;
}) {
  const meta = profile.metadata;
  const provider = settings.providers.find((v) => v.id === profile.provider);
  const [mode, setMode] = useState<DetailMode>({ kind: "view" });
  const drawer = useFormDrawer();
  const view = () => {
    drawer.reset();
    setMode({ kind: "view" });
  };
  const context: EditorContext = {
    client,
    settings,
    onRefreshed,
    onSaved: (note) => {
      if (mode.kind === "delete") onDeleted(note);
      else {
        view();
        onSaved(note);
      }
    },
    onCancel: () => drawer.leave(view),
    onState: drawer.onState,
  };
  const editProvider =
    mode.kind === "provider"
      ? settings.providers.find((v) => v.id === mode.id)
      : undefined;
  return (
    <Drawer
      className={settingsDrawerClassName}
      open
      onOpenChange={(next) => !next && drawer.leave(onClose)}
      title={profile.name}
      description={`启动配置 ${profile.name} 详情`}
      initialFocus="close"
      actions={
        mode.kind === "view" ? (
          <>
            <Button onClick={() => setMode({ kind: "copy" })}>复制</Button>
            <Button onClick={() => setMode({ kind: "delete" })}>删除</Button>
            <Button variant="primary" onClick={() => setMode({ kind: "edit" })}>
              编辑
            </Button>
          </>
        ) : undefined
      }
    >
      <CardDetailLayout
        className="card-page-drawer"
        aria-label={`启动配置 ${profile.name}`}
      >
        {mode.kind === "edit" && (
          <ProfileForm context={context} profile={profile} />
        )}
        {mode.kind === "copy" && (
          <CopyProfileForm context={context} source={profile} />
        )}
        {mode.kind === "delete" && (
          <DeleteProfileForm context={context} profile={profile} />
        )}
        {editProvider && (
          <ProviderForm context={context} provider={editProvider} />
        )}
        {mode.kind === "alias" && (
          <AliasForm context={context} alias={mode.alias} />
        )}
        {mode.kind === "view" && (
          <>
            <SettingsSection title="配置">
              <SettingsFacts>
                <SettingsFact label="Harness">{profile.harness}</SettingsFact>
                <SettingsFact label="Provider">
                  {provider ? (
                    <>
                      {provider.name} <code>{provider.id}</code>
                    </>
                  ) : (
                    (profile.provider ?? "—")
                  )}
                </SettingsFact>
                <SettingsFact label="端点">
                  {provider?.base_url ? <code>{provider.base_url}</code> : "—"}
                </SettingsFact>
                <SettingsFact label="模型别名">
                  {profile.model_alias ?? "—"}
                </SettingsFact>
                <SettingsFact label="模型标识">
                  {profile.model_id ? <code>{profile.model_id}</code> : "—"}
                </SettingsFact>
                <SettingsFact label="参数">
                  {parameterSummary(profile.parameters)}
                </SettingsFact>
                <SettingsFact label="CLI 版本">
                  {profile.cli.version ?? "—"}
                </SettingsFact>
                <SettingsFact label="CLI 路径">
                  {profile.cli.path ? <code>{profile.cli.path}</code> : "—"}
                </SettingsFact>
              </SettingsFacts>
              {(provider || profile.model_alias) && (
                <SettingsDialogActions>
                  {provider && (
                    <Button
                      onClick={() =>
                        setMode({ kind: "provider", id: provider.id })
                      }
                    >
                      编辑 Provider
                    </Button>
                  )}
                  {profile.model_alias && (
                    <Button
                      onClick={() =>
                        setMode({
                          kind: "alias",
                          alias: profile.model_alias ?? "",
                        })
                      }
                    >
                      编辑模型别名
                    </Button>
                  )}
                </SettingsDialogActions>
              )}
            </SettingsSection>
            <SettingsSection title="模型元数据">
              <SettingsFacts>
                <SettingsFact label="上下文窗口">
                  {tokens(meta?.context_window)}
                </SettingsFact>
                <SettingsFact label="最大输出">
                  {tokens(meta?.max_output_tokens)}
                </SettingsFact>
                <SettingsFact label="价格">{price(meta?.cost)}</SettingsFact>
                <SettingsFact label="推理强度">
                  {list(meta?.reasoning_efforts)}
                </SettingsFact>
              </SettingsFacts>
            </SettingsSection>
            <SettingsSection title="密钥">
              {profile.secrets.length === 0 ? (
                <EmptyState>不需要密钥</EmptyState>
              ) : (
                <SettingsFacts>
                  {profile.secrets.map((s) => (
                    <SettingsFact key={s.key} label={<code>{s.key}</code>}>
                      <StatusTag
                        status={s.set ? "passed" : "blocked"}
                        label={s.set ? "已设置" : "未设置"}
                      />
                    </SettingsFact>
                  ))}
                </SettingsFacts>
              )}
            </SettingsSection>
            <Checks
              client={client}
              settings={settings}
              profile={profile}
              onRefreshed={onRefreshed}
              onRefresh={onRefresh}
            />
            <SettingsSection title="使用者">
              {profile.references.length === 0 ? (
                <EmptyState>没有角色或员工使用</EmptyState>
              ) : (
                <References refs={profile.references} projectId={projectId} />
              )}
            </SettingsSection>
          </>
        )}
        {drawer.dialog}
      </CardDetailLayout>
    </Drawer>
  );
}

/**
 * Checks run only when the person clicks: a local check (CLI, secrets, model
 * metadata) or an online check that lists the provider's models. Neither
 * calls inference, so a passed online check is reported as “已列出模型”.
 */
function Checks({
  client,
  settings,
  profile,
  onRefreshed,
  onRefresh,
}: {
  client: CardiganClient;
  settings: LaunchSettingsView;
  profile: LaunchProfileView;
  onRefreshed: (settings: LaunchSettingsView) => void;
  onRefresh: () => void;
}) {
  const [starting, setStarting] = useState<LaunchProfileCheck["mode"]>();
  const [problem, setProblem] = useState<LaunchProblem>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const running = profile.last_check?.status === "running";
  const start = async (mode: LaunchProfileCheck["mode"]) => {
    if (starting || running) return;
    setStarting(mode);
    setProblem(undefined);
    try {
      await client.startLaunchCheck(settings.version, profile.name, mode);
    } catch (error) {
      if (alive.current) setProblem(launchProblem(error, "check"));
    } finally {
      if (alive.current) setStarting(undefined);
      // Running, refused or stale: the next read shows the latest state.
      onRefresh();
    }
  };
  return (
    <SettingsSection title="检查">
      {profile.last_check ? (
        <LastCheck check={profile.last_check} />
      ) : (
        <EmptyState>未检查</EmptyState>
      )}
      {problem && (
        <SettingsWarning role="alert">
          {problem.kind === "stale" ? (
            <>
              <p>启动配置已在别处修改，检查没有开始。</p>
              <SettingsDialogActions>
                <Button
                  onClick={async () => {
                    setProblem(undefined);
                    try {
                      onRefreshed(await client.launchSettings());
                    } catch (error) {
                      if (alive.current)
                        setProblem(launchProblem(error, "check"));
                    }
                  }}
                >
                  刷新
                </Button>
              </SettingsDialogActions>
            </>
          ) : problem.kind === "in_use" ? null : (
            problem.message
          )}
        </SettingsWarning>
      )}
      <SettingsDialogActions>
        <Button
          disabled={starting !== undefined || running}
          onClick={() => void start("metadata")}
        >
          {starting === "metadata" ? "正在开始…" : "本地检查"}
        </Button>
        <Button
          disabled={starting !== undefined || running}
          onClick={() => void start("online")}
        >
          {starting === "online" ? "正在开始…" : "在线探测"}
        </Button>
      </SettingsDialogActions>
    </SettingsSection>
  );
}

function LastCheck({ check }: { check: LaunchProfileCheck }) {
  return (
    <SettingsFacts>
      <SettingsFact label="结果">
        <CheckStatus check={check} />
      </SettingsFact>
      <SettingsFact label="方式">{checkModeLabel(check.mode)}</SettingsFact>
      <SettingsFact label="开始">
        <Time value={check.started_at} />
      </SettingsFact>
      <SettingsFact label="完成">
        {check.finished_at ? <Time value={check.finished_at} /> : "—"}
      </SettingsFact>
      <SettingsFact label="CLI 版本">{check.cli_version ?? "—"}</SettingsFact>
      <SettingsFact label="问题">
        {check.problems.length
          ? check.problems.map((p) => (
              <span key={p}>
                {problemLabel(p) ?? ""} <code>{p}</code>{" "}
              </span>
            ))
          : "—"}
      </SettingsFact>
    </SettingsFacts>
  );
}

/** Roles open the referenced version in that project's settings; employees their work on the execution page. */
function References({
  refs,
  projectId,
}: {
  refs: readonly LaunchProfileReference[];
  projectId: string;
}) {
  return (
    <SettingsTable aria-label="使用者">
      <TableHeader>
        <TableRow>
          <TableHead>名称</TableHead>
          <TableHead>类型</TableHead>
          <TableHead>编号</TableHead>
          <TableHead>项目</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {refs.map((ref) =>
          "role_id" in ref ? (
            <TableRow
              key={`role:${ref.project_id}:${ref.role_id}:${ref.version}`}
            >
              <DataTableCell data-record="lead">
                <Button asChild variant="link">
                  <a
                    href={routeHash({
                      kind: "settings",
                      projectId: ref.project_id,
                      filters: {
                        tab: "roles",
                        role: ref.role_id,
                        version: String(ref.version),
                      },
                    })}
                  >
                    {ref.name}
                  </a>
                </Button>
              </DataTableCell>
              <DataTableCell nowrap data-label="类型">
                角色
              </DataTableCell>
              <DataTableCell nowrap data-label="编号">
                <code>{ref.role_id}</code> v{ref.version}
              </DataTableCell>
              <DataTableCell nowrap data-record="aside">
                {ref.project_id}
              </DataTableCell>
            </TableRow>
          ) : (
            <TableRow key={`employee:${ref.employee_id}`}>
              <DataTableCell data-record="lead">
                <Button asChild variant="link">
                  <a
                    href={routeHash({
                      kind: "execution",
                      projectId,
                      // Exact employee, any status: idle employees still land on their records.
                      filters: { view: "all", employee: ref.employee_id },
                    })}
                  >
                    {ref.name}
                  </a>
                </Button>
              </DataTableCell>
              <DataTableCell nowrap data-label="类型">
                员工
              </DataTableCell>
              <DataTableCell nowrap data-label="编号">
                <code>{ref.employee_id}</code>
              </DataTableCell>
              <DataTableCell nowrap data-record="aside">
                全局
              </DataTableCell>
            </TableRow>
          ),
        )}
      </TableBody>
    </SettingsTable>
  );
}
