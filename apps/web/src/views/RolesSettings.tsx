import { useCallback, useRef, useState } from "react";
import {
  type CardiganClient,
  describeWriteError,
  type RoleDefinitionView,
  type RoleDetailView,
  type RoleEditInput,
  type RoleKind,
  type RoleListView,
  type RoleWorktree,
} from "../api.js";
import { EmployeeIdentity } from "../components/EmployeeIdentity.js";
import { StatusTag, Time } from "../components/Foundation.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { SelectControl } from "../components/ui/select-control.js";
import { employeeCopy } from "../employee-copy.js";
import {
  parseList,
  ROLE_FIELD_LABELS,
  ROLE_KIND_LABELS,
  ROLE_VERSION_PIN_NOTICE,
  type RoleFieldDiff,
  roleDiff,
  roleRelaxations,
  WORKTREE_LABELS,
} from "../role-diff.js";
import { useResource } from "../useResource.js";

type View =
  | { readonly kind: "list" }
  | { readonly kind: "new" }
  | { readonly kind: "detail"; readonly roleId: string }
  | { readonly kind: "edit"; readonly roleId: string };

/** One idempotency key per distinct input, kept until it succeeds (C-16). */
function useRoleWrite() {
  const keys = useRef(new Map<string, string>());
  const sending = useRef(false);
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
        return result;
      } catch (cause) {
        setError(describeWriteError(cause));
        return undefined;
      } finally {
        sending.current = false;
        setBusy(false);
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
  const [view, setView] = useState<View>({ kind: "list" });
  const [createdRole, setCreatedRole] = useState<string>();
  const [message, setMessage] = useState("");
  const load = useCallback(() => client.roles(projectId), [client, projectId]);
  const list = useResource(load, revision);
  const open = (next: View, note = "") => {
    setMessage(note);
    setView(next);
    if (next.kind === "list") list.reload();
  };
  return (
    <div className="role-settings">
      <RequestFeedback message={message} />
      {createdRole &&
        onNewEmployee &&
        view.kind === "detail" &&
        view.roleId === createdRole && (
          <p>
            <button type="button" onClick={() => onNewEmployee(createdRole)}>
              {employeeCopy.afterRole}
            </button>
          </p>
        )}
      {view.kind === "list" && (
        <RequestFeedback
          {...list}
          retry={list.reload}
          pendingMessage="正在加载角色…"
        />
      )}
      {view.kind === "list" && (
        <RoleList
          list={list.data}
          onOpen={(roleId) => open({ kind: "detail", roleId })}
          onNew={() => open({ kind: "new" })}
        />
      )}
      {view.kind === "new" && (
        <NewRoleForm
          client={client}
          projectId={projectId}
          list={list.data}
          onCancel={() => open({ kind: "list" })}
          onCreated={(role) => {
            setCreatedRole(role.role_id);
            open(
              { kind: "detail", roleId: role.role_id },
              `已创建角色 ${role.role_id} v${role.version}`,
            );
          }}
        />
      )}
      {(view.kind === "detail" || view.kind === "edit") && (
        <RoleDetail
          key={view.roleId}
          client={client}
          projectId={projectId}
          roleId={view.roleId}
          editing={view.kind === "edit"}
          revision={revision}
          onBack={() => open({ kind: "list" })}
          onEdit={(editing) =>
            open({ kind: editing ? "edit" : "detail", roleId: view.roleId })
          }
          onSaved={(role, note) =>
            open({ kind: "detail", roleId: role.role_id }, note)
          }
        />
      )}
    </div>
  );
}

