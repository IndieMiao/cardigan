import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CardiganClient,
  describeWriteError,
  type TemplateChange,
  type TemplateDefinition,
  type TemplateDetail,
  type TemplateValidation,
  type TemplateView,
} from "../api.js";
import { StatusTag, Time } from "../components/Foundation.js";
import { useResource } from "../useResource.js";

const mergeLabels = { none: "不合并", confirm: "确认后合并", auto: "自动合并" };
const completionLabel = (t: TemplateDefinition) =>
  t.completion.mode === "human_mark_done"
    ? "人标记完成"
    : `审核完成（${t.completion.reviewer === "human" ? "人" : t.completion.reviewer}）`;
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
  return (
    <section className="template-settings" aria-labelledby="templates-title">
      <div className="template-toolbar">
        <h2 id="templates-title">卡片模板</h2>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setEditing({ action: "add", template: empty });
            setError("");
          }}
        >
          新建模板
        </button>
      </div>
      <p className="hint">
        模板修改生成新版本，已有卡片继续使用创建时的版本。停用仅阻止新建卡片。
      </p>
      {list.error && (
        <p role="alert">
          {list.error}{" "}
          <button type="button" onClick={list.reload}>
            重试
          </button>
        </p>
      )}
      {!list.data && !list.error && <p role="status">正在加载模板…</p>}
      {list.data && (
        <div className="template-table-scroll">
          <table>
            <caption>项目卡片模板</caption>
            <thead>
              <tr>
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
                  <th key={label} scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.data.templates.map((t) => (
                <tr key={t.id}>
                  <td>
                    <button
                      type="button"
                      className="quiet"
                      disabled={busy}
                      onClick={() => {
                        setSelected(t.id);
                        setEditing(undefined);
                        setError("");
                      }}
                    >
                      {t.id}
                    </button>
                  </td>
                  <td>{t.title}</td>
                  <td>{t.builtin ? "内置，只读" : "项目模板"}</td>
                  <td>{t.requires_repo ? "需要仓库" : "无需仓库"}</td>
                  <td>{mergeLabels[t.merge]}</td>
                  <td>{completionLabel(t)}</td>
                  <td>v{t.version}</td>
                  <td>
                    <StatusTag
                      status={t.status}
                      label={t.status === "active" ? "启用" : "停用"}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      {editing ? (
        <TemplateForm
          key={`${editing.action}:${editing.template.id}:${editing.version ?? "new"}`}
          client={client}
          projectId={projectId}
          initial={editing.template}
          action={editing.action}
          version={editing.version}
          busy={busy}
          perform={perform}
          dismiss={() => setEditing(undefined)}
        />
      ) : (
        selected && (
          <TemplatePanel
            key={selected}
            client={client}
            projectId={projectId}
            id={selected}
            revision={revision + refresh}
            busy={busy}
            perform={perform}
            edit={(action, t) => {
              setError("");
              setEditing({
                action,
                template: definition(t),
                version: t.version,
              });
            }}
          />
        )
      )}
    </section>
  );
}

function TemplatePanel({
  client,
  projectId,
  id,
  revision,
  busy,
  perform,
  edit,
}: {
  client: CardiganClient;
  projectId: string;
  id: string;
  revision: number;
  busy: boolean;
  perform: (change: TemplateChange) => Promise<void>;
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
  if (!resource.data)
    return (
      <p role={resource.error ? "alert" : "status"}>
        {resource.error ?? "正在加载模板详情…"}
        {resource.error && (
          <button type="button" onClick={resource.reload}>
            重试
          </button>
        )}
      </p>
    );
  const { template, previous, versions } = resource.data;
  const shown = versions.find((t) => t.version === version) ?? template;
  const before =
    versions.find((t) => t.version === shown.version - 1) ??
    (shown.version === template.version ? previous : null);
  return (
    <div className="template-detail">
      <h3>
        {template.title} · {template.id}
      </h3>
      {resource.error && (
        <p role="alert">
          {resource.error}{" "}
          <button type="button" onClick={resource.reload}>
            重试
          </button>
        </p>
      )}
      <div className="template-toolbar">
        {template.builtin ? (
          <>
            <span>内置，只读</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => edit("copy", template)}
            >
              复制为项目模板
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => edit("update", template)}
            >
              编辑模板
            </button>
            <button
              type="button"
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
            </button>
          </>
        )}
      </div>
      <label>
        查看版本
        <select
          value={shown.version}
          onChange={(e) => setVersion(Number(e.target.value))}
        >
          {versions.map((t) => (
            <option key={t.version} value={t.version}>
              v{t.version} · {t.summary}
            </option>
          ))}
        </select>
      </label>
      <p>
        生成时间：
        {shown.created_at ? (
          <Time value={shown.created_at} />
        ) : (
          "未知（历史数据未记录）"
        )}
      </p>
      <TemplateContent detail={{ template: shown, previous: before }} />
      {!template.builtin && shown.version !== template.version && (
        <button
          type="button"
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
        </button>
      )}
    </div>
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
      <p>{t.description || "暂无描述"}</p>
      <dl className="template-fields">
        <dt>仓库要求</dt>
        <dd>{current.仓库要求}</dd>
        <dt>合并方式</dt>
        <dd>{current.合并方式}</dd>
        <dt>要求验收标准</dt>
        <dd>{current.要求验收标准}</dd>
        <dt>主产出 key</dt>
        <dd>{current["主产出 key"]}</dd>
        <dt>完成方式</dt>
        <dd>{current.完成方式}</dd>
      </dl>
      <h4>工作项</h4>
      {!t.work_items.length && <p>无默认工作项</p>}
      <ul>
        {t.work_items.map((w) => (
          <li key={w.key}>
            <strong>{w.title}</strong>（{w.key}） ·{" "}
            {w.kind === "produce" ? "产出" : "验证"} · 角色：{w.role_id} ·{" "}
            {w.required ? "必需" : "可选"} · 验证目标：
            {w.target_work_item_key ?? "无"}
          </li>
        ))}
      </ul>
      <h4>与上一版本的差异</h4>
      {!previous ? (
        <p>首个版本，无上一版本。</p>
      ) : !changed.length ? (
        <p>内容无变化。</p>
      ) : (
        <dl className="template-diff">
          {changed.map((key) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>
                <span>之前</span>
                <pre>{previous[key]}</pre>
                <span>现在</span>
                <pre>{current[key]}</pre>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {detail.previous && detail.previous.status !== t.status && (
        <p>
          状态：{detail.previous.status === "active" ? "启用" : "停用"} →{" "}
          {t.status === "active" ? "启用" : "停用"}
        </p>
      )}
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
    result: TemplateValidation;
  }>();
  const [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly invalidates the same validation request.
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      client
        .validateTemplate(projectId, JSON.parse(request) as TemplateChange)
        .then(
          (result) => {
            if (active) setValidation({ request, result });
          },
          (cause) => {
            if (active)
              setValidation({
                request,
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
    validation?.request === request ? validation.result : undefined;
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
      className="template-form"
      aria-label={action === "copy" ? "复制模板" : "模板表单"}
      onSubmit={(event) => {
        event.preventDefault();
        if (checked?.valid && !busy) void perform(change);
      }}
    >
      <h3>
        {action === "copy"
          ? "复制为项目模板"
          : action === "add"
            ? "新建模板"
            : "编辑模板"}
      </h3>
      <fieldset disabled={busy}>
        <label>
          模板编号
          <input
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
              <input
                required
                value={draft.title}
                onChange={(e) => patch({ title: e.target.value })}
              />
            </label>
            <label>
              模板描述
              <textarea
                rows={2}
                value={draft.description}
                onChange={(e) => patch({ description: e.target.value })}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={draft.requires_repo}
                onChange={(e) => patch({ requires_repo: e.target.checked })}
              />
              需要仓库
            </label>
            <label>
              合并方式
              <select
                value={draft.merge}
                onChange={(e) =>
                  patch({
                    merge: e.target.value as TemplateDefinition["merge"],
                  })
                }
              >
                {Object.entries(mergeLabels).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={draft.require_acceptance_criteria}
                onChange={(e) =>
                  patch({ require_acceptance_criteria: e.target.checked })
                }
              />
              要求验收标准
            </label>
            <fieldset>
              <legend>工作项</legend>
              {draft.work_items.map((w, index) => (
                <fieldset key={rowKeys[index]} className="template-work-item">
                  <legend>工作项 {index + 1}</legend>
                  <label>
                    工作项 key
                    <input
                      required
                      value={w.key}
                      onChange={(e) => item(index, { key: e.target.value })}
                    />
                  </label>
                  <label>
                    工作项标题
                    <input
                      required
                      value={w.title}
                      onChange={(e) => item(index, { title: e.target.value })}
                    />
                  </label>
                  <label>
                    工作项类型
                    <select
                      value={w.kind}
                      onChange={(e) => {
                        const { target_work_item_key: _target, ...rest } = w;
                        patch({
                          work_items: draft.work_items.map((old, i) =>
                            i === index
                              ? {
                                  ...rest,
                                  kind: e.target.value as "produce" | "verify",
                                }
                              : old,
                          ),
                        });
                      }}
                    >
                      <option value="produce">产出</option>
                      <option value="verify">验证</option>
                    </select>
                  </label>
                  <label>
                    角色编号
                    <input
                      required
                      value={w.role_id}
                      onChange={(e) => item(index, { role_id: e.target.value })}
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={w.required}
                      onChange={(e) =>
                        item(index, { required: e.target.checked })
                      }
                    />
                    必需工作项
                  </label>
                  {w.kind === "verify" && (
                    <label>
                      验证目标
                      <select
                        value={w.target_work_item_key ?? ""}
                        onChange={(e) => {
                          const { target_work_item_key: _target, ...rest } = w;
                          patch({
                            work_items: draft.work_items.map((old, i) =>
                              i === index
                                ? {
                                    ...rest,
                                    ...(e.target.value
                                      ? { target_work_item_key: e.target.value }
                                      : {}),
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
                      </select>
                    </label>
                  )}
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => {
                      setRowKeys((keys) => keys.filter((_, i) => i !== index));
                      patch({
                        work_items: draft.work_items.filter(
                          (_, i) => i !== index,
                        ),
                      });
                    }}
                  >
                    删除工作项 {index + 1}
                  </button>
                </fieldset>
              ))}
              <button
                type="button"
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
              </button>
            </fieldset>
            <label>
              主产出 key
              <select
                value={draft.primary_work_item_key ?? ""}
                onChange={(e) =>
                  patch({ primary_work_item_key: e.target.value || null })
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
              </select>
            </label>
            <label>
              完成方式
              <select
                value={draft.completion.mode}
                onChange={(e) =>
                  patch({
                    completion:
                      e.target.value === "review"
                        ? { mode: "review", reviewer: "human" }
                        : { mode: "human_mark_done" },
                  })
                }
              >
                <option value="human_mark_done">人标记完成</option>
                <option value="review">审核完成</option>
              </select>
            </label>
            {draft.completion.mode === "review" && (
              <label>
                完成审核者
                <input
                  value={draft.completion.reviewer}
                  placeholder="human 或 role:pm"
                  onChange={(e) =>
                    patch({
                      completion: { mode: "review", reviewer: e.target.value },
                    })
                  }
                />
              </label>
            )}
          </>
        )}
        <p className="hint">角色须在本项目登记且启用；保存时将再次校验。</p>
        {!checked ? (
          <p role="status">正在校验…</p>
        ) : checked.reason ? (
          <p role="alert">
            {checked.reason}{" "}
            <button type="button" onClick={() => setRetry((v) => v + 1)}>
              重新校验
            </button>
          </p>
        ) : (
          <p role="status">校验通过</p>
        )}
        <div className="template-toolbar">
          <button type="submit" disabled={!checked?.valid}>
            {busy ? "正在保存…" : action === "copy" ? "确认复制" : "保存模板"}
          </button>
          <button type="button" className="quiet" onClick={dismiss}>
            放弃修改
          </button>
        </div>
      </fieldset>
    </form>
  );
}
