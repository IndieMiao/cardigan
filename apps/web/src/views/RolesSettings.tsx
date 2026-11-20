import { HARNESSES } from "@cardigan/domain";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CardiganClient,
  describeWriteError,
  type LaunchProfileOption,
  type RoleDefinitionView,
  type RoleDetailView,
  type RoleEditInput,
  type RoleKind,
  type RoleListView,
  type RoleWorktree,
} from "../api.js";
import { Drawer } from "../components/Drawer.js";
import { EmployeeIdentity } from "../components/EmployeeIdentity.js";
import { EmptyState, StatusTag, Time } from "../components/Foundation.js";
import { CardDetailLayout } from "../components/layout/CardDetailLayout.js";
import { DataTableCell } from "../components/layout/DataTableLayout.js";
import {
  SettingsDialogActions,
  SettingsDialogFields,
  SettingsFact,
  SettingsFacts,
  SettingsHelp,
  SettingsMarkdown,
  SettingsPanel,
  SettingsSection,
  SettingsTable,
  SettingsText,
  SettingsWarning,
  settingsDrawerClassName,
  useDiscardGuard,
  useDrawerReturnFocus,
} from "../components/layout/SettingsLayout.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { Button } from "../components/ui/button.js";
import { Checkbox } from "../components/ui/checkbox.js";
import { Input } from "../components/ui/input.js";
import { SelectControl } from "../components/ui/select-control.js";
import {
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.js";
import { Textarea } from "../components/ui/textarea.js";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group.js";
import { employeeCopy } from "../employee-copy.js";
import {
  parseList,
  ROLE_FIELD_LABELS,
  ROLE_KIND_LABELS,
  ROLE_VERSION_PIN_NOTICE,
  roleDiff,
  roleRelaxations,
  WORKTREE_LABELS,
} from "../role-diff.js";
import { useResource } from "../useResource.js";
import {
  RoleDiffView,
  RoleImportDrawer,
  RoleTemplateDrawer,
} from "./RoleDocument.js";

/** What the role drawer shows; the list stays in the panel behind it. */
type View =
  | { readonly kind: "new" }
  | { readonly kind: "import" }
  | { readonly kind: "detail"; readonly roleId: string }
  | { readonly kind: "edit"; readonly roleId: string }
  | {
      readonly kind: "template";
      readonly roleId: string;
      readonly role: RoleDefinitionView;
    };

/** One idempotency key per distinct input, kept until it succeeds (C-16). */
function useRoleWrite() {
  const keys = useRef(new Map<string, string>());
  const sending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = useCallback(
    async <T,>(
      input: unknown,
      action: (key: string) => Promise<T>,
    ): Promise<T | undefined> => {
      if (sending.current) return undefined;
      sending.current = true;
      setBusy(true);
      setError("");
      const id = JSON.stringify(input);
      const key = keys.current.get(id) ?? crypto.randomUUID();
      keys.current.set(id, key);
      try {
        const result = await action(key);
        keys.current.delete(id);
        // A form that is gone (another project) must not act on its reply.
        return alive.current ? result : undefined;
      } catch (cause) {
        if (alive.current) setError(describeWriteError(cause));
        return undefined;
      } finally {
        sending.current = false;
        if (alive.current) setBusy(false);
      }
    },
    [],
  );
  return { busy, error, submit };
}

export function RolesSettings({
  client,
  projectId,
  revision = 0,
  onNewEmployee,
}: {
  client: CardiganClient;
  projectId: string;
  revision?: number;
  onNewEmployee?: (roleId: string) => void;
}) {
  const [view, setView] = useState<View>();
  const [createdRole, setCreatedRole] = useState<string>();
  const [message, setMessage] = useState("");
  const load = useCallback(() => client.roles(projectId), [client, projectId]);
  const list = useResource(load, revision);
  const { remember } = useDrawerReturnFocus(view !== undefined);
  const open = (next: View | undefined, note = "") => {
    if (next) remember();
    setMessage(note);
    setView(next);
    if (next === undefined) list.reload();
  };
  const roleId =
    view?.kind === "detail" || view?.kind === "edit" ? view.roleId : undefined;
  return (
    <SettingsPanel
      id="roles"
      tabIndex={-1}
      title="角色"
      titleId="roles-title"
      actions={
        <>
          <Button onClick={() => open({ kind: "import" })}>
            从 Markdown 导入
          </Button>
          <Button variant="primary" onClick={() => open({ kind: "new" })}>
            新建角色
          </Button>
        </>
      }
    >
      <RequestFeedback message={view === undefined ? message : undefined} />
      <RequestFeedback
        {...list}
        retry={list.reload}
        pendingMessage="正在加载角色…"
      />
      {list.data && list.data.roles.length === 0 && (
        <EmptyState>没有角色</EmptyState>
      )}
      {list.data && list.data.roles.length > 0 && (
        <RoleList
          list={list.data}
          onOpen={(id) => open({ kind: "detail", roleId: id })}
        />
      )}
      {view?.kind === "import" && (
        <RoleImportDrawer
          client={client}
          projectId={projectId}
          onClose={() => open(undefined)}
          onApplied={(_result, note) => open(undefined, note)}
        />
      )}
      {view?.kind === "template" && (
        <RoleTemplateDrawer
          client={client}
          projectId={projectId}
          role={view.role}
          onClose={() => open({ kind: "detail", roleId: view.roleId })}
          onApplied={(_result, note) =>
            open({ kind: "detail", roleId: view.roleId }, note)
          }
        />
      )}
      {view?.kind === "new" && (
        <NewRoleForm
          client={client}
          projectId={projectId}
          list={list.data}
          onCancel={() => open(undefined)}
          onCreated={(role) => {
            setCreatedRole(role.role_id);
            list.reload();
            open(
              { kind: "detail", roleId: role.role_id },
              `已创建角色 ${role.role_id} v${role.version}`,
            );
          }}
        />
      )}
      {roleId && (
        <RoleDetail
          key={roleId}
          client={client}
          projectId={projectId}
          roleId={roleId}
          editing={view?.kind === "edit"}
          revision={revision}
          message={message}
          profiles={list.data?.launch_profiles ?? []}
          afterCreate={
            createdRole === roleId && view?.kind === "detail"
              ? {
                  ...(onNewEmployee
                    ? { newEmployee: () => onNewEmployee(roleId) }
                    : {}),
                  addToTemplate: (role) =>
                    open({ kind: "template", roleId, role }),
                }
              : undefined
          }
          onClose={() => open(undefined)}
          onEdit={(editing) =>
            open({ kind: editing ? "edit" : "detail", roleId })
          }
          onSaved={(role, note) => {
            list.reload();
            open({ kind: "detail", roleId: role.role_id }, note);
          }}
        />
      )}
    </SettingsPanel>
  );
}

function RoleList({
  list,
  onOpen,
}: {
  list: RoleListView;
  onOpen: (roleId: string) => void;
}) {
  return (
    <SettingsTable aria-label="角色列表">
      <TableHeader>
        <TableRow>
          <TableHead>名称</TableHead>
          <TableHead>编号</TableHead>
          <TableHead>类型</TableHead>
          <TableHead>版本</TableHead>
          <TableHead>状态</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {list.roles.map((role) => (
          <TableRow key={role.role_id}>
            <DataTableCell data-record="lead">
              <Button
                variant="link"
                aria-haspopup="dialog"
                onClick={() => onOpen(role.role_id)}
              >
                {role.display_name}
              </Button>
            </DataTableCell>
            <DataTableCell nowrap data-label="编号">
              <code>{role.role_id}</code>
            </DataTableCell>
            <DataTableCell nowrap data-label="类型">
              {ROLE_KIND_LABELS[role.kind]}
            </DataTableCell>
            <DataTableCell nowrap data-label="版本">
              v{role.version}
            </DataTableCell>
            <DataTableCell nowrap data-record="aside">
              <RoleStatus status={role.status} />
            </DataTableCell>
          </TableRow>
        ))}
      </TableBody>
    </SettingsTable>
  );
}

function NewRoleForm({
  client,
  projectId,
  list,
  onCancel,
  onCreated,
}: {
  client: CardiganClient;
  projectId: string;
  list: RoleListView | undefined;
  onCancel: () => void;
  onCreated: (role: RoleDefinitionView) => void;
}) {
  const [source, setSource] = useState<"default" | "project">("default");
  const [defaultRole, setDefaultRole] = useState(
    list?.default_roles[0] ?? "coder",
  );
  const [harness, setHarness] = useState(
    list?.launch_profiles?.[0]?.harness ?? "codex",
  );
  const [profile, setProfile] = useState(
    list?.launch_profiles?.[0]?.name ?? "",
  );
  const [sourceProject, setSourceProject] = useState(projectId);
  const [sourceRole, setSourceRole] = useState("");
  const [sourceVersion, setSourceVersion] = useState("");
  const [roleId, setRoleId] = useState("");
  const [name, setName] = useState("");
  const write = useRoleWrite();
  const loadProjects = useCallback(() => client.projects(), [client]);
  const projects = useResource(loadProjects);
  const loadSource = useCallback(
    () => client.roles(sourceProject),
    [client, sourceProject],
  );
  const sourceRoles = useResource(loadSource);
  const idValid = /^[a-z0-9][a-z0-9._-]*$/u.test(roleId);
  const versionValid =
    sourceVersion === "" ||
    (/^\d+$/u.test(sourceVersion) && Number(sourceVersion) >= 1);
  const ready =
    idValid &&
    (source === "default"
      ? defaultRole !== "" && profile.trim() !== ""
      : sourceRole !== "" && versionValid);
  const profiles = list?.launch_profiles ?? [];
  const guard = useDiscardGuard(roleId !== "" || name !== "", onCancel);
  return (
    <Drawer
      className={settingsDrawerClassName}
      open
      onOpenChange={(next) => {
        // Every way out (×, Escape, the overlay) waits for the submit.
        if (!next && !write.busy) guard.confirmClose();
      }}
      title="新建角色"
      description="新建角色"
      initialFocus="close"
    >
      <CardDetailLayout className="card-page-drawer">
        <form
          aria-label="新建角色"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!ready) return;
            const input = {
              role_id: roleId,
              ...(name.trim() ? { display_name: name.trim() } : {}),
              source:
                source === "default"
                  ? {
                      kind: "default" as const,
                      role_id: defaultRole,
                      harness,
                      launch_profile_ref: profile.trim(),
                    }
                  : {
                      kind: "project" as const,
                      ...(sourceProject === projectId
                        ? {}
                        : { project_id: sourceProject }),
                      role_id: sourceRole,
                      ...(sourceVersion
                        ? { version: Number(sourceVersion) }
                        : {}),
                    },
            };
            const role = await write.submit(input, (key) =>
              client.copyRole(projectId, input, key),
            );
            if (role) onCreated(role);
          }}
        >
          <SettingsDialogFields>
            <fieldset>
              <legend>复制来源</legend>
              <ToggleGroup
                type="multiple"
                aria-label="复制来源"
                value={[source]}
                onValueChange={(next) => {
                  const value = next.at(-1);
                  if (value === "default" || value === "project")
                    setSource(value);
                }}
              >
                <ToggleGroupItem value="default">
                  从默认角色包复制
                </ToggleGroupItem>
                <ToggleGroupItem value="project">
                  从现有角色复制
                </ToggleGroupItem>
              </ToggleGroup>
            </fieldset>
            {source === "default" ? (
              <>
                <label>
                  默认角色
                  <SelectControl
                    value={defaultRole}
                    onValueChange={(e) => setDefaultRole(e)}
                  >
                    {(list?.default_roles ?? []).map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </SelectControl>
                </label>
                <label>
                  Harness
                  <SelectControl
                    value={harness}
                    onValueChange={(e) => setHarness(e)}
                  >
                    {(list?.harnesses ?? HARNESSES).map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </SelectControl>
                </label>
                <label>
                  启动配置
                  <SelectControl
                    value={profile}
                    onValueChange={(next) => {
                      setProfile(next);
                      const chosen = profiles.find((p) => p.name === next);
                      if (chosen) setHarness(chosen.harness);
                    }}
                  >
                    {launchProfileOptions(profiles, profile)}
                  </SelectControl>
                </label>
              </>
            ) : (
              <>
                <label>
                  来源项目
                  <SelectControl
                    value={sourceProject}
                    onValueChange={(e) => {
                      setSourceProject(e);
                      setSourceRole("");
                    }}
                  >
                    {(projects.data ?? [{ id: projectId }]).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.id}
                      </option>
                    ))}
                  </SelectControl>
                </label>
                <label>
                  来源角色
                  <SelectControl
                    value={sourceRole}
                    onValueChange={(e) => setSourceRole(e)}
                  >
                    <option value="">请选择</option>
                    {(sourceRoles.data?.roles ?? []).map((role) => (
                      <option key={role.role_id} value={role.role_id}>
                        {role.display_name}（{role.role_id} v{role.version}）
                      </option>
                    ))}
                  </SelectControl>
                </label>
                <RequestFeedback
                  {...sourceRoles}
                  retry={sourceRoles.reload}
                  pendingMessage="正在加载来源角色…"
                />
                <label>
                  来源版本（留空用最新版本）
                  <Input
                    inputMode="numeric"
                    aria-invalid={!versionValid || undefined}
                    value={sourceVersion}
                    onChange={(e) => setSourceVersion(e.target.value)}
                  />
                </label>
                <RequestFeedback
                  error={!versionValid ? "版本号须为正整数。" : undefined}
                />
              </>
            )}
            <label>
              新角色编号
              <Input
                value={roleId}
                aria-invalid={(roleId !== "" && !idValid) || undefined}
                onChange={(e) => setRoleId(e.target.value)}
              />
            </label>
            <RequestFeedback
              error={
                roleId !== "" && !idValid
                  ? "角色编号只能用小写字母、数字、点、下划线和短横线，且以字母或数字开头。"
                  : undefined
              }
            />
            <label>
              显示名（可选）
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          </SettingsDialogFields>
          <SettingsDialogActions>
            <Button onClick={guard.confirmClose} disabled={write.busy}>
              取消
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={write.busy || !ready}
            >
              创建角色
            </Button>
          </SettingsDialogActions>
          <RequestFeedback
            interactive
            pending={write.busy}
            pendingMessage="正在提交角色…"
            error={write.error}
          />
        </form>
        {guard.dialog}
      </CardDetailLayout>
    </Drawer>
  );
}

