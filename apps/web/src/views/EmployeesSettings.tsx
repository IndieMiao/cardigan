import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  ApiError,
  type CardiganClient,
  type CreateEmployeeInput,
  describeWriteError,
  type EmployeeOptions,
  type EmployeePatch,
  type EmployeeSummary,
} from "../api.js";
import { Drawer } from "../components/Drawer.js";
import { EmptyState, StatusTag } from "../components/Foundation.js";
import { CardDetailLayout } from "../components/layout/CardDetailLayout.js";
import { DataTableCell } from "../components/layout/DataTableLayout.js";
import {
  SettingsAvatar,
  SettingsDialogActions,
  SettingsDialogFields,
  SettingsFact,
  SettingsFacts,
  SettingsHelp,
  SettingsIdentity,
  SettingsPanel,
  SettingsTable,
  SettingsWarning,
  settingsDrawerClassName,
  useDiscardGuard,
  useDrawerReturnFocus,
} from "../components/layout/SettingsLayout.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { Button } from "../components/ui/button.js";
import { Input, SearchInput } from "../components/ui/input.js";
import { SelectControl } from "../components/ui/select-control.js";
import {
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.js";
import { Textarea } from "../components/ui/textarea.js";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group.js";
import { employeeCopy as copy } from "../employee-copy.js";
import { useResource } from "../useResource.js";
import { LaunchProfileSelect } from "./LaunchProfileSelect.js";

const matches = (item: EmployeeOptions["library"][number], search: string) =>
  `${item.name} ${item.source}`
    .toLowerCase()
    .includes(search.trim().toLowerCase());

export function EmployeesSettings({
  client,
  projectId,
  initialRole = "",
  revision = 0,
}: {
  client: CardiganClient;
  projectId: string;
  initialRole?: string;
  revision?: number;
}) {
  const load = useCallback(
    () => client.employeeOptions(projectId),
    [client, projectId],
  );
  const options = useResource(load, revision);
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  // A role created a moment ago opens the form with that role chosen.
  const [form, setForm] = useState<{ person: string } | undefined>(
    initialRole ? { person: "" } : undefined,
  );
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState<string>();
  const visible = options.data?.library.filter((item) => matches(item, search));
  const staff = options.data?.employees?.filter(
    (e) => !e.projects?.length || e.projects.includes(projectId),
  );
  const roleName = (id: string) =>
    options.data?.roles.find((r) => r.role_id === id)?.display_name ?? id;
  const edit = useDrawerReturnFocus(editing !== undefined);
  const editedEmployee = staff?.find((e) => e.id === editing);
  const newEmployee = useRef<HTMLButtonElement>(null);
  const { remember, forget } = useDrawerReturnFocus(
    form !== undefined && options.data !== undefined,
    () => newEmployee.current,
  );
  const start = (person: string) => {
    remember();
    setMessage("");
    setVersion((v) => v + 1);
    setForm({ person });
  };
  return (
    <SettingsPanel
      id="employees"
      tabIndex={-1}
      title={copy.tab}
      titleId="employee-settings-title"
      help={copy.description}
      actions={
        <>
          <SearchInput
            aria-label={copy.search}
            placeholder={copy.search}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button
            ref={newEmployee}
            variant="primary"
            disabled={!options.data}
            onClick={() => start("")}
          >
            {copy.heading}
          </Button>
        </>
      }
    >
      <RequestFeedback message={message} />
      <RequestFeedback
        {...options}
        retry={options.reload}
        pendingMessage={copy.loading}
      />
      {staff && staff.length > 0 && (
        <SettingsTable label="员工" aria-label="员工列表">
          <TableHeader>
            <TableRow>
              <TableHead>员工</TableHead>
              <TableHead>职位</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>状态</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {staff.map((employee) => (
              <TableRow key={employee.id}>
                <DataTableCell nowrap data-record="lead">
                  <SettingsIdentity>
                    {employee.avatar && (
                      <SettingsAvatar src={employee.avatar} loading="lazy" />
                    )}
                    <Button
                      variant="link"
                      aria-haspopup="dialog"
                      onClick={() => {
                        edit.remember();
                        setMessage("");
                        setEditing(employee.id);
                      }}
                    >
                      {employee.name}
                    </Button>
                  </SettingsIdentity>
                </DataTableCell>
                <DataTableCell data-label="职位">
                  {employee.title || "—"}
                </DataTableCell>
                <DataTableCell nowrap data-label="角色">
                  {roleName(employee.role_id)}
                </DataTableCell>
                <DataTableCell nowrap data-record="aside">
                  <StatusTag
                    status={
                      employee.status === "inactive" ? "inactive" : "active"
                    }
                    label={employee.status === "inactive" ? "已离职" : "在职"}
                  />
                </DataTableCell>
              </TableRow>
            ))}
          </TableBody>
        </SettingsTable>
      )}
      {options.data && editedEmployee && (
        <EmployeeRoleDrawer
          key={editedEmployee.id}
          client={client}
          projectId={projectId}
          employee={editedEmployee}
          options={options.data}
          refresh={options.reload}
          onClose={() => setEditing(undefined)}
          onSaved={(note) => {
            setEditing(undefined);
            setMessage(note);
            options.reload();
          }}
        />
      )}
      {visible && visible.length === 0 && (
        <EmptyState>{copy.emptySearch}</EmptyState>
      )}
      {visible && visible.length > 0 && (
        <SettingsTable label="人物库" aria-label="人物库">
          <TableHeader>
            <TableRow>
              <TableHead>人物</TableHead>
              <TableHead>出处</TableHead>
              <TableHead>使用情况</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((item) => (
              <TableRow key={item.id} aria-label={item.name}>
                <DataTableCell nowrap data-record="lead">
                  <SettingsIdentity>
                    <SettingsAvatar src={item.avatar} loading="lazy" />
                    {item.name}
                  </SettingsIdentity>
                </DataTableCell>
                <DataTableCell nowrap data-label="出处">
                  {item.source}
                </DataTableCell>
                <DataTableCell data-label="使用情况">
                  {item.occupied_by
                    ? copy.occupied(
                        item.occupied_by.name,
                        item.occupied_by.id,
                        item.occupied_by.status === "inactive",
                      )
                    : "—"}
                </DataTableCell>
                <DataTableCell nowrap data-record="aside">
                  {!item.occupied_by && (
                    <Button
                      aria-label={`选用${item.name}`}
                      aria-haspopup="dialog"
                      onClick={() => start(item.id)}
                    >
                      选用
                    </Button>
                  )}
                </DataTableCell>
              </TableRow>
            ))}
          </TableBody>
        </SettingsTable>
      )}
      {options.data && form && (
        <EmployeeForm
          key={version}
          client={client}
          projectId={projectId}
          options={options.data}
          initialRole={initialRole}
          initialPerson={form.person}
          refresh={options.reload}
          onCancel={() => setForm(undefined)}
          onCreated={(name, id) => {
            // The chosen person is taken now: its 选用 button goes away.
            if (form.person) forget();
            setForm(undefined);
            setMessage(copy.created(name, id));
            options.reload();
          }}
        />
      )}
    </SettingsPanel>
  );
}