function RoleList({
  list,
  onOpen,
  onNew,
}: {
  list: RoleListView | undefined;
  onOpen: (roleId: string) => void;
  onNew: () => void;
}) {
  return (
    <>
      <div className="role-toolbar">
        <button type="button" onClick={onNew}>
          新建角色
        </button>
      </div>
      {list && list.roles.length === 0 && (
        <p className="empty">本项目还没有登记角色。</p>
      )}
      {list && list.roles.length > 0 && (
        <table className="role-table">
          <caption className="visually-hidden">角色列表</caption>
          <thead>
            <tr>
              <th scope="col">名称</th>
              <th scope="col">类型</th>
              <th scope="col">版本</th>
              <th scope="col">状态</th>
            </tr>
          </thead>
          <tbody>
            {list.roles.map((role) => (
              <tr key={role.role_id}>
                <td>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => onOpen(role.role_id)}
                  >
                    {role.display_name}
                  </button>{" "}
                  <code>{role.role_id}</code>
                </td>
                <td>{ROLE_KIND_LABELS[role.kind]}</td>
                <td>v{role.version}</td>
                <td>
                  <RoleStatus status={role.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
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
  const [harness, setHarness] = useState(list?.roles[0]?.harness ?? "codex");
  const [profile, setProfile] = useState(
    list?.roles[0]?.launch_profile_ref ?? "",
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
  const profiles = [
    ...new Set(list?.roles.map((role) => role.launch_profile_ref) ?? []),
  ];
  return (
    <form
      className="role-form"
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
                  ...(sourceVersion ? { version: Number(sourceVersion) } : {}),
                },
        };
        const role = await write.submit(input, (key) =>
          client.copyRole(projectId, input, key),
        );
        if (role) onCreated(role);
      }}
    >
      <h3>新建角色</h3>
      <fieldset>
        <legend>复制来源</legend>
        <label>
          <input
            type="radio"
            name="role-source"
            checked={source === "default"}
            onChange={() => setSource("default")}
          />
          从默认角色包复制
        </label>
        <label>
          <input
            type="radio"
            name="role-source"
            checked={source === "project"}
            onChange={() => setSource("project")}
          />
          从现有角色复制
        </label>
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
            <SelectControl value={harness} onValueChange={(e) => setHarness(e)}>
              {(list?.harnesses ?? ["claude-code", "codex", "pi"]).map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </SelectControl>
          </label>
          <label>
            启动配置
            <input
              value={profile}
              list="role-launch-profiles"
              onChange={(e) => setProfile(e.target.value)}
            />
          </label>
          <datalist id="role-launch-profiles">
            {profiles.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
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
            <input
              inputMode="numeric"
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
        <input value={roleId} onChange={(e) => setRoleId(e.target.value)} />
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
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="role-actions">
        <button type="submit" disabled={write.busy || !ready}>
          创建角色
        </button>
        <button type="button" onClick={onCancel} disabled={write.busy}>
          取消
        </button>
      </div>
      <RequestFeedback
        interactive
        pending={write.busy}
        pendingMessage="正在提交角色…"
        error={write.error}
      />
    </form>
  );
}

function RoleDetail({
  client,
  projectId,
  roleId,
  editing,
  revision,
  onBack,
  onEdit,
  onSaved,
}: {
  client: CardiganClient;
  projectId: string;
  roleId: string;
  editing: boolean;
  revision: number;
  onBack: () => void;
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
  return (
    <section className="role-detail" aria-label={`角色 ${roleId}`}>
      <button type="button" className="link-button" onClick={onBack}>
        ← 返回角色列表
      </button>
      <RequestFeedback
        {...detail}
        retry={detail.reload}
        pendingMessage="正在加载角色…"
      />
      {data && (
        <>
          <h3>
            {data.role.display_name} <code>{data.role.role_id}</code> v
            {data.role.version}
            {data.role.status === "inactive" && (
              <>
                {" "}
                <RoleStatus status="inactive" />
              </>
            )}
          </h3>
          <p className="notice">{ROLE_VERSION_PIN_NOTICE}</p>
          {editing ? (
            <RoleEditForm
              key={data.role.version}
              detail={data}
              busy={write.busy}
              error={write.error}
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
          ) : (
            <>
              <div className="role-actions">
                <button type="button" onClick={() => onEdit(true)}>
                  编辑
                </button>
                <button
                  type="button"
                  disabled={write.busy}
                  onClick={async () => {
                    const active = data.role.status !== "active";
                    saved(
                      await write.submit(
                        { roleId, active, from: data.role.version },
                        (key) =>
                          client.setRoleActive(projectId, roleId, active, key),
                      ),
                      active ? "角色已启用" : "角色已停用，不能再被新指派",
                    );
                  }}
                >
                  {data.role.status === "active" ? "停用" : "启用"}
                </button>
              </div>
              <RequestFeedback
                interactive
                pending={write.busy}
                pendingMessage="正在提交角色…"
                error={write.error}
              />
              <RoleFields role={data.role} />
              <h4>与上一版本的差异</h4>
              {data.previous ? (
                <RoleDiffView
                  title={`v${data.previous.version} → v${data.role.version}`}
                  diffs={roleDiff(data.previous, data.role)}
                />
              ) : (
                <p className="hint">这是第一个版本，没有可对比的上一版本。</p>
              )}
            </>
          )}
          <h4>版本历史</h4>
          <RequestFeedback
            {...history}
            retry={history.reload}
            pendingMessage="正在加载版本历史…"
          />
          {history.data && (
            <ol className="role-history" aria-label="版本历史">
              {history.data.versions.map((entry) => (
                <li key={entry.version}>
                  <strong>v{entry.version}</strong> {entry.summary}
                  {entry.author_display && (
                    <>
                      {" "}
                      ·{" "}
                      <EmployeeIdentity
                        {...entry}
                        author_display={entry.author_display}
                        showTitle={false}
                      />
                    </>
                  )}
                  {entry.created_at && (
                    <>
                      {" · "}
                      <Time value={entry.created_at} />
                    </>
                  )}
                  {entry.version !== data.role.version && !editing && (
                    <button
                      type="button"
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
                    </button>
                  )}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
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
    values.length ? values.join("、") : "（无）";
  return (
    <dl className="role-fields">
      <dt>类型</dt>
      <dd>{ROLE_KIND_LABELS[role.kind]}</dd>
      <dt>状态</dt>
      <dd>
        <RoleStatus status={role.status} />
      </dd>
      <dt>Harness / 启动配置</dt>
      <dd>
        {role.harness} / {role.launch_profile_ref}
      </dd>
      <dt>{ROLE_FIELD_LABELS.worktree}</dt>
      <dd>{WORKTREE_LABELS[role.worktree]}</dd>
      <dt>{ROLE_FIELD_LABELS.allowed_tools}</dt>
      <dd>{list(role.allowed_tools)}</dd>
      <dt>{ROLE_FIELD_LABELS.capabilities}</dt>
      <dd>{list(role.capabilities)}</dd>
      <dt>{ROLE_FIELD_LABELS.abilities}</dt>
      <dd>{list(role.abilities)}</dd>
      <dt>{ROLE_FIELD_LABELS.required_machine_tags}</dt>
      <dd>{list(role.required_machine_tags)}</dd>
      <dt>{ROLE_FIELD_LABELS.instructions}</dt>
      <dd>
        {role.instructions === undefined ? (
          <>
            <p className="hint">
              旧格式角色：只有 core_prompt，没有单独的 instructions。
            </p>
            <pre className="role-text">{role.core_prompt}</pre>
          </>
        ) : (
          <pre className="role-text">{role.instructions}</pre>
        )}
      </dd>
    </dl>
  );
}

function RoleDiffView({
  title,
  diffs,
}: {
  title: string;
  diffs: readonly RoleFieldDiff[];
}) {
  if (diffs.length === 0)
    return <p className="hint">{title}：内容相同（只改了状态）。</p>;
  return (
    <section className="role-diff" aria-label={`差异 ${title}`}>
      <p className="hint">{title}</p>
      <ul>
        {diffs.map((diff) => (
          <li key={diff.field}>
            <strong>{ROLE_FIELD_LABELS[diff.field] ?? diff.field}</strong>
            {diff.type === "value" && `：${diff.before} → ${diff.after}`}
            {diff.type === "list" && (
              <>
                {diff.added.length > 0 && (
                  <span className="role-diff-add">
                    {" "}
                    新增 {diff.added.join("、")}
                  </span>
                )}
                {diff.removed.length > 0 && (
                  <span className="role-diff-remove">
                    {" "}
                    移除 {diff.removed.join("、")}
                  </span>
                )}
              </>
            )}
            {diff.type === "text" && (
              <pre className="role-text">
                {diff.lines.map((line, index) => (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional.
                    key={index}
                    className={
                      line.op === "add"
                        ? "role-diff-add"
                        : line.op === "remove"
                          ? "role-diff-remove"
                          : undefined
                    }
                  >
                    {line.op === "add"
                      ? "+ "
                      : line.op === "remove"
                        ? "- "
                        : "  "}
                    {line.text}
                    {"\n"}
                  </span>
                ))}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function RoleEditForm({
  detail,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  detail: RoleDetailView;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onSubmit: (patch: RoleEditInput) => void;
}) {
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
  const ordered = [
    ...allowlist,
    ...tools.filter((tool) => !allowlist.includes(tool)),
  ];
  return (
    <form
      className="role-form"
      aria-label="编辑角色"
      onSubmit={(event) => {
        event.preventDefault();
        if (!changed || busy) return;
        onSubmit(patch as RoleEditInput);
      }}
    >
      {legacy && (
        <div className="notice">
          <p>
            这是旧格式角色（只有
            core_prompt）。保存后将转换为新格式：下面的角色说明由系统按默认角色包结构拆出，协作规则和协议由系统统一拼接。
          </p>
          {legacy.warnings.map((warning) => (
            <p key={warning} className="role-warning-text">
              {warning}
            </p>
          ))}
        </div>
      )}
      <label>
        显示名
        <input
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
      <label>
        {ROLE_FIELD_LABELS.instructions}
        <textarea
          rows={12}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </label>
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
        <input value={profile} onChange={(e) => setProfile(e.target.value)} />
      </label>
      <fieldset className="role-tools">
        <legend>
          可用工具（只能从{ROLE_KIND_LABELS[kind]}型角色的系统白名单中勾选）
        </legend>
        {ordered.map((tool) => (
          <label
            key={tool}
            className={allowlist.includes(tool) ? undefined : "role-outside"}
          >
            <input
              type="checkbox"
              checked={tools.includes(tool)}
              disabled={!allowlist.includes(tool) && !tools.includes(tool)}
              onChange={(e) =>
                setTools(
                  e.target.checked
                    ? [...tools, tool]
                    : tools.filter((value) => value !== tool),
                )
              }
            />
            {tool}
          </label>
        ))}
      </fieldset>
      <label>
        {ROLE_FIELD_LABELS.capabilities}（逗号分隔）
        <input
          value={capabilities}
          onChange={(e) => setCapabilities(e.target.value)}
        />
      </label>
      <label>
        {ROLE_FIELD_LABELS.abilities}（逗号分隔）
        <input
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
        <input value={tags} onChange={(e) => setTags(e.target.value)} />
      </label>
      {relaxations.length > 0 && (
        <div
          className="role-warning"
          role="note"
          aria-label="这次改动放宽的权限"
        >
          <p className="role-flat">
            <strong>这次改动放宽了以下权限：</strong>
          </p>
          <ul className="role-flat">
            {relaxations.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="role-flat">
            保存即视为你确认（人在 Workbench 的操作本身就是确认，PM 和 Agent
            不能代为确认），不会再弹出二次确认。
          </p>
        </div>
      )}
      {hints.length > 0 && (
        <ul className="role-hints" aria-label="填写提示">
          {hints.map((hint) => (
            <li key={hint}>{hint}</li>
          ))}
        </ul>
      )}
      <div className="role-actions">
        <button type="submit" disabled={busy || !changed}>
          保存为新版本
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </div>
      <RequestFeedback
        interactive
        pending={busy}
        pendingMessage="保存中…"
        error={error}
      />
    </form>
  );
}