/**
 * C-494 item 3: launch profiles come from the host's loaded launch.yaml
 * (name, harness and model only). A saved name the host no longer has stays
 * selectable so an edit does not silently change it.
 */
function launchProfileOptions(
  profiles: readonly LaunchProfileOption[],
  value: string,
) {
  const missing = value !== "" && !profiles.some((p) => p.name === value);
  return [
    <option key="" value="">
      {profiles.length ? "请选择启动配置" : "没有可用的启动配置"}
    </option>,
    ...(missing
      ? [
          <option key={`missing:${value}`} value={value}>
            {value}（已失效）
          </option>,
        ]
      : []),
    ...profiles.map((p) => (
      <option key={p.name} value={p.name}>
        {p.name}（{p.harness} · {p.model ?? "默认模型"}）
      </option>
    )),
  ];
}

function RoleDetail({
  client,
  projectId,
  roleId,
  editing,
  revision,
  message,
  profiles,
  afterCreate,
  onClose,
  onEdit,
  onSaved,
}: {
  client: CardiganClient;
  projectId: string;
  roleId: string;
  editing: boolean;
  revision: number;
  message: string;
  profiles: readonly LaunchProfileOption[];
  /** Offered right after the role was created here. */
  afterCreate:
    | {
        readonly newEmployee?: () => void;
        readonly addToTemplate: (role: RoleDefinitionView) => void;
      }
    | undefined;
  onClose: () => void;
  onEdit: (editing: boolean) => void;
  onSaved: (role: RoleDefinitionView, note: string) => void;
}) {
  const loadDetail = useCallback(
    () => client.role(projectId, roleId),
    [client, projectId, roleId],
  );
  const loadHistory = useCallback(
    () => client.roleHistory(projectId, roleId),
    [client, projectId, roleId],
  );
  const [saves, setSaves] = useState(0);
  const detail = useResource(loadDetail, revision + saves);
  const history = useResource(loadHistory, revision + saves);
  const write = useRoleWrite();
  const saved = (role: RoleDefinitionView | undefined, note: string) => {
    if (!role) return;
    setSaves((n) => n + 1);
    onSaved(role, note);
  };
  const data = detail.data;
  const [dirty, setDirty] = useState(false);
  const guard = useDiscardGuard(editing && dirty, onClose);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const exportMarkdown = async () => {
    setExporting(true);
    setExportError("");
    try {
      const { markdown } = await client.exportRole(projectId, roleId);
      const url = URL.createObjectURL(
        new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${roleId}.md`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setExportError(describeWriteError(cause));
    } finally {
      setExporting(false);
    }
  };
  const toggleActive = async () => {
    if (!data) return;
    const active = data.role.status !== "active";
    saved(
      await write.submit({ roleId, active, from: data.role.version }, (key) =>
        client.setRoleActive(projectId, roleId, active, key),
      ),
      active ? "角色已启用" : "角色已停用，不能再被新指派",
    );
  };
  return (
    <Drawer
      className={settingsDrawerClassName}
      open
      onOpenChange={(next) => {
        // Closing waits for a save, status change or rollback in flight.
        if (!next && !write.busy) guard.confirmClose();
      }}
      title={data ? data.role.display_name : `角色 ${roleId}`}
      description={`角色 ${roleId} 详情`}
      initialFocus="close"
      actions={
        data && !editing ? (
          <>
            {afterCreate?.newEmployee && (
              <Button onClick={afterCreate.newEmployee}>
                {employeeCopy.afterRole}
              </Button>
            )}
            {afterCreate && (
              <Button
                aria-haspopup="dialog"
                onClick={() => afterCreate.addToTemplate(data.role)}
              >
                加进模板
              </Button>
            )}
            <Button disabled={exporting} onClick={() => void exportMarkdown()}>
              导出 Markdown
            </Button>
            <Button disabled={write.busy} onClick={() => void toggleActive()}>
              {data.role.status === "active" ? "停用" : "启用"}
            </Button>
            <Button
              variant="primary"
              disabled={write.busy}
              onClick={() => onEdit(true)}
            >
              编辑
            </Button>
          </>
        ) : undefined
      }
    >
      <CardDetailLayout
        className="card-page-drawer"
        aria-label={`角色 ${roleId}`}
      >
        <RequestFeedback message={message} />
        <RequestFeedback
          {...detail}
          retry={detail.reload}
          pendingMessage="正在加载角色…"
        />
        <RequestFeedback
          interactive
          pending={exporting}
          pendingMessage="正在导出…"
          error={exportError}
        />
        {data && (
          <>
            {editing ? (
              <SettingsSection title="编辑角色">
                <RoleEditForm
                  key={data.role.version}
                  detail={data}
                  profiles={profiles}
                  busy={write.busy}
                  error={write.error}
                  onDirtyChange={setDirty}
                  onCancel={() => onEdit(false)}
                  onSubmit={async (patch) =>
                    saved(
                      await write.submit({ roleId, patch }, (key) =>
                        client.updateRole(projectId, roleId, patch, key),
                      ),
                      "角色已保存，生成了新版本",
                    )
                  }
                />
              </SettingsSection>
            ) : (
              <SettingsSection title="角色内容">
                <RequestFeedback
                  interactive
                  pending={write.busy}
                  pendingMessage="正在提交角色…"
                  error={write.error}
                />
                <RoleFields role={data.role} />
              </SettingsSection>
            )}
            {!editing && (
              <SettingsSection title="与上一版本的差异">
                {data.previous ? (
                  <RoleDiffView
                    title={`v${data.previous.version} → v${data.role.version}`}
                    diffs={roleDiff(data.previous, data.role)}
                  />
                ) : (
                  <p>没有上一版本</p>
                )}
              </SettingsSection>
            )}
            <SettingsSection title="版本历史">
              <RequestFeedback
                {...history}
                retry={history.reload}
                pendingMessage="正在加载版本历史…"
              />
              {history.data && (
                <SettingsTable aria-label="版本历史">
                  <TableHeader>
                    <TableRow>
                      <TableHead>版本</TableHead>
                      <TableHead>摘要</TableHead>
                      <TableHead>作者</TableHead>
                      <TableHead>时间</TableHead>
                      <TableHead>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.data.versions.map((entry) => (
                      <TableRow key={entry.version}>
                        <DataTableCell nowrap data-record="lead">
                          v{entry.version}
                        </DataTableCell>
                        <DataTableCell data-label="摘要">
                          {entry.summary}
                        </DataTableCell>
                        <DataTableCell nowrap data-label="作者">
                          {entry.author_display ? (
                            <EmployeeIdentity
                              {...entry}
                              author_display={entry.author_display}
                              showTitle={false}
                            />
                          ) : (
                            "—"
                          )}
                        </DataTableCell>
                        <DataTableCell nowrap data-label="时间">
                          {entry.created_at ? (
                            <Time value={entry.created_at} />
                          ) : (
                            "—"
                          )}
                        </DataTableCell>
                        <DataTableCell nowrap data-record="aside">
                          {entry.version !== data.role.version && !editing && (
                            <Button
                              disabled={write.busy}
                              onClick={async () =>
                                saved(
                                  await write.submit(
                                    {
                                      roleId,
                                      rollback: entry.version,
                                      from: data.role.version,
                                    },
                                    (key) =>
                                      client.rollbackRole(
                                        projectId,
                                        roleId,
                                        entry.version,
                                        key,
                                      ),
                                  ),
                                  `已回退到 v${entry.version} 的内容，生成了新版本`,
                                )
                              }
                            >
                              回退到 v{entry.version}
                            </Button>
                          )}
                        </DataTableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </SettingsTable>
              )}
            </SettingsSection>
          </>
        )}
        {guard.dialog}
      </CardDetailLayout>
    </Drawer>
  );
}

/** C-48 shared status shape; roles read "启用" rather than the generic "有效". */
function RoleStatus({ status }: { status: "active" | "inactive" }) {
  return (
    <StatusTag
      status={status}
      label={status === "active" ? "启用" : "已停用"}
    />
  );
}

function RoleFields({ role }: { role: RoleDetailView["role"] }) {
  const list = (values: readonly string[]) =>
    values.length ? values.join("、") : "—";
  return (
    <SettingsFacts>
      <SettingsFact label="编号">
        <code>{role.role_id}</code>
      </SettingsFact>
      <SettingsFact label="类型">{ROLE_KIND_LABELS[role.kind]}</SettingsFact>
      <SettingsFact label="状态">
        <RoleStatus status={role.status} />
      </SettingsFact>
      <SettingsFact label="版本">
        v{role.version}
        <SettingsHelp label="版本说明">{ROLE_VERSION_PIN_NOTICE}</SettingsHelp>
      </SettingsFact>
      <SettingsFact label="Harness / 启动配置">
        {role.harness} / {role.launch_profile_ref}
      </SettingsFact>
      <SettingsFact label={ROLE_FIELD_LABELS.worktree}>
        {WORKTREE_LABELS[role.worktree]}
      </SettingsFact>
      <SettingsFact label={ROLE_FIELD_LABELS.allowed_tools}>
        {list(role.allowed_tools)}
      </SettingsFact>
      <SettingsFact label={ROLE_FIELD_LABELS.capabilities}>
        {list(role.capabilities)}
      </SettingsFact>
      <SettingsFact label={ROLE_FIELD_LABELS.abilities}>
        {list(role.abilities)}
      </SettingsFact>
      <SettingsFact label={ROLE_FIELD_LABELS.required_machine_tags}>
        {list(role.required_machine_tags)}
      </SettingsFact>
      <SettingsFact
        label={
          role.instructions === undefined ? (
            <>
              core_prompt
              <SettingsHelp label="旧格式角色说明">
                旧格式角色：只有 core_prompt，没有单独的 instructions。
              </SettingsHelp>
            </>
          ) : (
            ROLE_FIELD_LABELS.instructions
          )
        }
      >
        <SettingsText>{role.instructions ?? role.core_prompt}</SettingsText>
      </SettingsFact>
    </SettingsFacts>
  );
}

function RoleEditForm({
  detail,
  profiles,
  busy,
  error,
  onDirtyChange,
  onCancel,
  onSubmit,
}: {
  detail: RoleDetailView;
  profiles: readonly LaunchProfileOption[];
  busy: boolean;
  error: string;
  onDirtyChange: (dirty: boolean) => void;
  onCancel: () => void;
  onSubmit: (patch: RoleEditInput) => void;
}) {
  const [showPreview, setShowPreview] = useState(false);
  const role = detail.role;
  const legacy = detail.legacy_conversion;
  const [displayName, setDisplayName] = useState(role.display_name);
  const [kind, setKind] = useState<RoleKind>(role.kind);
  const [instructions, setInstructions] = useState(
    role.instructions ?? legacy?.instructions ?? "",
  );
  const [harness, setHarness] = useState(role.harness);
  const [profile, setProfile] = useState(role.launch_profile_ref);
  const [tools, setTools] = useState<readonly string[]>(role.allowed_tools);
  const [capabilities, setCapabilities] = useState(
    role.capabilities.join(", "),
  );
  const [abilities, setAbilities] = useState(role.abilities.join(", "));
  const [worktree, setWorktree] = useState<RoleWorktree>(role.worktree);
  const [tags, setTags] = useState(role.required_machine_tags.join(", "));
  const allowlist = detail.allowlists[kind];
  const outside = tools.filter((tool) => !allowlist.includes(tool));
  const draft = {
    display_name: displayName.trim(),
    kind,
    harness,
    launch_profile_ref: profile.trim(),
    allowed_tools: tools,
    capabilities: parseList(capabilities),
    abilities: parseList(abilities),
    worktree,
    required_machine_tags: parseList(tags),
  };
  const relaxations = roleRelaxations(role, draft);
  const hints = [
    ...(outside.length
      ? [
          `${outside.join("、")} 不在${ROLE_KIND_LABELS[kind]}型角色的工具白名单内，保存会被服务端拒绝，请取消勾选。`,
        ]
      : []),
    ...(tools.includes("record_decision") && role.role_id !== "pm"
      ? ["record_decision 只能授予 pm 角色。"]
      : []),
    ...(kind === "verify" && worktree === "write"
      ? ["验证型角色的 worktree 只能为只读或不建。"]
      : []),
    ...(draft.display_name === "" ? ["显示名不能为空。"] : []),
    ...(draft.launch_profile_ref === "" ? ["启动配置不能为空。"] : []),
    ...(instructions.trim() === "" ? ["角色说明不能为空。"] : []),
  ];
  const patch: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(draft)) {
    const before = role[field as keyof typeof role];
    if (JSON.stringify(before) !== JSON.stringify(value)) patch[field] = value;
  }
  if (instructions !== role.instructions) patch.instructions = instructions;
  const changed = Object.keys(patch).length > 0;
  useEffect(() => {
    onDirtyChange(changed);
    return () => onDirtyChange(false);
  }, [changed, onDirtyChange]);
  const ordered = [
    ...allowlist,
    ...tools.filter((tool) => !allowlist.includes(tool)),
  ];
  return (
    <form
      aria-label="编辑角色"
      onSubmit={(event) => {
        event.preventDefault();
        if (!changed || busy) return;
        onSubmit(patch as RoleEditInput);
      }}
    >
      <SettingsDialogFields>
        {legacy && (
          <SettingsWarning>
            <p>
              这是旧格式角色（只有
              core_prompt）。保存后将转换为新格式：下面的角色说明由系统按默认角色包结构拆出，协作规则和协议由系统统一拼接。
            </p>
            {legacy.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </SettingsWarning>
        )}
        <label>
          显示名
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>
        <label>
          类型
          <SelectControl
            value={kind}
            onValueChange={(e) => setKind(e as RoleKind)}
          >
            {(["produce", "verify", "standing"] as const).map((value) => (
              <option key={value} value={value}>
                {ROLE_KIND_LABELS[value]}
              </option>
            ))}
          </SelectControl>
        </label>
        <fieldset>
          <legend>{ROLE_FIELD_LABELS.instructions}</legend>
          <ToggleGroup
            type="multiple"
            aria-label="角色说明编辑方式"
            value={[showPreview ? "preview" : "edit"]}
            onValueChange={(next) => setShowPreview(next.at(-1) === "preview")}
          >
            <ToggleGroupItem value="edit">编辑</ToggleGroupItem>
            <ToggleGroupItem value="preview">预览</ToggleGroupItem>
          </ToggleGroup>
          {showPreview ? (
            <SettingsMarkdown
              label={`${ROLE_FIELD_LABELS.instructions}预览`}
              source={instructions}
            />
          ) : (
            <Textarea
              rows={16}
              aria-label={ROLE_FIELD_LABELS.instructions}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          )}
        </fieldset>
        <label>
          Harness
          <SelectControl value={harness} onValueChange={(e) => setHarness(e)}>
            {detail.harnesses.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </SelectControl>
        </label>
        <label>
          启动配置
          <SelectControl
            value={profile}
            onValueChange={(next) => {
              setProfile(next);
              const chosen = profiles.find((p) => p.name === next);
              if (chosen) setHarness(chosen.harness);
            }}
          >
            {launchProfileOptions(profiles, profile)}
          </SelectControl>
        </label>
        <fieldset>
          <legend>
            可用工具（只能从{ROLE_KIND_LABELS[kind]}型角色的系统白名单中勾选）
          </legend>
          <div data-choices="">
            {ordered.map((tool) => (
              <label
                key={tool}
                data-outside={allowlist.includes(tool) ? undefined : ""}
              >
                <Checkbox
                  checked={tools.includes(tool)}
                  disabled={!allowlist.includes(tool) && !tools.includes(tool)}
                  onCheckedChange={(checked) =>
                    setTools(
                      checked === true
                        ? [...tools, tool]
                        : tools.filter((value) => value !== tool),
                    )
                  }
                />
                {tool}
              </label>
            ))}
          </div>
        </fieldset>
        <label>
          {ROLE_FIELD_LABELS.capabilities}（逗号分隔）
          <Input
            value={capabilities}
            onChange={(e) => setCapabilities(e.target.value)}
          />
        </label>
        <label>
          {ROLE_FIELD_LABELS.abilities}（逗号分隔）
          <Input
            value={abilities}
            onChange={(e) => setAbilities(e.target.value)}
          />
        </label>
        <label>
          {ROLE_FIELD_LABELS.worktree}
          <SelectControl
            value={worktree}
            onValueChange={(e) => setWorktree(e as RoleWorktree)}
          >
            {(["none", "readonly", "write"] as const).map((value) => (
              <option key={value} value={value}>
                {WORKTREE_LABELS[value]}
              </option>
            ))}
          </SelectControl>
        </label>
        <label>
          {ROLE_FIELD_LABELS.required_machine_tags}（逗号分隔）
          <Input value={tags} onChange={(e) => setTags(e.target.value)} />
        </label>
        {relaxations.length > 0 && (
          <SettingsWarning role="note" aria-label="这次改动放宽的权限">
            <p>这次改动放宽了以下权限：</p>
            <ul>
              {relaxations.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p>
              保存即视为你确认（人在 Workbench 的操作本身就是确认，PM 和 Agent
              不能代为确认），不会再弹出二次确认。
            </p>
          </SettingsWarning>
        )}
        {hints.length > 0 && (
          <SettingsWarning>
            <ul aria-label="填写提示">
              {hints.map((hint) => (
                <li key={hint}>{hint}</li>
              ))}
            </ul>
          </SettingsWarning>
        )}
      </SettingsDialogFields>
      <SettingsDialogActions>
        <Button onClick={onCancel} disabled={busy}>
          取消
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !changed}>
          保存为新版本
        </Button>
      </SettingsDialogActions>
      <RequestFeedback
        interactive
        pending={busy}
        pendingMessage="保存中…"
        error={error}
      />
    </form>
  );
}
