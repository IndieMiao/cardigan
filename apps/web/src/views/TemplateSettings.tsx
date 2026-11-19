import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CardiganClient,
  describeWriteError,
  type TemplateChange,
  type TemplateDefinition,
  type TemplateDetail,
  type TemplateValidation,
  type TemplateVersion,
  type TemplateView,
} from "../api.js";
import { Drawer } from "../components/Drawer.js";
import { EmptyState, StatusTag, Time } from "../components/Foundation.js";
import { CardDetailLayout } from "../components/layout/CardDetailLayout.js";
import { DataTableCell } from "../components/layout/DataTableLayout.js";
import {
  SettingsDialogActions,
  SettingsDialogFields,
  SettingsFact,
  SettingsFacts,
  SettingsPanel,
  SettingsSection,
  SettingsTable,
  SettingsText,
  settingsDrawerClassName,
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
import { useResource } from "../useResource.js";

const mergeLabels = { none: "不合并", confirm: "确认后合并", auto: "自动合并" };
const completionLabel = (t: TemplateDefinition) =>
  t.completion.mode === "human_mark_done"
    ? "人标记完成"
    : `审核完成（${t.completion.reviewer === "human" ? "所有者" : t.completion.reviewer}）`;
const empty: TemplateDefinition = {
  id: "",
  title: "",
  description: "",
  requires_repo: false,
  merge: "none",
  require_acceptance_criteria: false,
  work_items: [],
  primary_work_item_key: null,
  completion: { mode: "human_mark_done" },
};
function definition(t: TemplateDefinition): TemplateDefinition {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    requires_repo: t.requires_repo,
    merge: t.merge,
    require_acceptance_criteria: t.require_acceptance_criteria,
    work_items: t.work_items,
    primary_work_item_key: t.primary_work_item_key,
    completion: t.completion,
  };
}

