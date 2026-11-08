import { useCallback, useEffect, useState } from "react";
import {
  type CardiganClient,
  describeError,
  type NeedsAction,
  type NeedsDecision,
  type NeedsPage,
} from "../api.js";
import {
  EmptyState,
  IdTag,
  PageTitle,
  StatusTag,
  Time,
} from "../components/Foundation.js";
import {
  CardLink,
  CopyCommand,
  cliCommand,
  Feedback,
  Markdown,
} from "../components/Operations.js";
import { useResource } from "../useResource.js";

const waitLabel = (ms: number | null, elapsed = 0) => {
  const age = (ms ?? 0) + elapsed;
  return ms === null
    ? "等待时长未知"
    : age < 60000
      ? "刚刚发起"
      : age < 3600000
        ? `已等待 ${Math.floor(age / 60000)} 分钟`
        : `已等待 ${Math.floor(age / 3600000)} 小时`;
};
const urgent = (q: NeedsDecision) => q.blocking || q.category !== "general";
type Props = { client: CardiganClient; projectId: string; revision?: number };
function useAction(done: () => void) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>(),
    [message, setMessage] = useState("");
  return {
    busy,
    error,
    message,
    run: async (action: () => Promise<void>) => {
      if (busy) return;
      setBusy(true);
      setError(undefined);
      setMessage("");
      try {
        await action();
        setMessage("已提交");
        done();
      } catch (e) {
        setError(describeError(e));
      } finally {
        setBusy(false);
      }
    },
  };
}
function Decision({
  q,
  client,
  projectId,
  done,
  elapsed,
}: Props & { q: NeedsDecision; done: () => void; elapsed: number }) {
  const [option, setOption] = useState(q.recommended),
    [quote, setQuote] = useState("");
  const action = useAction(done);
  return (
    <article
      className={`needs-item ${urgent(q) ? "urgent" : ""}`}
      aria-label={`拍板 ${q.id}`}
    >
      <header>
        <strong>
          <IdTag id={q.id} label="拍板" detail={q.question} />{" "}
          {[...q.why].slice(0, 40).join("")}
        </strong>{" "}
        {q.blocking && <StatusTag status="blocked" />}
        {q.category !== "general" && <span>风险</span>}{" "}
        <StatusTag status={q.status} />
      </header>
      <p className="hint">
        <span>{waitLabel(q.waited_ms, elapsed)}</span>{" "}
        <CardLink projectId={projectId} id={q.card_id} />
      </p>
      <details>
        <summary>问题与选项</summary>
        <Markdown body={q.question} />
        {q.options.map((o) => (
          <div key={o.key}>
            <strong>
              {o.key}
              {q.recommended === o.key ? "（推荐）" : ""}
            </strong>
            <Markdown body={`${o.description}\n\n影响：${o.impact}`} />
          </div>
        ))}
      </details>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(() =>
            client.recordDecision(projectId, q.id, option, quote),
          );
        }}
      >
        <label>
          选择方案
          <select
            aria-label={`${q.id} 选择方案`}
            value={option}
            onChange={(e) => setOption(e.target.value)}
          >
            {q.options.map((o) => (
              <option value={o.key} key={o.key}>
                {o.key}：{o.description}
              </option>
            ))}
          </select>
        </label>
        <Markdown
          body={q.options.find((o) => o.key === option)?.impact ?? ""}
        />
        <label>
          原话或补充说明
          <textarea
            aria-label={`${q.id} 原话或补充说明`}
            value={quote}
            onChange={(e) => setQuote(e.target.value)}
          />
        </label>
        <div className="action-row">
          <button
            type="submit"
            disabled={action.busy || !q.options.some((o) => o.key === option)}
          >
            记录决定
          </button>
          {(["request_information", "explain"] as const).map((kind, i) => (
            <button
              key={kind}
              type="button"
              className="quiet"
              disabled={action.busy || !q.card_id}
              onClick={() =>
                void action.run(() =>
                  client.decisionComment(projectId, q.id, kind, quote),
                )
              }
            >
              {i ? "请 PM 解释后果" : "要求补充信息"}
            </button>
          ))}
        </div>
      </form>
      {!q.card_id && <p className="hint">项目级事项请在 PM 对话中补充说明。</p>}
      {q.trigger === "worktree_cleanup" && q.assignment_id && (
        <CopyCommand
          label="查看 Diff"
          command={cliCommand(projectId, "worktree diff", q.assignment_id)}
        />
      )}
      {action.error && (
        <p role="alert" className="error-panel">
          {action.error}
        </p>
      )}
      <span role="status">{action.busy ? "提交中…" : action.message}</span>
    </article>
  );
}
function HumanAction({
  item,
  client,
  projectId,
  done,
  elapsed,
}: Props & { item: NeedsAction; done: () => void; elapsed: number }) {
  const [text, setText] = useState("");
  const action = useAction(done);
  return (
    <article className="needs-item" aria-label={`执行 ${item.id}`}>
      <strong>
        <IdTag id={item.id} label="待你执行" />{" "}
        {[...item.why].slice(0, 40).join("")}
      </strong>{" "}
      <StatusTag status="todo" />
      <p className="hint">
        <span>{waitLabel(item.waited_ms, elapsed)}</span>{" "}
        <CardLink projectId={projectId} id={item.card_id} />
        {item.due && (
          <span>
            截止：
            <Time value={item.due} />
          </span>
        )}
      </p>
      <details>
        <summary>操作步骤与期望返回</summary>
        <Markdown body={item.instructions} />
        <p>期望返回：{item.expected_return}</p>
      </details>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(() =>
            client.completeAction(projectId, item.id, text),
          );
        }}
      >
        <label>
          执行结果
          <textarea
            aria-label={`${item.id} 执行结果`}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <button type="submit" disabled={action.busy || !text.trim()}>
          确认已完成
        </button>
      </form>
      {action.error && (
        <p role="alert" className="error-panel">
          {action.error}
        </p>
      )}
      <span role="status">{action.busy ? "提交中…" : action.message}</span>
    </article>
  );
}
type NeedsResource = ReturnType<typeof useResource<NeedsPage>>;
export function NeedsYouPage(props: Props & { resource?: NeedsResource }) {
  return props.resource ? (
    <NeedsContent {...props} resource={props.resource} />
  ) : (
    <NeedsLoader {...props} />
  );
}
function NeedsLoader({ client, projectId, revision = 0 }: Props) {
  const load = useCallback(
    () => client.needsYou(projectId),
    [client, projectId],
  );
  const resource = useResource(load, revision);
  return (
    <NeedsContent client={client} projectId={projectId} resource={resource} />
  );
}
function NeedsContent({
  client,
  projectId,
  resource,
}: Props & { resource: NeedsResource }) {
  const { data, pending, error, reload } = resource;
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    if (!data) return;
    const sampled = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - sampled), 60000);
    return () => clearInterval(timer);
  }, [data]);
  const props = { client, projectId, done: reload, elapsed };
  return (
    <section aria-label="Needs You">
      <PageTitle
        title="Needs You"
        description={
          data &&
          data.decisions.length +
            data.human_actions.length +
            data.incidents.length >
            0
            ? `${data.decisions.length + data.human_actions.length + data.incidents.length} 件事等你处理。`
            : "在这里拍板、确认合并和回报执行结果。"
        }
      />
      <Feedback pending={pending} error={error} retry={reload} />
      {data && (
        <>
          {!data.decisions.length &&
            !data.human_actions.length &&
            !data.incidents.length && (
              <EmptyState>
                没有需要你处理的事。Agent
                提出拍板或需要你确认合并时会出现在这里。
              </EmptyState>
            )}
          {!!data.incidents.length && (
            <section aria-label="运行环境异常">
              <h2>运行环境异常</h2>
              {data.incidents.map((a) => (
                <article key={a.id} className="needs-item urgent">
                  <strong>
                    <IdTag id={a.id} label={a.role_id} />
                  </strong>{" "}
                  <StatusTag status={a.runtime_state} />
                  <p>
                    {waitLabel(a.waited_ms, elapsed)}
                    <CardLink projectId={projectId} id={a.card_id} />
                  </p>
                  {a.disconnected_at && (
                    <p>
                      失联时间：
                      <Time value={a.disconnected_at} />
                    </p>
                  )}
                  {a.last_run && (
                    <p>
                      最近 Run：
                      <IdTag id={a.last_run.id} label="执行" />{" "}
                      {a.last_run.summary}
                    </p>
                  )}
                  <CopyCommand
                    label="查看终端"
                    command={cliCommand(projectId, "assignment attach", a.id)}
                  />
                  <CopyCommand
                    label="检查异常"
                    command={cliCommand(projectId, "attention")}
                  />
                </article>
              ))}
            </section>
          )}
          {!!data.decisions.filter(urgent).length && (
            <section aria-label="优先拍板">
              <h2>阻塞与风险</h2>
              {data.decisions.filter(urgent).map((q) => (
                <Decision key={q.id} q={q} {...props} />
              ))}
            </section>
          )}
          {!!data.decisions.filter((q) => !urgent(q)).length && (
            <details className="needs-batch">
              <summary>
                其他拍板（{data.decisions.filter((q) => !urgent(q)).length}）
              </summary>
              {data.decisions
                .filter((q) => !urgent(q))
                .map((q) => (
                  <Decision key={q.id} q={q} {...props} />
                ))}
            </details>
          )}
          {!!data.human_actions.length && (
            <section aria-label="待你执行">
              <h2>待你执行（{data.human_actions.length}）</h2>
              {data.human_actions.map((item) => (
                <HumanAction key={item.id} item={item} {...props} />
              ))}
            </section>
          )}
        </>
      )}
    </section>
  );
}