function EmployeeForm({
  client,
  projectId,
  options,
  initialRole,
  initialPerson,
  refresh,
  onCancel,
  onCreated,
}: {
  client: CardiganClient;
  projectId: string;
  options: EmployeeOptions;
  initialRole: string;
  initialPerson: string;
  refresh: () => void;
  onCancel: () => void;
  onCreated: (name: string, id: string) => void;
}) {
  const [mode, setMode] = useState<"library" | "custom">("library");
  const [selected, setSelected] = useState(initialPerson);
  const [name, setName] = useState(
    () => options.library.find((item) => item.id === initialPerson)?.name ?? "",
  );
  const [title, setTitle] = useState("");
  const [role, setRole] = useState(initialRole);
  const [bio, setBio] = useState("");
  const [upload, setUpload] = useState<string>();
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const fileVersion = useRef(0);
  const keys = useRef(new Map<string, string>());
  const choice = options.library.find((item) => item.id === selected);
  const available = options.library.filter(
    (item) => !item.occupied_by || item.id === selected,
  );
  const switchMode = (next: "library" | "custom") => {
    setMode(next);
    setSelected("");
    setUpload(undefined);
    setFileError("");
    setReading(false);
    fileVersion.current++;
  };
  const readFile = (file: File | undefined) => {
    const current = ++fileVersion.current;
    setUpload(undefined);
    setFileError("");
    setReading(false);
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setFileError(copy.uploadTooLarge);
      return;
    }
    setReading(true);
    const reader = new FileReader();
    reader.onload = () => {
      if (current !== fileVersion.current) return;
      setReading(false);
      if (typeof reader.result !== "string") {
        setFileError(copy.uploadFailed);
        return;
      }
      setUpload(reader.result.slice(reader.result.indexOf(",") + 1));
    };
    reader.onerror = () => {
      if (current === fileVersion.current) {
        setReading(false);
        setFileError(copy.uploadFailed);
      }
    };
    reader.readAsDataURL(file);
  };
  return (
    <Drawer
      className={settingsDrawerClassName}
      open
      onOpenChange={(next) => {
        // Every way out (×, Escape, the overlay) waits for the submit.
        if (!next && !busy) onCancel();
      }}
      title={copy.heading}
      description={copy.heading}
      initialFocus="close"
    >
      <CardDetailLayout className="card-page-drawer">
        <form
          aria-label={copy.heading}
          onSubmit={async (event) => {
            event.preventDefault();
            if (sending.current || reading || fileError) return;
            if (mode === "library" && (!choice || choice.occupied_by)) {
              setError(copy.choosePerson);
              return;
            }
            sending.current = true;
            setBusy(true);
            setError("");
            const input: CreateEmployeeInput = {
              name,
              title,
              role_id: role,
              bio,
              ...(mode === "library"
                ? { avatar: `library:${selected}` }
                : upload === undefined
                  ? {}
                  : { avatar_file: upload }),
            };
            const signature = JSON.stringify(input);
            const key = keys.current.get(signature) ?? crypto.randomUUID();
            keys.current.set(signature, key);
            try {
              const employee = await client.createEmployee(
                projectId,
                input,
                key,
              );
              keys.current.delete(signature);
              // A form that is gone (another project) must not act on its reply.
              if (alive.current) onCreated(employee.name, employee.id);
            } catch (cause) {
              if (!alive.current) return;
              setError(describeWriteError(cause));
              if (
                cause instanceof ApiError &&
                cause.code === "validation_failed"
              )
                refresh();
            } finally {
              sending.current = false;
              if (alive.current) setBusy(false);
            }
          }}
        >
          <SettingsDialogFields>
            <fieldset disabled={busy}>
              <legend>
                {copy.source}
                {mode === "custom" && (
                  <SettingsHelp label="头像要求">
                    {copy.uploadHint}
                  </SettingsHelp>
                )}
              </legend>
              <ToggleGroup
                type="multiple"
                aria-label={copy.source}
                value={[mode]}
                onValueChange={(next) => {
                  const value = next.at(-1);
                  if (value === "library" || value === "custom")
                    switchMode(value);
                }}
              >
                <ToggleGroupItem value="library">
                  {copy.library}
                </ToggleGroupItem>
                <ToggleGroupItem value="custom">{copy.custom}</ToggleGroupItem>
              </ToggleGroup>
              {mode === "library" ? (
                <>
                  <label>
                    人物
                    <SelectControl
                      value={selected}
                      onValueChange={(value) => {
                        setSelected(value);
                        const item = options.library.find(
                          (p) => p.id === value,
                        );
                        if (item) setName(item.name);
                        setError("");
                      }}
                    >
                      <option value="">请选择人物</option>
                      {available.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}（{item.source}）
                        </option>
                      ))}
                    </SelectControl>
                  </label>
                  {choice && (
                    <SettingsIdentity>
                      <SettingsAvatar
                        src={choice.avatar}
                        alt={choice.name}
                        large
                      />
                      {choice.name} · {choice.source}
                    </SettingsIdentity>
                  )}
                </>
              ) : (
                <label>
                  {copy.avatar}
                  <Input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
                    onChange={(event) => readFile(event.target.files?.[0])}
                  />
                </label>
              )}
              {reading && (
                <RequestFeedback
                  pending
                  interactive
                  pendingMessage={copy.reading}
                />
              )}
              <RequestFeedback error={fileError} />
            </fieldset>
            <fieldset disabled={busy}>
              <label>
                {copy.name}
                <Input
                  value={name}
                  required
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                {copy.title}
                <Input
                  value={title}
                  required
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label>
                {copy.role}
                <SelectControl
                  value={role}
                  required
                  onValueChange={(event) => setRole(event)}
                >
                  <option value="">{copy.chooseRole}</option>
                  {options.roles.map((item) => (
                    <option key={item.role_id} value={item.role_id}>
                      {item.display_name}（{item.role_id}）
                    </option>
                  ))}
                </SelectControl>
              </label>
              {options.roles.length === 0 && (
                <SettingsWarning>{copy.noRoles}</SettingsWarning>
              )}
              <label>
                {copy.bio}
                <Textarea
                  value={bio}
                  rows={3}
                  onChange={(event) => setBio(event.target.value)}
                />
              </label>
            </fieldset>
          </SettingsDialogFields>
          <RequestFeedback
            interactive
            pending={busy}
            pendingMessage={copy.submitting}
            error={error}
          />
          <SettingsDialogActions>
            <Button onClick={onCancel} disabled={busy}>
              取消
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={
                busy ||
                reading ||
                Boolean(fileError) ||
                options.roles.length === 0
              }
            >
              {busy ? copy.submitting : copy.submit}
            </Button>
          </SettingsDialogActions>
        </form>
      </CardDetailLayout>
    </Drawer>
  );
}