export function TemplateSettings({
  client,
  projectId,
  revision,
}: {
  client: CardiganClient;
  projectId: string;
  revision: number;
}) {
  const [selected, setSelected] = useState<string>();
  const [editing, setEditing] = useState<{
    action: "add" | "update" | "copy";
    template: TemplateDefinition;
    version?: number;
  }>();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const sending = useRef(false);
  const keys = useRef(new Map<string, string>());
  const load = useCallback(
    () => client.templates(projectId),
    [client, projectId],
  );
  const list = useResource(load, revision + refresh);
  const perform = async (change: TemplateChange) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    const input = JSON.stringify(change);
    const key = keys.current.get(input) ?? crypto.randomUUID();
    keys.current.set(input, key);
    try {
      const saved = await client.manageTemplate(projectId, change, key);
      keys.current.delete(input);
      setEditing(undefined);
      setSelected(saved.id);
      setRefresh((v) => v + 1);
      setMessage(`已保存 ${saved.title} v${saved.version}`);
    } catch (cause) {
      setError(describeWriteError(cause));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  const remember = useDrawerReturnFocus(
    selected !== undefined || editing !== undefined,
  );
  const close = () => {
    // Every way out of a drawer waits for a template write in flight.
    if (busy) return;
    setSelected(undefined);
    setEditing(undefined);
    setError("");
    setMessage("");
  };
  return (
    <SettingsPanel
      id="templates"
      tabIndex={-1}
      title="卡片模板"
      titleId="templates-title"
      help="模板修改生成新版本，已有卡片继续使用创建时的版本。停用仅阻止新建卡片。工作项的角色须在本项目登记且启用，保存时再次校验。"
      actions={
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => {
            remember();
            setSelected(undefined);
            setEditing({ action: "add", template: empty });
            setError("");
            setMessage("");
          }}
        >
          新建模板
        </Button>
      }
    >
      <RequestFeedback
        {...list}
        retry={list.reload}
        pendingMessage="正在加载模板…"
      />
      {list.data && list.data.templates.length === 0 && (
        <EmptyState>没有模板</EmptyState>
      )}
      {list.data && list.data.templates.length > 0 && (
        <SettingsTable aria-label="项目卡片模板">
          <TableHeader>
            <TableRow>
              {[
                "编号",
                "标题",
                "来源",
                "仓库要求",
                "合并方式",
                "完成方式",
                "版本",
                "状态",
              ].map((label) => (
                <TableHead key={label}>{label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.data.templates.map((t) => (
              <TableRow key={t.id}>
                <DataTableCell nowrap data-record="lead">
                  <Button
                    variant="link"
                    aria-haspopup="dialog"
                    disabled={busy}
                    onClick={() => {
                      remember();
                      setSelected(t.id);
                      setEditing(undefined);
                      setError("");
                      setMessage("");
                    }}
                  >
                    {t.id}
                  </Button>
                </DataTableCell>
                <DataTableCell data-label="标题">{t.title}</DataTableCell>
                <DataTableCell nowrap data-label="来源">
                  {t.builtin ? "内置，只读" : "项目模板"}
                </DataTableCell>
                <DataTableCell nowrap data-label="仓库要求">
                  {t.requires_repo ? "需要仓库" : "无需仓库"}
                </DataTableCell>
                <DataTableCell nowrap data-label="合并方式">
                  {mergeLabels[t.merge]}
                </DataTableCell>
                <DataTableCell data-label="完成方式">
                  {completionLabel(t)}
                </DataTableCell>
                <DataTableCell nowrap data-label="版本">
                  v{t.version}
                </DataTableCell>
                <DataTableCell nowrap data-record="aside">
                  <StatusTag
                    status={t.status}
                    label={t.status === "active" ? "启用" : "停用"}
                  />
                </DataTableCell>
              </TableRow>
            ))}
          </TableBody>
        </SettingsTable>
      )}
      {editing && (
        <Drawer
          className={settingsDrawerClassName}
          open
          onOpenChange={(next) => {
            if (!next) close();
          }}
          title={
            editing.action === "copy"
              ? "复制为项目模板"
              : editing.action === "add"
                ? "新建模板"
                : "编辑模板"
          }
          description="模板表单"
          initialFocus="close"
        >
          <CardDetailLayout className="card-page-drawer">
            <RequestFeedback
              interactive
              pending={busy}
              pendingMessage="正在保存模板…"
              error={error}
            />
            <TemplateForm
              key={`${editing.action}:${editing.template.id}:${editing.version ?? "new"}`}
              client={client}
              projectId={projectId}
              initial={editing.template}
              action={editing.action}
              version={editing.version}
              busy={busy}
              perform={perform}
              dismiss={() => {
                setEditing(undefined);
                setError("");
              }}
            />
          </CardDetailLayout>
        </Drawer>
      )}
      {!editing && selected && (
        <TemplatePanel
          key={selected}
          client={client}
          projectId={projectId}
          id={selected}
          revision={revision + refresh}
          busy={busy}
          message={message}
          error={error}
          perform={perform}
          onClose={close}
          edit={(action, t) => {
            setError("");
            setMessage("");
            setEditing({
              action,
              template: definition(t),
              version: t.version,
            });
          }}
        />
      )}
    </SettingsPanel>
  );
}

function TemplatePanel({
  client,
  projectId,
  id,
  revision,
  busy,
  message,
  error,
  perform,
  onClose,
  edit,
}: {
  client: CardiganClient;
  projectId: string;
  id: string;
  revision: number;
  busy: boolean;
  message: string;
  error: string;
  perform: (change: TemplateChange) => Promise<void>;
  onClose: () => void;
  edit: (action: "copy" | "update", t: TemplateView) => void;
}) {
  const load = useCallback(async () => {
    const [detail, history] = await Promise.all([
      client.template(projectId, id),
      client.templateHistory(projectId, id),
    ]);
    return { ...detail, ...history };
  }, [client, projectId, id]);
  const resource = useResource(load, revision);
  const [version, setVersion] = useState<number>();
  const data = resource.data;
  const template = data?.template;
  return (
    <Drawer
      className={settingsDrawerClassName}
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={template ? `${template.title} · ${template.id}` : `模板 ${id}`}
      description={`模板 ${id} 详情`}
      initialFocus="close"
      actions={
        !template ? undefined : template.builtin ? (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => edit("copy", template)}
          >
            复制为项目模板
          </Button>
        ) : (
          <>
            <Button
              disabled={busy}
              onClick={() =>
                void perform({
                  action:
                    template.status === "active" ? "deactivate" : "activate",
                  template_id: id,
                })
              }
            >
              {template.status === "active" ? "停用模板" : "启用模板"}
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => edit("update", template)}
            >
              编辑模板
            </Button>
          </>
        )
      }
    >
      <CardDetailLayout className="card-page-drawer" aria-label={`模板 ${id}`}>
        <RequestFeedback
          interactive
          pending={busy}
          pendingMessage="正在保存模板…"
          message={message}
          error={error}
        />
        <RequestFeedback
          {...resource}
          retry={resource.reload}
          pendingMessage="正在加载模板详情…"
        />
        {data && template && (
          <TemplateVersionView
            data={data}
            version={version}
            setVersion={setVersion}
            busy={busy}
            perform={perform}
          />
        )}
      </CardDetailLayout>
    </Drawer>
  );
}

function TemplateVersionView({
  data,
  version,
  setVersion,
  busy,
  perform,
}: {
  data: TemplateDetail & { versions: TemplateVersion[] };
  version: number | undefined;
  setVersion: (version: number) => void;
  busy: boolean;
  perform: (change: TemplateChange) => Promise<void>;
}) {
  const { template, previous, versions } = data;
  const id = template.id;
  const shown = versions.find((t) => t.version === version) ?? template;
  const before =
    versions.find((t) => t.version === shown.version - 1) ??
    (shown.version === template.version ? previous : null);
  return (
    <>
      <SettingsSection title="版本">
        <SettingsDialogFields>
          <label>
            查看版本
            <SelectControl
              value={shown.version}
              onValueChange={(e) => setVersion(Number(e))}
            >
              {versions.map((t) => (
                <option key={t.version} value={t.version}>
                  v{t.version} · {t.summary}
                </option>
              ))}
            </SelectControl>
          </label>
        </SettingsDialogFields>
        <SettingsFacts>
          <SettingsFact label="来源">
            {template.builtin ? "内置，只读" : "项目模板"}
          </SettingsFact>
          <SettingsFact label="生成时间">
            {shown.created_at ? (
              <Time value={shown.created_at} />
            ) : (
              "未知（历史数据未记录）"
            )}
          </SettingsFact>
        </SettingsFacts>
        {!template.builtin && shown.version !== template.version && (
          <SettingsDialogActions>
            <Button
              disabled={busy}
              onClick={() =>
                void perform({
                  action: "rollback",
                  template_id: id,
                  version: shown.version,
                })
              }
            >
              回退到 v{shown.version}（生成新版本）
            </Button>
          </SettingsDialogActions>
        )}
      </SettingsSection>
      <TemplateContent detail={{ template: shown, previous: before }} />
    </>
  );
}

function TemplateContent({ detail }: { detail: TemplateDetail }) {
  const t = detail.template;
  const values = (item: TemplateDefinition) => ({
    标题: item.title,
    描述: item.description,
    仓库要求: item.requires_repo ? "需要仓库" : "无需仓库",
    合并方式: mergeLabels[item.merge],
    要求验收标准: item.require_acceptance_criteria ? "是" : "否",
    "主产出 key": item.primary_work_item_key ?? "无",
    完成方式: completionLabel(item),
    工作项: JSON.stringify(item.work_items, null, 2),
  });
  const current = values(t),
    previous = detail.previous && values(detail.previous);
  const changed = previous
    ? (Object.keys(current).filter(
        (key) =>
          current[key as keyof typeof current] !==
          previous[key as keyof typeof previous],
      ) as (keyof typeof current)[])
    : [];
  return (
    <>
      <SettingsSection title="内容">
        <SettingsFacts>
          <SettingsFact label="描述">
            {t.description || "暂无描述"}
          </SettingsFact>
          <SettingsFact label="仓库要求">{current.仓库要求}</SettingsFact>
          <SettingsFact label="合并方式">{current.合并方式}</SettingsFact>
          <SettingsFact label="要求验收标准">
            {current.要求验收标准}
          </SettingsFact>
          <SettingsFact label="主产出 key">
            {current["主产出 key"]}
          </SettingsFact>
          <SettingsFact label="完成方式">{current.完成方式}</SettingsFact>
        </SettingsFacts>
      </SettingsSection>
      <SettingsSection title="工作项">
        {!t.work_items.length ? (
          <p>无默认工作项</p>
        ) : (
          <SettingsTable aria-label="工作项">
            <TableHeader>
              <TableRow>
                <TableHead>标题</TableHead>
                <TableHead>key</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>必需</TableHead>
                <TableHead>验证目标</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {t.work_items.map((w) => (
                <TableRow key={w.key}>
                  <DataTableCell data-record="lead">{w.title}</DataTableCell>
                  <DataTableCell nowrap data-label="key">
                    <code>{w.key}</code>
                  </DataTableCell>
                  <DataTableCell nowrap data-label="类型">
                    {w.kind === "produce" ? "产出" : "验证"}
                  </DataTableCell>
                  <DataTableCell nowrap data-label="角色">
                    {w.role_id}
                  </DataTableCell>
                  <DataTableCell nowrap data-record="aside">
                    {w.required ? "必需" : "可选"}
                  </DataTableCell>
                  <DataTableCell nowrap data-label="验证目标">
                    {w.target_work_item_key ?? "—"}
                  </DataTableCell>
                </TableRow>
              ))}
            </TableBody>
          </SettingsTable>
        )}
      </SettingsSection>
      <SettingsSection title="与上一版本的差异">
        {!previous ? (
          <p>首个版本，无上一版本。</p>
        ) : !changed.length ? (
          <p>内容无变化。</p>
        ) : (
          <SettingsFacts>
            {changed.map((key) => (
              <SettingsFact key={key} label={key}>
                <span>之前</span>
                <SettingsText>{previous[key]}</SettingsText>
                <span>现在</span>
                <SettingsText>{current[key]}</SettingsText>
              </SettingsFact>
            ))}
          </SettingsFacts>
        )}
        {detail.previous && detail.previous.status !== t.status && (
          <p>
            状态：{detail.previous.status === "active" ? "启用" : "停用"} →{" "}
            {t.status === "active" ? "启用" : "停用"}
          </p>
        )}
      </SettingsSection>
    </>
  );
}

function TemplateForm({
  client,
  projectId,
  initial,
  action,
  version,
  busy,
  perform,
  dismiss,
}: {
  client: CardiganClient;
  projectId: string;
  initial: TemplateDefinition;
  action: "add" | "copy" | "update";
  version: number | undefined;
  busy: boolean;
  perform: (change: TemplateChange) => Promise<void>;
  dismiss: () => void;
}) {
  const [draft, setDraft] = useState(() => ({
    ...initial,
    id: action === "copy" ? "" : initial.id,
  }));
  const [rowKeys, setRowKeys] = useState(() =>
    initial.work_items.map(() => crypto.randomUUID()),
  );
  const change: TemplateChange =
    action === "copy"
      ? {
          action,
          template_id: initial.id,
          new_id: draft.id,
          ...(version === undefined ? {} : { version }),
        }
      : { action, definition: draft };
  const request = JSON.stringify(change);
  const [validation, setValidation] = useState<{
    request: string;
    retry: number;
    result: TemplateValidation;
  }>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      client
        .validateTemplate(projectId, JSON.parse(request) as TemplateChange)
        .then(
          (result) => {
            if (active) setValidation({ request, retry, result });
          },
          (cause) => {
            if (active)
              setValidation({
                request,
                retry,
                result: {
                  valid: false,
                  reason: describeWriteError(cause, "请重试校验。"),
                },
              });
          },
        );
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [client, projectId, request, retry]);
  const checked =
    validation?.request === request && validation.retry === retry
      ? validation.result
      : undefined;
  const patch = (value: Partial<TemplateDefinition>) =>
    setDraft((old) => ({ ...old, ...value }));
  const item = (
    index: number,
    value: Partial<TemplateDefinition["work_items"][number]>,
  ) =>
    patch({
      work_items: draft.work_items.map((w, i) =>
        i === index ? { ...w, ...value } : w,
      ),
    });
  return (
    <form
      aria-label={action === "copy" ? "复制模板" : "模板表单"}
      onSubmit={(event) => {
        event.preventDefault();
        if (checked?.valid && !busy) void perform(change);
      }}
    >
      <SettingsDialogFields>
        <fieldset disabled={busy}>
          <label>
            模板编号
            <Input
              required
              disabled={action === "update"}
              value={draft.id}
              onChange={(e) => patch({ id: e.target.value })}
            />
          </label>
          {action === "copy" ? (
            <p>
              从 {initial.title} v{version} 复制，保存后可编辑项目模板。
            </p>
          ) : (
            <>
              <label>
                模板标题
                <Input
                  required
                  value={draft.title}
                  onChange={(e) => patch({ title: e.target.value })}
                />
              </label>
              <label>
                模板描述
                <Textarea
                  rows={2}
                  value={draft.description}
                  onChange={(e) => patch({ description: e.target.value })}
                />
              </label>
              <label>
                <Checkbox
                  checked={draft.requires_repo}
                  onCheckedChange={(c) => patch({ requires_repo: c === true })}
                />
                需要仓库
              </label>
              <label>
                合并方式
                <SelectControl
                  value={draft.merge}
                  onValueChange={(e) =>
                    patch({
                      merge: e as TemplateDefinition["merge"],
                    })
                  }
                >
                  {Object.entries(mergeLabels).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </SelectControl>
              </label>
              <label>
                <Checkbox
                  checked={draft.require_acceptance_criteria}
                  onCheckedChange={(c) =>
                    patch({ require_acceptance_criteria: c === true })
                  }
                />
                要求验收标准
              </label>
              <fieldset>
                <legend>工作项</legend>
                {draft.work_items.map((w, index) => (
                  <fieldset key={rowKeys[index]}>
                    <legend>工作项 {index + 1}</legend>
                    <label>
                      工作项 key
                      <Input
                        required
                        value={w.key}
                        onChange={(e) => item(index, { key: e.target.value })}
                      />
                    </label>
                    <label>
                      工作项标题
                      <Input
                        required
                        value={w.title}
                        onChange={(e) => item(index, { title: e.target.value })}
                      />
                    </label>
                    <label>
                      工作项类型
                      <SelectControl
                        value={w.kind}
                        onValueChange={(e) => {
                          const { target_work_item_key: _target, ...rest } = w;
                          patch({
                            work_items: draft.work_items.map((old, i) =>
                              i === index
                                ? {
                                    ...rest,
                                    kind: e as "produce" | "verify",
                                  }
                                : old,
                            ),
                          });
                        }}
                      >
                        <option value="produce">产出</option>
                        <option value="verify">验证</option>
                      </SelectControl>
                    </label>
                    <label>
                      角色编号
                      <Input
                        required
                        value={w.role_id}
                        onChange={(e) =>
                          item(index, { role_id: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      <Checkbox
                        checked={w.required}
                        onCheckedChange={(c) =>
                          item(index, { required: c === true })
                        }
                      />
                      必需工作项
                    </label>
                    {w.kind === "verify" && (
                      <label>
                        验证目标
                        <SelectControl
                          value={w.target_work_item_key ?? ""}
                          onValueChange={(e) => {
                            const { target_work_item_key: _target, ...rest } =
                              w;
                            patch({
                              work_items: draft.work_items.map((old, i) =>
                                i === index
                                  ? {
                                      ...rest,
                                      ...(e ? { target_work_item_key: e } : {}),
                                    }
                                  : old,
                              ),
                            });
                          }}
                        >
                          <option value="">无（完成验收）</option>
                          {draft.work_items
                            .filter((t) => t.kind === "produce")
                            .map((t) => (
                              <option
                                key={rowKeys[draft.work_items.indexOf(t)]}
                                value={t.key}
                              >
                                {t.title || t.key}
                              </option>
                            ))}
                        </SelectControl>
                      </label>
                    )}
                    <SettingsDialogActions>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setRowKeys((keys) =>
                            keys.filter((_, i) => i !== index),
                          );
                          patch({
                            work_items: draft.work_items.filter(
                              (_, i) => i !== index,
                            ),
                          });
                        }}
                      >
                        删除工作项 {index + 1}
                      </Button>
                    </SettingsDialogActions>
                  </fieldset>
                ))}
                <SettingsDialogActions>
                  <Button
                    onClick={() => {
                      setRowKeys((keys) => [...keys, crypto.randomUUID()]);
                      patch({
                        work_items: [
                          ...draft.work_items,
                          {
                            key: "",
                            title: "",
                            role_id: "",
                            kind: "produce",
                            required: true,
                          },
                        ],
                      });
                    }}
                  >
                    添加工作项
                  </Button>
                </SettingsDialogActions>
              </fieldset>
              <label>
                主产出 key
                <SelectControl
                  value={draft.primary_work_item_key ?? ""}
                  onValueChange={(e) =>
                    patch({ primary_work_item_key: e || null })
                  }
                >
                  <option value="">无</option>
                  {draft.work_items
                    .filter((w) => w.kind === "produce")
                    .map((w) => (
                      <option
                        key={rowKeys[draft.work_items.indexOf(w)]}
                        value={w.key}
                      >
                        {w.title || w.key}
                      </option>
                    ))}
                </SelectControl>
              </label>
              <label>
                完成方式
                <SelectControl
                  value={draft.completion.mode}
                  onValueChange={(e) =>
                    patch({
                      completion:
                        e === "review"
                          ? { mode: "review", reviewer: "human" }
                          : { mode: "human_mark_done" },
                    })
                  }
                >
                  <option value="human_mark_done">人标记完成</option>
                  <option value="review">审核完成</option>
                </SelectControl>
              </label>
              {draft.completion.mode === "review" && (
                <label>
                  完成审核者
                  <Input
                    value={draft.completion.reviewer}
                    placeholder="human 或 role:pm"
                    onChange={(e) =>
                      patch({
                        completion: {
                          mode: "review",
                          reviewer: e.target.value,
                        },
                      })
                    }
                  />
                </label>
              )}
            </>
          )}
          <RequestFeedback
            pending={!checked}
            interactive={retry > 0 && validation?.request === request}
            pendingMessage="正在校验…"
            error={checked?.reason ?? undefined}
            retry={() => setRetry((v) => v + 1)}
            retryLabel="重新校验"
          />
          <SettingsDialogActions>
            <Button onClick={dismiss}>放弃修改</Button>
            <Button type="submit" variant="primary" disabled={!checked?.valid}>
              {action === "copy" ? "确认复制" : "保存模板"}
            </Button>
          </SettingsDialogActions>
        </fieldset>
      </SettingsDialogFields>
    </form>
  );
}
