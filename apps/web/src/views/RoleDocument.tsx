import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  ApiError,
  type CardiganClient,
  describeWriteError,
  type RoleDefinitionView,
  type RoleDocumentPreview,
  type RoleKind,
  type RoleWorktree,
  type TemplateDefinition,
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
  SettingsFileButton,
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
  diffLines,
  ROLE_FIELD_LABELS,
  ROLE_KIND_LABELS,
  type RoleFieldDiff,
  WORKTREE_LABELS,
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

const TEXT_FIELDS = new Set(["instructions", "core_prompt"]);

function shown(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "（空）";
  if (field === "kind" && typeof value === "string")
    return ROLE_KIND_LABELS[value as RoleKind] ?? value;
  if (field === "worktree" && typeof value === "string")
    return WORKTREE_LABELS[value as RoleWorktree] ?? value;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * The role diff exactly as the server computed it (`fields`), including
 * fields the edit form does not know, such as machine requirements.
 */
export function previewFieldDiffs(
  fields: RoleDocumentPreview["role"]["fields"],
): RoleFieldDiff[] {
  return fields.map(({ field, before, after }): RoleFieldDiff => {
    if (Array.isArray(before) || Array.isArray(after)) {
      const a = (Array.isArray(before) ? before : []).map(String);
      const b = (Array.isArray(after) ? after : []).map(String);
      return {
        field,
        type: "list",
        added: b.filter((v) => !a.includes(v)),
        removed: a.filter((v) => !b.includes(v)),
      };
    }
    if (TEXT_FIELDS.has(field))
      return {
        field,
        type: "text",
        lines: diffLines(
          typeof before === "string" ? before : "",
          typeof after === "string" ? after : "",
        ),
      };
    return {
      field,
      type: "value",
      before: shown(field, before),
      after: shown(field, after),
    };
  });
}

type WorkItem = TemplateDefinition["work_items"][number];
const TEMPLATE_FIELD_LABELS: Readonly<Record<string, string>> = {
  title: "标题",
  description: "说明",
  requires_repo: "需要仓库",
  merge: "合并方式",
  require_acceptance_criteria: "需要验收标准",
  primary_work_item_key: "主产出项",
  completion: "完成方式",
};
const IGNORED_TEMPLATE_FIELDS = new Set([
  "id",
  "completion",
  "work_items",
  "version",
  "builtin",
  "status",
  "summary",
  "created_at",
]);
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

type Change = { readonly op?: "add" | "remove"; readonly text: string };
type Requirements = {
  readonly os?: string;
  readonly arch?: string;
  readonly tags?: readonly string[];
  readonly capabilities?: readonly string[];
};
const REQUIREMENT_LABELS = {
  os: "系统",
  arch: "架构",
  tags: "机器标签",
  capabilities: "机器能力",
} as const;
const WORK_ITEM_FIELD_LABELS: Readonly<Record<string, string>> = {
  completion_criteria: "完成标准",
};

function requirementsOf(item: WorkItem | undefined): Requirements {
  return ((item as { requirements?: Requirements } | undefined)?.requirements ??
    {}) as Requirements;
}

/** The machine constraints a work item asks for, in words. */
export function requirementsText(item: WorkItem | undefined): string {
  const r = requirementsOf(item);
  return [
    ...(["os", "arch"] as const)
      .filter((k) => r[k])
      .map((k) => `${REQUIREMENT_LABELS[k]} ${r[k]}`),
    ...(["tags", "capabilities"] as const)
      .filter((k) => r[k]?.length)
      .map((k) => `${REQUIREMENT_LABELS[k]} ${r[k]?.join("、")}`),
  ].join("；");
}

/**
 * Every machine constraint added, changed or removed. Removing one widens
 * where the work may run, so it is shown as a removal with its old value.
 */
function requirementChanges(before: Requirements, after: Requirements) {
  const out: Change[] = [];
  for (const k of ["os", "arch"] as const)
    if ((before[k] ?? "") !== (after[k] ?? ""))
      out.push(
        after[k]
          ? {
              op: "add",
              text: `${REQUIREMENT_LABELS[k]} ${before[k] ?? "不限"} → ${after[k]}`,
            }
          : {
              op: "remove",
              text: `移除${REQUIREMENT_LABELS[k]}限制 ${before[k]}`,
            },
      );
  for (const k of ["tags", "capabilities"] as const) {
    const a = before[k] ?? [];
    const b = after[k] ?? [];
    const added = b.filter((v) => !a.includes(v));
    const removed = a.filter((v) => !b.includes(v));
    if (added.length)
      out.push({
        op: "add",
        text: `新增${REQUIREMENT_LABELS[k]} ${added.join("、")}`,
      });
    if (removed.length)
      out.push({
        op: "remove",
        text: `移除${REQUIREMENT_LABELS[k]} ${removed.join("、")}`,
      });
  }
  return out;
}

/** What changes for one work item key: added, removed or each changed part. */
export function workItemChanges(
  before: WorkItem | undefined,
  after: WorkItem | undefined,
): Change[] {
  if (!before) return [{ op: "add", text: "新增" }];
  if (!after) return [{ op: "remove", text: "删除" }];
  const parts: Change[] = [];
  if (before.title !== after.title)
    parts.push({ op: "add", text: `标题 ${before.title} → ${after.title}` });
  if (before.role_id !== after.role_id)
    parts.push({
      op: "add",
      text: `角色 ${before.role_id} → ${after.role_id}`,
    });
  if (before.kind !== after.kind)
    parts.push({
      op: "add",
      text: `类型 ${before.kind === "verify" ? "验证" : "产出"} → ${after.kind === "verify" ? "验证" : "产出"}`,
    });
  if (before.required !== after.required)
    parts.push(
      after.required
        ? { op: "add", text: "改为必需" }
        : { op: "remove", text: "改为可选" },
    );
  if (
    (before.target_work_item_key ?? "") !== (after.target_work_item_key ?? "")
  )
    parts.push({
      op: "add",
      text: `验证对象 ${before.target_work_item_key ?? "—"} → ${after.target_work_item_key ?? "—"}`,
    });
  parts.push(
    ...requirementChanges(requirementsOf(before), requirementsOf(after)),
  );
  const known = [
    "key",
    "title",
    "role_id",
    "kind",
    "required",
    "target_work_item_key",
    "requirements",
  ];
  const b = before as unknown as Record<string, unknown>;
  const a = after as unknown as Record<string, unknown>;
  const rest = new Set(
    [...Object.keys(b), ...Object.keys(a)].filter((k) => !known.includes(k)),
  );
  for (const key of rest)
    if (!same(b[key], a[key]))
      parts.push({
        op: "add",
        text: `${WORK_ITEM_FIELD_LABELS[key] ?? key} ${shown(key, b[key])} → ${shown(key, a[key])}`,
      });
  return parts;
}

/** How a card made from this template is completed, and by whom. */
export function completionText(
  completion: TemplateDefinition["completion"] | undefined,
): string {
  if (!completion) return "—";
  if (completion.mode === "human_mark_done") return "人标记完成";
  const reviewer = completion.reviewer;
  return `审核完成，完成审核者：${
    reviewer === "human"
      ? "所有者"
      : reviewer.startsWith("role:")
        ? `角色 ${reviewer.slice(5)}`
        : reviewer
  }`;
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
  const after = new Map(
    (template?.after.work_items ?? []).map((w) => [w.key, w]),
  );
  // Removed items stay listed, after the ones that remain.
  const itemKeys = [
    ...after.keys(),
    ...[...before.keys()].filter((key) => !after.has(key)),
  ];
  const templateFields =
    template?.before && template.action === "update"
      ? [
          ...new Set([
            ...Object.keys(template.before),
            ...Object.keys(template.after),
          ]),
        ].filter(
          (key) =>
            !IGNORED_TEMPLATE_FIELDS.has(key) &&
            !same(
              template.before?.[key as keyof TemplateDefinition],
              template.after[key as keyof TemplateDefinition],
            ),
        )
      : [];
  return (
    <>
      <SettingsSection title="角色">
        <SettingsFacts>
          <SettingsFact label="角色">
            {role.role.display_name}（<code>{role.role.role_id}</code>）·{" "}
            {ACTION_LABELS[role.action]}
          </SettingsFact>
        </SettingsFacts>
        {role.action !== "unchanged" && role.fields.length > 0 && (
          <RoleDiffView
            title={
              role.action === "create"
                ? `v${role.role.version}`
                : `v${role.role.version - 1} → v${role.role.version}`
            }
            created={role.action === "create"}
            diffs={previewFieldDiffs(role.fields)}
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
          {templateFields.length > 0 && (
            <SettingsFacts>
              {templateFields.map((field) => (
                <SettingsFact
                  key={field}
                  label={TEMPLATE_FIELD_LABELS[field] ?? field}
                >
                  {shown(
                    field,
                    template?.before?.[field as keyof TemplateDefinition],
                  )}{" "}
                  →{" "}
                  {shown(
                    field,
                    template?.after[field as keyof TemplateDefinition],
                  )}
                </SettingsFact>
              ))}
            </SettingsFacts>
          )}
          <SettingsFacts>
            <SettingsFact label="完成方式">
              {template.action === "update" &&
              template.before &&
              !same(template.before.completion, template.after.completion) ? (
                <SettingsDiff op="add">
                  {completionText(template.before.completion)} →{" "}
                  {completionText(template.after.completion)}
                </SettingsDiff>
              ) : (
                completionText(template.after.completion)
              )}
            </SettingsFact>
          </SettingsFacts>
          <SettingsTable aria-label="模板工作项">
            <TableHeader>
              <TableRow>
                <TableHead>工作项</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>机器要求</TableHead>
                <TableHead>变化内容</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {itemKeys.map((key) => {
                const old = before.get(key);
                const next = after.get(key);
                const w = (next ?? old) as WorkItem;
                const status: Change =
                  template.action === "create" || !old
                    ? { op: "add", text: "新增" }
                    : !next
                      ? { op: "remove", text: "删除" }
                      : { text: "—" };
                // Details only for items that stay; on narrow screens they
                // take their own labelled line, never the record's first line.
                const changes =
                  template.action !== "create" && old && next
                    ? workItemChanges(old, next)
                    : [];
                const shownStatus: Change = changes.length
                  ? { op: "add", text: "修改" }
                  : status;
                return (
                  <TableRow key={key}>
                    <DataTableCell nowrap data-record="lead">
                      {w.title}（<code>{w.key}</code>）
                    </DataTableCell>
                    <DataTableCell nowrap data-label="角色">
                      <code>{w.role_id}</code>
                    </DataTableCell>
                    <DataTableCell nowrap data-label="类型">
                      {w.kind === "verify"
                        ? `验证${w.target_work_item_key ? ` ${w.target_work_item_key}` : ""}`
                        : "产出"}
                      {w.required ? "，必需" : "，可选"}
                    </DataTableCell>
                    <DataTableCell data-label="机器要求">
                      {requirementsText(w) || "不限"}
                    </DataTableCell>
                    <DataTableCell data-label="变化内容">
                      {changes.length
                        ? changes.map((change, index) => (
                            <SettingsDiff
                              // biome-ignore lint/suspicious/noArrayIndexKey: changes are positional.
                              key={index}
                              op={change.op}
                            >
                              {index > 0 && "；"}
                              {change.text}
                            </SettingsDiff>
                          ))
                        : "—"}
                    </DataTableCell>
                    <DataTableCell nowrap data-record="aside">
                      {shownStatus.op ? (
                        <SettingsDiff op={shownStatus.op}>
                          {shownStatus.text}
                        </SettingsDiff>
                      ) : (
                        shownStatus.text
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
  problem,
  onCancel,
  onApplied,
}: {
  doc: ReturnType<typeof useRoleDocument>;
  markdown: string;
  ready: boolean;
  /** Why this preview may not be applied from here (shown above the buttons). */
  problem?: string | undefined;
  onCancel: () => void;
  onApplied: (result: RoleDocumentPreview, note: string) => void;
}) {
  const { preview } = doc.current(markdown);
  const changes = preview ? documentChanges(preview) : false;
  return (
    <>
      {preview && problem && (
        <SettingsWarning role="alert">{problem}</SettingsWarning>
      )}
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
            disabled={doc.busy !== undefined || !changes || !!problem}
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
  const [reading, setReading] = useState(false);
  const [applied, setApplied] = useState(false);
  const fileVersion = useRef(0);
  const errorId = useId();
  const { error } = doc.current(markdown);
  const fieldError = fileError || error;
  const bytes = new TextEncoder().encode(markdown).length;
  const tooLarge = bytes > ROLE_DOCUMENT_MAX_BYTES;
  const guard = useDiscardGuard(markdown.trim() !== "" && !applied, onClose);
  const readFile = (file: File | undefined) => {
    if (!file) return;
    // A new choice replaces the text at once: the previous file's preview can
    // no longer be applied, and only the latest read may fill the field.
    const current = ++fileVersion.current;
    setMarkdown("");
    setFileError("");
    if (file.size > ROLE_DOCUMENT_MAX_BYTES) {
      setReading(false);
      setFileError("Markdown 文件不能超过 64 KiB");
      return;
    }
    setReading(true);
    file.text().then(
      (text) => {
        if (current !== fileVersion.current) return;
        setReading(false);
        setMarkdown(text);
      },
      () => {
        if (current !== fileVersion.current) return;
        setReading(false);
        setFileError("无法读取这个文件");
      },
    );
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
          <SettingsFileButton
            label="上传 .md 文件"
            accept=".md,.markdown,text/markdown,text/plain"
            disabled={doc.busy !== undefined}
            onFile={readFile}
          />
          <label>
            Markdown
            <Textarea
              rows={16}
              value={markdown}
              readOnly={doc.busy !== undefined || reading}
              aria-invalid={fieldError || tooLarge ? true : undefined}
              aria-describedby={fieldError || tooLarge ? errorId : undefined}
              onChange={(event) => {
                // Typing wins over a file still being read.
                fileVersion.current++;
                setReading(false);
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
          {reading && (
            <RequestFeedback
              pending
              interactive
              pendingMessage="正在读取文件…"
            />
          )}
        </SettingsDialogFields>
        <PreviewResult doc={doc} markdown={markdown} />
        <DocumentActions
          doc={doc}
          markdown={markdown}
          ready={markdown.trim() !== "" && !tooLarge && !reading}
          onCancel={guard.confirmClose}
          onApplied={(result, note) => {
            setApplied(true);
            onApplied(result, note);
          }}
        />
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
  const { error, preview } = doc.current(markdown);
  // This entry only links the role into a template: the role itself must not
  // change, a copy must create a new template and an append must update one.
  const problem = !preview
    ? undefined
    : preview.role.action !== "unchanged"
      ? "角色在打开后已有新版本，已重新读取，请重新预览"
      : mode === "copy" && preview.template?.action !== "create"
        ? `模板 ${newId} 已存在，请换一个新模板编号`
        : mode === "append" && preview.template?.action === "create"
          ? "所选模板已不存在，请重新选择"
          : undefined;
  const staleRole =
    preview?.role.action !== "unchanged" ? preview?.snapshot : undefined;
  const reloadExport = exported.reload;
  const reloaded = useRef<string | undefined>(undefined);
  useEffect(() => {
    // Read the current role once per stale preview; the new text needs a new preview.
    if (!staleRole || reloaded.current === staleRole) return;
    reloaded.current = staleRole;
    reloadExport();
  }, [staleRole, reloadExport]);
  const initial = useRef({
    mode,
    target,
    source,
    newId,
    replace,
    key,
    title,
    kind,
    required,
    targetItem,
  });
  const dirty =
    !applied &&
    JSON.stringify({
      mode,
      target,
      source,
      newId,
      replace,
      key,
      title,
      kind,
      required,
      targetItem,
    }) !== JSON.stringify(initial.current);
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
        <PreviewResult doc={doc} markdown={markdown} />
        <DocumentActions
          doc={doc}
          markdown={markdown}
          ready={markdown !== ""}
          problem={problem}
          onCancel={guard.confirmClose}
          onApplied={(result, note) => {
            setApplied(true);
            onApplied(result, note);
          }}
        />
        {guard.dialog}
      </CardDetailLayout>
    </Drawer>
  );
}
