import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  ApiError,
  type CardiganClient,
  describeWriteError,
  type RoleDefinitionView,
  type RoleDocumentPreview,
  type TemplateView,
} from "../api.js";
import { Drawer } from "../components/Drawer.js";
import { CardDetailLayout } from "../components/layout/CardDetailLayout.js";
import { DataTableCell } from "../components/layout/DataTableLayout.js";
import {
  SettingsDialogActions,
  SettingsDialogFields,
  SettingsDiff,
  SettingsFact,
  SettingsFacts,
  SettingsSection,
  SettingsTable,
  SettingsText,
  SettingsWarning,
  settingsDrawerClassName,
  useDiscardGuard,
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
import {
  ROLE_FIELD_LABELS,
  type RoleFieldDiff,
  roleDiff,
} from "../role-diff.js";
import { useResource } from "../useResource.js";

/** Same ceiling as the server: the decoded document, UTF-8 bytes. */
export const ROLE_DOCUMENT_MAX_BYTES = 64 * 1024;
const ACTION_LABELS = {
  create: "新建",
  update: "修改",
  unchanged: "不变",
} as const;

export function RoleDiffView({
  title,
  diffs,
  created = false,
}: {
  title: string;
  diffs: readonly RoleFieldDiff[];
  /** A new role has no "before": show each value as it will be saved. */
  created?: boolean;
}) {
  if (diffs.length === 0) return <p>{title}：内容相同（只改了状态）</p>;
  return (
    <SettingsFacts>
      <SettingsFact label="版本">{title}</SettingsFact>
      {diffs.map((diff) => (
        <SettingsFact
          key={diff.field}
          label={ROLE_FIELD_LABELS[diff.field] ?? diff.field}
        >
          {diff.type === "value" &&
            (created ? diff.after : `${diff.before} → ${diff.after}`)}
          {diff.type === "list" && (
            <>
              {diff.added.length > 0 && (
                <SettingsDiff op="add">
                  新增 {diff.added.join("、")}{" "}
                </SettingsDiff>
              )}
              {diff.removed.length > 0 && (
                <SettingsDiff op="remove">
                  移除 {diff.removed.join("、")}
                </SettingsDiff>
              )}
            </>
          )}
          {diff.type === "text" && (
            <SettingsText>
              {diff.lines.map((line, index) => (
                <SettingsDiff
                  // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional.
                  key={index}
                  op={line.op === "same" ? undefined : line.op}
                >
                  {line.op === "add"
                    ? "+ "
                    : line.op === "remove"
                      ? "- "
                      : "  "}
                  {line.text}
                  {"\n"}
                </SettingsDiff>
              ))}
            </SettingsText>
          )}
        </SettingsFact>
      ))}
    </SettingsFacts>
  );
}

const LIST_FIELDS = new Set([
  "allowed_tools",
  "capabilities",
  "abilities",
  "required_machine_tags",
]);
const BLANK_ROLE = {
  display_name: "",
  kind: "",
  instructions: "",
  core_prompt: "",
  harness: "",
  launch_profile_ref: "",
  allowed_tools: [],
  capabilities: [],
  abilities: [],
  worktree: "",
  required_machine_tags: [],
} as unknown as RoleDefinitionView;

/** The version the preview would replace, rebuilt from its changed fields. */
function previousRole(preview: RoleDocumentPreview["role"]) {
  if (preview.action === "create") return BLANK_ROLE;
  const before: Record<string, unknown> = { ...preview.role };
  for (const { field, before: value } of preview.fields)
    before[field] = value ?? (LIST_FIELDS.has(field) ? [] : "");
  return before as unknown as RoleDefinitionView;
}

export function documentChanges(preview: RoleDocumentPreview): boolean {
  return (
    preview.role.action !== "unchanged" ||
    (preview.template !== null && preview.template.action !== "unchanged") ||
    preview.employees.some((e) => e.action !== "unchanged")
  );
}

/** What one apply would write: the role, the template link and the people. */
export function RoleDocumentPreviewView({
  preview,
}: {
  preview: RoleDocumentPreview;
}) {
  const { role, template, employees } = preview;
  const before = new Map(
    (template?.before?.work_items ?? []).map((w) => [w.key, w]),
  );
  return (
    <>
      <SettingsSection title="角色">
        <SettingsFacts>
          <SettingsFact label="角色">
            {role.role.display_name}（<code>{role.role.role_id}</code>）·{" "}
            {ACTION_LABELS[role.action]}
          </SettingsFact>
        </SettingsFacts>
        {role.action !== "unchanged" && (
          <RoleDiffView
            title={
              role.action === "create"
                ? `v${role.role.version}`
                : `v${role.role.version - 1} → v${role.role.version}`
            }
            created={role.action === "create"}
            diffs={roleDiff(previousRole(role), role.role)}
          />
        )}
        {role.relaxations.length > 0 && (
          <SettingsWarning role="note" aria-label="放宽的权限">
            <p>放宽的权限：</p>
            <ul>
              {role.relaxations.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </SettingsWarning>
        )}
      </SettingsSection>
      {template && (
        <SettingsSection title="模板">
          <SettingsFacts>
            <SettingsFact label="模板">
              <code>{template.after.id}</code> · {template.after.title} ·{" "}
              {ACTION_LABELS[template.action]}
              {template.action !== "unchanged" &&
                ` · ${template.before ? `v${template.before.version} → ` : ""}v${template.after.version}`}
            </SettingsFact>
          </SettingsFacts>
          <SettingsTable aria-label="模板工作项">
            <TableHeader>
              <TableRow>
                <TableHead>工作项</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>变化</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {template.after.work_items.map((w) => {
                const old = before.get(w.key);
                return (
                  <TableRow key={w.key}>
                    <DataTableCell data-record="lead">
                      {w.title}（<code>{w.key}</code>）
                    </DataTableCell>
                    <DataTableCell nowrap data-label="角色">
                      <code>{w.role_id}</code>
                    </DataTableCell>
                    <DataTableCell nowrap data-label="类型">
                      {w.kind === "verify" ? "验证" : "产出"}
                      {w.required ? "，必需" : "，可选"}
                    </DataTableCell>
                    <DataTableCell nowrap data-record="aside">
                      {template.action === "unchanged" ? (
                        "—"
                      ) : !old ? (
                        <SettingsDiff op="add">新增</SettingsDiff>
                      ) : old.role_id !== w.role_id ? (
                        <SettingsDiff op="add">
                          {old.role_id} → {w.role_id}
                        </SettingsDiff>
                      ) : (
                        "—"
                      )}
                    </DataTableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </SettingsTable>
        </SettingsSection>
      )}
      {employees.length > 0 && (
        <SettingsSection title="员工">
          <SettingsTable aria-label="员工">
            <TableHeader>
              <TableRow>
                <TableHead>名字</TableHead>
                <TableHead>职位</TableHead>
                <TableHead>启动配置</TableHead>
                <TableHead>变化</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {employees.map((e) => (
                <TableRow key={e.name}>
                  <DataTableCell nowrap data-record="lead">
                    {e.name}
                    {e.id && !e.id.startsWith("preview-") && `（${e.id}）`}
                  </DataTableCell>
                  <DataTableCell data-label="职位">{e.title}</DataTableCell>
                  <DataTableCell nowrap data-label="启动配置">
                    {e.launch_profile_ref ?? "随角色"}
                  </DataTableCell>
                  <DataTableCell nowrap data-record="aside">
                    {e.action === "create" ? (
                      <SettingsDiff op="add">新建</SettingsDiff>
                    ) : (
                      "已存在"
                    )}
                  </DataTableCell>
                </TableRow>
              ))}
            </TableBody>
          </SettingsTable>
        </SettingsSection>
      )}
    </>
  );
}

/**
 * Preview then apply one role document (C-492). A preview belongs to the exact
 * text it was made for; a later edit hides it, and a reply for an older text
 * never shows. Apply sends the preview's snapshot with one idempotency key per
 * (text, snapshot) until it succeeds; a stale snapshot drops the preview.
 */
export function useRoleDocument(client: CardiganClient, projectId: string) {
  const [preview, setPreview] = useState<{
    source: string;
    result: RoleDocumentPreview;
  }>();
  const [error, setError] = useState<{ source: string; message: string }>();
  const [busy, setBusy] = useState<"preview" | "apply">();
  const sending = useRef(false);
  const latest = useRef("");
  const keys = useRef(new Map<string, string>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(
    async (markdown: string) => {
      if (sending.current) return;
      sending.current = true;
      latest.current = markdown;
      setBusy("preview");
      setError(undefined);
      try {
        const result = await client.previewRoleDocument(projectId, markdown);
        if (alive.current) setPreview({ source: markdown, result });
      } catch (cause) {
        if (alive.current)
          setError({ source: markdown, message: describeWriteError(cause) });
      } finally {
        sending.current = false;
        if (alive.current) setBusy(undefined);
      }
    },
    [client, projectId],
  );
  const apply = useCallback(async () => {
    if (sending.current || !preview) return undefined;
    sending.current = true;
    setBusy("apply");
    setError(undefined);
    const { source, result } = preview;
    const id = `${result.snapshot}\n${source}`;
    const key = keys.current.get(id) ?? crypto.randomUUID();
    keys.current.set(id, key);
    try {
      const applied = await client.applyRoleDocument(
        projectId,
        source,
        result.snapshot,
        key,
      );
      keys.current.delete(id);
      return alive.current ? applied : undefined;
    } catch (cause) {
      if (!alive.current) return undefined;
      if (cause instanceof ApiError && cause.code === "stale_target") {
        // The snapshot is spent: a new preview brings a new key.
        keys.current.delete(id);
        setPreview(undefined);
      }
      setError({ source, message: describeWriteError(cause) });
      return undefined;
    } finally {
      sending.current = false;
      if (alive.current) setBusy(undefined);
    }
  }, [client, projectId, preview]);
  return {
    busy,
    run,
    apply,
    /** The preview and error of this exact text only. */
    current: (markdown: string) => ({
      preview: preview?.source === markdown ? preview.result : undefined,
      error: error?.source === markdown ? error.message : undefined,
    }),
  };
}

function appliedNote(result: RoleDocumentPreview) {
  const part = (
    kind: string,
    id: string,
    action: keyof typeof ACTION_LABELS,
  ) =>
    action === "unchanged"
      ? `${kind} ${id} 不变`
      : `${ACTION_LABELS[action]}${kind} ${id}`;
  const people = result.employees.filter((e) => e.action === "create");
  return `已应用：${[
    part("角色", result.role.role.role_id, result.role.action),
    ...(result.template
      ? [part("模板", result.template.after.id, result.template.action)]
      : []),
    ...(people.length
      ? [`新建员工 ${people.map((e) => `${e.name}（${e.id}）`).join("、")}`]
      : []),
  ].join("，")}`;
}

/** Preview and apply actions shared by the import and template drawers. */
function DocumentActions({
  doc,
  markdown,
  ready,
  onCancel,
  onApplied,
}: {
  doc: ReturnType<typeof useRoleDocument>;
  markdown: string;
  ready: boolean;
  onCancel: () => void;
  onApplied: (result: RoleDocumentPreview, note: string) => void;
}) {
  const { preview } = doc.current(markdown);
  const changes = preview ? documentChanges(preview) : false;
  return (
    <>
      <SettingsDialogActions>
        <Button onClick={onCancel} disabled={doc.busy !== undefined}>
          取消
        </Button>
        <Button
          disabled={doc.busy !== undefined || !ready}
          variant={preview ? "default" : "primary"}
          onClick={() => void doc.run(markdown)}
        >
          {preview ? "重新预览" : "预览"}
        </Button>
        {preview && (
          <Button
            variant="primary"
            disabled={doc.busy !== undefined || !changes}
            onClick={async () => {
              const result = await doc.apply();
              if (result) onApplied(result, appliedNote(result));
            }}
          >
            应用
          </Button>
        )}
      </SettingsDialogActions>
      <RequestFeedback
        interactive
        pending={doc.busy !== undefined}
        pendingMessage={doc.busy === "apply" ? "正在应用…" : "正在预览…"}
      />
    </>
  );
}

function PreviewResult({
  doc,
  markdown,
}: {
  doc: ReturnType<typeof useRoleDocument>;
  markdown: string;
}) {
  const { preview } = doc.current(markdown);
  if (!preview) return null;
  return (
    <>
      {!documentChanges(preview) && <p>没有变化</p>}
      <RoleDocumentPreviewView preview={preview} />
    </>
  );
}

/** C-494 item 1: paste or upload a role document, preview, then apply. */
export function RoleImportDrawer({
  client,
  projectId,
  onClose,
  onApplied,
}: {
  client: CardiganClient;
  projectId: string;
  onClose: () => void;
  onApplied: (result: RoleDocumentPreview, note: string) => void;
}) {
  const doc = useRoleDocument(client, projectId);
  const [markdown, setMarkdown] = useState("");
  const [fileError, setFileError] = useState("");
  const [applied, setApplied] = useState(false);
  const errorId = useId();
  const { error } = doc.current(markdown);
  const fieldError = fileError || error;
  const bytes = new TextEncoder().encode(markdown).length;
  const tooLarge = bytes > ROLE_DOCUMENT_MAX_BYTES;
  const guard = useDiscardGuard(markdown.trim() !== "" && !applied, onClose);
  const readFile = (file: File | undefined) => {
    setFileError("");
    if (!file) return;
    if (file.size > ROLE_DOCUMENT_MAX_BYTES) {
      setFileError("Markdown 文件不能超过 64 KiB");
      return;
    }
    file.text().then(setMarkdown, () => setFileError("无法读取这个文件"));
  };
  return (
    <Drawer
      className={settingsDrawerClassName}
      open
      onOpenChange={(next) => {
        // Every way out waits for a preview or apply in flight.
        if (!next && doc.busy === undefined) guard.confirmClose();
      }}
      title="从 Markdown 导入"
      description="从 Markdown 导入角色"
      initialFocus="close"
    >
      <CardDetailLayout className="card-page-drawer">
        <SettingsDialogFields>
          <label>
            上传 .md 文件
            <Input
              type="file"
              accept=".md,.markdown,text/markdown,text/plain"
              disabled={doc.busy !== undefined}
              onChange={(event) => readFile(event.target.files?.[0])}
            />
          </label>
          <label>
            Markdown
            <Textarea
              rows={16}
              value={markdown}
              readOnly={doc.busy !== undefined}
              aria-invalid={fieldError || tooLarge ? true : undefined}
              aria-describedby={fieldError || tooLarge ? errorId : undefined}
              onChange={(event) => {
                setFileError("");
                setMarkdown(event.target.value);
              }}
            />
          </label>
          {(fieldError || tooLarge) && (
            <SettingsWarning id={errorId} role="alert">
              {fieldError || "Markdown 文件不能超过 64 KiB"}
            </SettingsWarning>
          )}
        </SettingsDialogFields>
        <DocumentActions
          doc={doc}
          markdown={markdown}
          ready={markdown.trim() !== "" && !tooLarge}
          onCancel={guard.confirmClose}
          onApplied={(result, note) => {
            setApplied(true);
            onApplied(result, note);
          }}
        />
        <PreviewResult doc={doc} markdown={markdown} />
        {guard.dialog}
      </CardDetailLayout>
    </Drawer>
  );
}

/** Insert a `template:` section into an exported document (JSON is valid YAML). */
export function withTemplate(markdown: string, template: object): string {
  return markdown.replace(
    /^---\n([\s\S]*?\n)---\n/u,
    (_all, head: string) =>
      `---\n${head}template: ${JSON.stringify(template)}\n---\n`,
  );
}

type TemplateMode = "append" | "copy";

/**
 * C-494 item 2: put a role into a card template through the same document
 * preview/apply — append a work item to a project template, or copy any
 * template with one of its roles replaced by this role.
 */
export function RoleTemplateDrawer({
  client,
  projectId,
  role,
  onClose,
  onApplied,
}: {
  client: CardiganClient;
  projectId: string;
  role: RoleDefinitionView;
  onClose: () => void;
  onApplied: (result: RoleDocumentPreview, note: string) => void;
}) {
  const loadTemplates = useCallback(
    () => client.templates(projectId),
    [client, projectId],
  );
  const templates = useResource(loadTemplates);
  const loadExport = useCallback(
    () => client.exportRole(projectId, role.role_id),
    [client, projectId, role.role_id],
  );
  const exported = useResource(loadExport);
  const doc = useRoleDocument(client, projectId);
  const [mode, setMode] = useState<TemplateMode>("append");
  const [target, setTarget] = useState("");
  const [source, setSource] = useState("");
  const [newId, setNewId] = useState("");
  const [replace, setReplace] = useState("");
  const [key, setKey] = useState(role.role_id);
  const [title, setTitle] = useState(role.display_name);
  const [kind, setKind] = useState<"produce" | "verify">(
    role.kind === "verify" ? "verify" : "produce",
  );
  const [required, setRequired] = useState(true);
  const [targetItem, setTargetItem] = useState("");
  const [applied, setApplied] = useState(false);
  const all = templates.data?.templates ?? [];
  const editable = all.filter((t) => !t.builtin && t.status === "active");
  const appendTo = editable.find((t) => t.id === target);
  const copyFrom = all.find((t) => t.id === source);
  const replaceable = [
    ...new Set(copyFrom?.work_items.map((w) => w.role_id) ?? []),
  ];
  const produces = (appendTo?.work_items ?? []).filter(
    (w) => w.kind === "produce",
  );
  const idPattern = /^[a-z0-9][a-z0-9._-]*$/u;
  const section =
    mode === "append"
      ? appendTo && idPattern.test(key) && title.trim()
        ? {
            id: appendTo.id,
            add_work_item: {
              key,
              title: title.trim(),
              required,
              kind,
              ...(kind === "verify" && targetItem
                ? { target_work_item_key: targetItem }
                : {}),
            },
          }
        : undefined
      : copyFrom && idPattern.test(newId) && replace
        ? { id: newId, from: copyFrom.id, replace_role: replace }
        : undefined;
  const markdown =
    section && exported.data
      ? withTemplate(exported.data.markdown, section)
      : "";
  const { error } = doc.current(markdown);
  const dirty =
    !applied &&
    (target !== "" ||
      source !== "" ||
      newId !== "" ||
      replace !== "" ||
      key !== role.role_id ||
      title !== role.display_name);
  const guard = useDiscardGuard(dirty, onClose);
  const templateLabel = (t: TemplateView) =>
    `${t.title}（${t.id}${t.builtin ? "，内置" : ""}）`;
  return (
    <Drawer
      className={settingsDrawerClassName}
      open
      onOpenChange={(next) => {
        if (!next && doc.busy === undefined) guard.confirmClose();
      }}
      title="加进模板"
      description={`把角色 ${role.role_id} 加进卡片模板`}
      initialFocus="close"
    >
      <CardDetailLayout className="card-page-drawer">
        <RequestFeedback
          {...templates}
          retry={templates.reload}
          pendingMessage="正在加载模板…"
        />
        <RequestFeedback
          {...exported}
          retry={exported.reload}
          pendingMessage="正在读取角色…"
        />
        <SettingsDialogFields>
          <fieldset disabled={doc.busy !== undefined}>
            <legend>接入方式</legend>
            <ToggleGroup
              type="multiple"
              aria-label="接入方式"
              value={[mode]}
              onValueChange={(next) => {
                const value = next.at(-1);
                if (value === "append" || value === "copy") setMode(value);
              }}
            >
              <ToggleGroupItem value="append">追加到现有模板</ToggleGroupItem>
              <ToggleGroupItem value="copy">复制模板并替换角色</ToggleGroupItem>
            </ToggleGroup>
          </fieldset>
          {mode === "append" ? (
            <fieldset disabled={doc.busy !== undefined}>
              <label>
                模板
                <SelectControl value={target} onValueChange={setTarget}>
                  <option value="">请选择项目模板</option>
                  {editable.map((t) => (
                    <option key={t.id} value={t.id}>
                      {templateLabel(t)}
                    </option>
                  ))}
                </SelectControl>
              </label>
              <label>
                工作项编号
                <Input
                  value={key}
                  aria-invalid={!idPattern.test(key) || undefined}
                  onChange={(e) => setKey(e.target.value)}
                />
              </label>
              <label>
                工作项标题
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label>
                类型
                <SelectControl
                  value={kind}
                  onValueChange={(value) =>
                    setKind(value === "verify" ? "verify" : "produce")
                  }
                >
                  <option value="produce">产出</option>
                  <option value="verify">验证</option>
                </SelectControl>
              </label>
              {kind === "verify" && (
                <label>
                  验证哪个产出项
                  <SelectControl
                    value={targetItem}
                    onValueChange={setTargetItem}
                  >
                    <option value="">不指定</option>
                    {produces.map((w) => (
                      <option key={w.key} value={w.key}>
                        {w.title}（{w.key}）
                      </option>
                    ))}
                  </SelectControl>
                </label>
              )}
              <label>
                <Checkbox
                  checked={required}
                  onCheckedChange={(checked) => setRequired(checked === true)}
                />
                必需
              </label>
            </fieldset>
          ) : (
            <fieldset disabled={doc.busy !== undefined}>
              <label>
                来源模板
                <SelectControl
                  value={source}
                  onValueChange={(value) => {
                    setSource(value);
                    setReplace("");
                    if (!newId && value) setNewId(`${value}-${role.role_id}`);
                  }}
                >
                  <option value="">请选择模板</option>
                  {all.map((t) => (
                    <option key={t.id} value={t.id}>
                      {templateLabel(t)}
                    </option>
                  ))}
                </SelectControl>
              </label>
              <label>
                替换的角色
                <SelectControl value={replace} onValueChange={setReplace}>
                  <option value="">请选择角色</option>
                  {replaceable.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </SelectControl>
              </label>
              <label>
                新模板编号
                <Input
                  value={newId}
                  aria-invalid={
                    (newId !== "" && !idPattern.test(newId)) || undefined
                  }
                  onChange={(e) => setNewId(e.target.value)}
                />
              </label>
            </fieldset>
          )}
          {error && <SettingsWarning role="alert">{error}</SettingsWarning>}
        </SettingsDialogFields>
        <DocumentActions
          doc={doc}
          markdown={markdown}
          ready={markdown !== ""}
          onCancel={guard.confirmClose}
          onApplied={(result, note) => {
            setApplied(true);
            onApplied(result, note);
          }}
        />
        <PreviewResult doc={doc} markdown={markdown} />
        {guard.dialog}
      </CardDetailLayout>
    </Drawer>
  );
}