const BLOCKED_REASONS = {
  run: "这名员工还有未结束的运行，结束后才能换角色。",
  assignment: "这名员工还有未释放的指派，释放后才能换角色。",
} as const;

/**
 * C-494 item 5: change an employee's role (a transfer, C-493). The read says
 * when the server would refuse — an unfinished run or a bound assignment — so
 * the choice is disabled with that reason; the server still decides.
 * C-516 item 4: pin one of the host's valid launch profiles, or clear it to
 * follow the role. Only the changed fields are sent, so a blocked role change
 * does not stop a profile change.
 */
function EmployeeRoleDrawer({
  client,
  projectId,
  employee,
  options,
  refresh,
  onClose,
  onSaved,
}: {
  client: CardiganClient;
  projectId: string;
  employee: EmployeeSummary;
  options: EmployeeOptions;
  refresh: () => void;
  onClose: () => void;
  onSaved: (note: string) => void;
}) {
  // Only what the person picked (V-2567): untouched fields follow the latest
  // read, so a retry after a re-read never writes back a value someone else
  // just changed. Picking the read's value again is no longer an edit.
  const savedProfile = employee.launch_profile_ref ?? null;
  const [roleEdit, setRoleEdit] = useState<string>();
  const [profileEdit, setProfileEdit] = useState<{ value: string | null }>();
  const role = roleEdit ?? employee.role_id;
  const profile = profileEdit ? profileEdit.value : savedProfile;
  const setRole = (next: string) =>
    setRoleEdit(next === employee.role_id ? undefined : next);
  const setProfile = (next: string | null) =>
    setProfileEdit(next === savedProfile ? undefined : { value: next });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const loadProfiles = useCallback(() => client.launchProfileNames(), [client]);
  const names = useResource(loadProfiles);
  const keys = useRef(new Map<string, string>());
  const blocked = employee.role_change_blocked
    ? BLOCKED_REASONS[employee.role_change_blocked]
    : undefined;
  const reasonId = useId();
  const roleChanged = role !== employee.role_id;
  const profileChanged = profile !== savedProfile;
  const changed = roleChanged || profileChanged;
  const guard = useDiscardGuard(changed, onClose);
  const roles = options.roles.some((r) => r.role_id === employee.role_id)
    ? options.roles
    : [
        { role_id: employee.role_id, display_name: employee.role_id },
        ...options.roles,
      ];
  const label = (id: string) =>
    roles.find((r) => r.role_id === id)?.display_name ?? id;
  const roleProfile = roles.find((r) => r.role_id === role)?.launch_profile_ref;
  const profileLabel = (name: string | null) =>
    name ?? (roleProfile ? `跟随角色（${roleProfile}）` : "跟随角色");
  const savedNote = () =>
    roleChanged && profileChanged
      ? `已将 ${employee.name} 的角色改为 ${label(role)}，启动配置改为 ${profileLabel(profile)}`
      : roleChanged
        ? `已将 ${employee.name} 的角色改为 ${label(role)}`
        : `已将 ${employee.name} 的启动配置改为 ${profileLabel(profile)}`;
  return (
    <Drawer
      className={settingsDrawerClassName}
      open
      onOpenChange={(next) => {
        if (!next && !busy) guard.confirmClose();
      }}
      title={employee.name}
      description={`员工 ${employee.id}`}
      initialFocus="close"
    >
      <CardDetailLayout className="card-page-drawer">
        <SettingsFacts>
          <SettingsFact label="编号">{employee.id}</SettingsFact>
          <SettingsFact label={copy.title}>
            {employee.title || "—"}
          </SettingsFact>
          <SettingsFact label="状态">
            {employee.status === "inactive" ? "已离职" : "在职"}
          </SettingsFact>
        </SettingsFacts>
        <form
          aria-label="修改员工"
          onSubmit={async (event) => {
            event.preventDefault();
            if (sending.current || !changed || (roleChanged && blocked)) return;
            sending.current = true;
            setBusy(true);
            setError("");
            const patch: EmployeePatch = {
              ...(roleChanged ? { role_id: role } : {}),
              ...(profileChanged ? { launch_profile_ref: profile } : {}),
            };
            const signature = JSON.stringify([employee.id, patch]);
            const key = keys.current.get(signature) ?? crypto.randomUUID();
            keys.current.set(signature, key);
            try {
              await client.updateEmployee(projectId, employee.id, patch, key);
              keys.current.delete(signature);
              if (alive.current) onSaved(savedNote());
            } catch (cause) {
              if (!alive.current) return;
              setError(describeWriteError(cause));
              // A run or assignment may have started meanwhile.
              refresh();
            } finally {
              sending.current = false;
              if (alive.current) setBusy(false);
            }
          }}
        >
          <SettingsDialogFields>
            <label>
              {copy.role}
              <SelectControl
                value={role}
                disabled={busy || blocked !== undefined}
                aria-describedby={blocked ? reasonId : undefined}
                onValueChange={(next) => {
                  setRole(next);
                  setError("");
                }}
              >
                {roles.map((item) => (
                  <option key={item.role_id} value={item.role_id}>
                    {item.display_name}（{item.role_id}）
                  </option>
                ))}
              </SelectControl>
            </label>
            {blocked && (
              <SettingsWarning id={reasonId}>{blocked}</SettingsWarning>
            )}
            {/* biome-ignore lint/a11y/noLabelWithoutControl: `LaunchProfileSelect` renders a `SelectControl`. */}
            <label>
              启动配置
              <LaunchProfileSelect
                value={profile}
                // Until the names arrive a pinned name is not yet "已失效".
                profiles={names.data ?? (profile === null ? [] : [profile])}
                roleProfile={roleProfile}
                disabled={busy || names.data === undefined}
                onChange={(next) => {
                  setProfile(next);
                  setError("");
                }}
              />
            </label>
            <RequestFeedback
              pending={names.pending && names.data === undefined}
              pendingMessage="正在读取启动配置…"
              error={names.data === undefined ? names.error : undefined}
              retry={names.reload}
            />
            {error && <SettingsWarning role="alert">{error}</SettingsWarning>}
          </SettingsDialogFields>
          <SettingsDialogActions>
            <Button onClick={guard.confirmClose} disabled={busy}>
              取消
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={
                busy || !changed || (roleChanged && blocked !== undefined)
              }
            >
              保存
            </Button>
          </SettingsDialogActions>
          <RequestFeedback
            interactive
            pending={busy}
            pendingMessage="正在保存…"
          />
        </form>
        {guard.dialog}
      </CardDetailLayout>
    </Drawer>
  );
}
