import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CardiganClient,
  describeWriteError,
  type MergeConfirmationReview,
  type NeedsAction,
  type NeedsDecision,
  type NeedsPage,
  type NoticeView,
} from "../api.js";
import { EmployeeIdentity } from "../components/EmployeeIdentity.js";
import {
  EmptyState,
  IdTag,
  PageTitle,
  StatusTag,
  Time,
} from "../components/Foundation.js";
import { MergeCheck } from "../components/MergeCheck.js";
import {
  CardLink,
  CopyCommand,
  cliCommand,
  Feedback,
  Markdown,
} from "../components/Operations.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { decisionTitle, delegableCategories } from "../decision-labels.js";
import { routeHash } from "../route.js";
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
const isMergeConfirmation = (q: NeedsDecision) =>
  q.trigger === "merge_confirmation";
const isPausedReview = (q: NeedsDecision) =>
  q.trigger === "review_limit" && q.status === "provisional";
const reviewOptionLabels: Record<string, string> = {
  pause: "暂停",
  raise_limit: "增加轮数",
};
type Props = { client: CardiganClient; projectId: string; revision?: number };
function useAction(done: () => void) {
  const keys = useRef(new Map<string, string>());
  const sending = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>(),
    [message, setMessage] = useState("");
  return {
    busy,
    error,
    message,
    run: async (
      input: readonly unknown[],
      action: (key: string) => Promise<void>,
    ) => {
      if (sending.current) return;
      sending.current = true;
      const request = JSON.stringify(input);
      const key = keys.current.get(request) ?? crypto.randomUUID();
      keys.current.set(request, key);
      setBusy(true);
      setError(undefined);
      setMessage("");
      try {
        await action(key);
        keys.current.delete(request);
        setMessage("已提交");
        done();
      } catch (e) {
        setError(describeWriteError(e));
      } finally {
        sending.current = false;
        setBusy(false);
      }
    },
  };
}
function DecisionMeta({
  q,
  projectId,
  elapsed,
}: {
  readonly q: NeedsDecision;
  readonly projectId: string;
  readonly elapsed: number;
}) {
  return (
    <header className="needs-meta">
      <EmployeeIdentity {...q} showTitle={false} />
      <IdTag id={q.id} label={isMergeConfirmation(q) ? "合并确认" : "拍板"} />
      {q.blocking && !q.followup_notice && <StatusTag status="blocked" />}
      {isPausedReview(q) && (
        <StatusTag status="suspended" label="已暂停（临时决定）" />
      )}
      <span className="hint">{waitLabel(q.waited_ms, elapsed)}</span>
      {q.auto_merge && (
        <span className="hint">
          将于{" "}
          {new Date(q.auto_merge.due_at).toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })}{" "}
          自动合并（偏好设置：{q.auto_merge.minutes} 分钟）
          {q.waited_ms !== null &&
            ` · 剩余 ${Math.max(0, Math.ceil((q.auto_merge.minutes * 60_000 - q.waited_ms - elapsed) / 60_000))} 分钟`}
        </span>
      )}
      <span className="needs-cards">
        {q.related_cards.length === 0 ? (
          <span>项目级事项</span>
        ) : (
          q.related_cards.map((card) => (
            <CardLink
              key={card.id}
              projectId={projectId}
              id={card.id}
              label={card.title}
            />
          ))
        )}
      </span>
    </header>
  );
}
function Decision({
  q,
  client,
  projectId,
  done,
  elapsed,
}: Props & { q: NeedsDecision; done: () => void; elapsed: number }) {
  const [option, setOption] = useState(""),
    [quote, setQuote] = useState("");
  const action = useAction(done);
  const [delegateFuture, setDelegateFuture] = useState(false);
  const canDelegate =
    q.trigger !== "merge_confirmation" &&
    delegableCategories.includes(q.category);
  const paused = isPausedReview(q);
  const selected = paused ? "raise_limit" : option;
  const options = paused
    ? q.options.filter((o) => o.key === "raise_limit")
    : q.options;
  if (q.followup_notice)
    return (
      <article className="needs-item" aria-label={`拍板落实 ${q.id}`}>
        <DecisionMeta q={q} projectId={projectId} elapsed={elapsed} />
        <h3 className="needs-question">{q.question}</h3>
        <p>{q.followup_notice}</p>
        <p>
          已选方案：
          {q.options.find((o) => o.key === q.resolution?.option)?.description ??
            q.resolution?.option}
        </p>
        <p>
          影响：{q.options.find((o) => o.key === q.resolution?.option)?.impact}
        </p>
        <p>请安排落实，并在卡片时间线引用 {q.id} 记录执行结果。</p>
      </article>
    );
  return (
    <article
      className={`needs-item needs-decision${q.blocking ? " urgent" : ""}`}
      aria-label={`拍板 ${q.id}`}
    >
      <DecisionMeta q={q} projectId={projectId} elapsed={elapsed} />
      <h3 className="needs-question">{q.question}</h3>
      {q.context.trim().length > 0 && (
        <details className="needs-context">
          <summary>背景</summary>
          <Markdown body={q.context} />
        </details>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (selected === "") return;
          void action.run(
            [projectId, q.id, "resolve", selected, quote, delegateFuture],
            (key) =>
              delegateFuture
                ? client.recordDecision(
                    projectId,
                    q.id,
                    selected,
                    quote,
                    key,
                    true,
                  )
                : client.recordDecision(projectId, q.id, selected, quote, key),
          );
        }}
      >
        <fieldset className="needs-options">
          <legend>选择方案</legend>
          {options.map((o) => (
            <label
              key={o.key}
              className={`needs-option${selected === o.key ? " selected" : ""}`}
            >
              <input
                type="radio"
                name={`decision-${q.id}`}
                value={o.key}
                checked={selected === o.key}
                onChange={() => setOption(o.key)}
              />
              <span>
                <span className="needs-option-head">
                  <strong>
                    {q.trigger === "review_limit"
                      ? (reviewOptionLabels[o.key] ?? o.key)
                      : o.key}
                  </strong>
                  <span>
                    {q.trigger === "review_limit" && o.key === "raise_limit"
                      ? "增加一轮审核额度"
                      : o.description}
                  </span>
                  {q.recommended === o.key && (
                    <span className="needs-recommended">推荐</span>
                  )}
                </span>
                <span className="needs-option-impact">
                  影响：
                  {q.trigger === "review_limit" && o.key === "raise_limit"
                    ? "审核上限加 1；没有其他阻塞且额度可用时自动恢复审核。"
                    : o.impact}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        {canDelegate && (
          <label>
            <input
              type="checkbox"
              checked={delegateFuture}
              disabled={action.busy}
              onChange={(e) => setDelegateFuture(e.target.checked)}
            />
            此类问题以后由 PM 代拍
          </label>
        )}
        <label>
          补充说明（可选，会作为你的原话记录）
          <textarea
            aria-label={`${q.id} 原话或补充说明`}
            value={quote}
            onChange={(e) => setQuote(e.target.value)}
          />
        </label>
        <div className="action-row">
          <button type="submit" disabled={action.busy || selected === ""}>
            {paused ? "增加一轮审核额度" : "按所选拍板"}
          </button>
          {!paused &&
            (["request_information", "explain"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                className="quiet"
                disabled={action.busy || !q.card_id}
                onClick={() =>
                  void action.run(
                    [projectId, q.id, "comments", kind, quote],
                    (key) =>
                      client.decisionComment(projectId, q.id, kind, quote, key),
                  )
                }
              >
                {kind === "request_information" ? "要求补充信息" : "请 PM 解释"}
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
      <RequestFeedback
        interactive
        pending={action.busy}
        pendingMessage="提交中…"
        error={action.error}
        message={action.message}
      />
    </article>
  );
}
function ReviewLine({ review }: { readonly review: MergeConfirmationReview }) {
  const label =
    [review.work_item_title, review.role_id].filter(Boolean).join(" ") ||
    "验证";
  return (
    <li>
      <div className="needs-review-head">
        <EmployeeIdentity {...review} showTitle={false} />
        <IdTag id={review.work_item_id} label={label} />
        <StatusTag status={review.verdict} />
      </div>
      {review.issues.length > 0 && (
        <details className="needs-review-issues">
          <summary>问题（{review.issues.length}）</summary>
          <ul>
            {review.issues.map((issue) => (
              <li key={`${review.id}-${issue.severity}-${issue.description}`}>
                <strong>
                  {issue.must_fix ? "必须修" : "非阻塞"} · {issue.severity}
                </strong>
                <span>{issue.description}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}
function MergeConfirmation({
  q,
  client,
  projectId,
  done,
  elapsed,
}: Props & { q: NeedsDecision; done: () => void; elapsed: number }) {
  const [quote, setQuote] = useState("");
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState("");
  const action = useAction(done);
  const merge = q.merge_confirmation;
  const check = merge?.merge_check;
  const confirmed = q.status === "resolved";
  const cardId = q.card_id ?? q.related_cards[0]?.id ?? null;
  const decide = (option: "merge" | "hold") =>
    action.run([projectId, q.id, "resolve", option, quote], (key) =>
      client.recordDecision(projectId, q.id, option, quote, key),
    );
  return (
    <article className="needs-item needs-merge" aria-label={`合并确认 ${q.id}`}>
      <DecisionMeta q={q} projectId={projectId} elapsed={elapsed} />
      <h3 className="needs-question">{decisionTitle(q)}</h3>
      {merge?.merge_gate_invalid && (
        <p className="error">合并闸门配置无效，请查看 server 启动日志</p>
      )}
      {merge?.merge_gate_enabled && (
        <MergeCheck check={check ?? null} projectId={projectId} live />
      )}
      <section className="needs-merge-section" aria-label="要合并的交付">
        <h4>要合并的交付</h4>
        {!merge || merge.deliveries.length === 0 ? (
          <p className="hint">还没有可合并的交付。</p>
        ) : (
          <ul className="needs-delivery-list">
            {merge.deliveries.map((delivery) => (
              <li key={delivery.id}>
                <div className="needs-delivery-head">
                  <EmployeeIdentity {...delivery} showTitle={false} />
                  <IdTag
                    id={delivery.work_item_id}
                    label={delivery.work_item_title}
                  />
                  <code title={delivery.subject.value}>
                    {delivery.subject.value.slice(0, 12)}
                  </code>
                  {cardId && (
                    <a
                      href={routeHash({
                        kind: "card",
                        projectId,
                        cardId,
                        anchor: `delivery-${delivery.id}`,
                      })}
                    >
                      查看改动
                    </a>
                  )}
                </div>
                <p>{delivery.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="needs-merge-section" aria-label="审核与验收">
        <h4>审核与验收</h4>
        {!merge || merge.reviews.length === 0 ? (
          <p className="hint">还没有审核或验收结论。</p>
        ) : (
          <ul className="needs-review-list">
            {merge.reviews.map((review) => (
              <ReviewLine key={review.id} review={review} />
            ))}
          </ul>
        )}
      </section>
      <section className="needs-merge-section" aria-label="已知遗留">
        <h4>已知遗留</h4>
        {!merge || merge.known_gaps.length === 0 ? (
          <p className="hint">没有已知遗留。</p>
        ) : (
          <ul className="needs-gap-list">
            {merge.known_gaps.map((gap) => (
              <li
                key={`${gap.description}-${gap.followup_card_id ?? ""}-${gap.precondition ?? ""}`}
              >
                <span>{gap.description}</span>
                {gap.followup_card_id && (
                  <CardLink
                    projectId={projectId}
                    id={gap.followup_card_id}
                    label="后续卡"
                  />
                )}
                {gap.precondition && (
                  <span className="hint">前置条件：{gap.precondition}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!confirmed) void decide("merge");
        }}
      >
        {confirmed ? (
          <p className="hint">{q.why}</p>
        ) : (
          <label>
            补充说明（可选，会作为你的原话记录）
            <textarea
              aria-label={`${q.id} 原话或补充说明`}
              value={quote}
              onChange={(e) => setQuote(e.target.value)}
            />
          </label>
        )}
        <div className="action-row">
          {!confirmed && (
            <button type="submit" disabled={action.busy}>
              确认合并
            </button>
          )}
          {merge?.merge_gate_enabled && check?.status !== "passed" && (
            <span className="hint">检查通过后才会合并</span>
          )}
          {merge?.merge_gate_enabled &&
            check &&
            ["failed", "timed_out"].includes(check.status) &&
            cardId && (
              <button
                type="button"
                className="quiet"
                disabled={action.busy}
                onClick={() =>
                  void action.run(
                    [
                      projectId,
                      cardId,
                      "recheck",
                      check.completion_id,
                      check.attempt_id,
                    ],
                    (key) =>
                      client.recheckMerge(
                        projectId,
                        cardId,
                        check.completion_id,
                        key,
                      ),
                  )
                }
              >
                重新检查
              </button>
            )}
          {!confirmed && (
            <button
              type="button"
              className="quiet"
              disabled={action.busy}
              onClick={() => void decide("hold")}
            >
              暂不合并
            </button>
          )}
          <button
            type="button"
            className="quiet"
            disabled={action.busy}
            onClick={() => setReturning(true)}
          >
            退回修改
          </button>
        </div>
      </form>
      {returning && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!reason.trim()) return;
            void action.run(
              [projectId, q.id, "resolve", "request_changes", reason],
              (key) =>
                client.recordDecision(
                  projectId,
                  q.id,
                  "request_changes",
                  reason,
                  key,
                ),
            );
          }}
        >
          <label>
            退回原因（必填）
            <textarea
              aria-label={`${q.id} 退回原因`}
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="action-row">
            <button type="submit" disabled={action.busy || !reason.trim()}>
              确认退回修改
            </button>
            <button
              type="button"
              className="quiet"
              disabled={action.busy}
              onClick={() => setReturning(false)}
            >
              取消
            </button>
          </div>
        </form>
      )}
      <RequestFeedback
        interactive
        pending={action.busy}
        pendingMessage="提交中…"
        error={action.error}
        message={action.message}
      />
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
  if (item.completion_notice !== undefined)
    return (
      <article className="needs-item" aria-label={`执行结果待接手 ${item.id}`}>
        <header className="needs-meta">
          <IdTag id={item.id} label="执行结果" />
          <StatusTag status="completed" />
          {item.card_id && <CardLink projectId={projectId} id={item.card_id} />}
        </header>
        <h3 className="needs-question">{item.why}</h3>
        <Markdown body={item.completion_notice} />
        <p>请恢复发起方或启动项目的 PM Ops，继续处理这项执行结果。</p>
      </article>
    );
  return (
    <article className="needs-item" aria-label={`执行 ${item.id}`}>
      <header className="needs-meta">
        <EmployeeIdentity {...item} showTitle={false} />
        <IdTag id={item.id} label="操作" />
        <StatusTag
          status="todo"
          label={item.triage === "host" ? "待主机操作" : "待你执行"}
        />
        <span className="hint">{waitLabel(item.waited_ms, elapsed)}</span>
        <span className="needs-cards">
          {item.card_id ? (
            <CardLink projectId={projectId} id={item.card_id} />
          ) : (
            <span>项目级事项</span>
          )}
        </span>
        {item.due && (
          <span className="hint">
            截止：
            <Time value={item.due} />
          </span>
        )}
      </header>
      <h3 className="needs-question">
        {item.triage === "host" ? "主机操作：" : ""}
        {item.handoff?.title ?? item.triage_rationale ?? item.why}
      </h3>
      {item.handoff ? (
        <section aria-label="项目经理说明">
          <p className="hint">
            <StatusTag status="completed" label="项目经理已改写" /> ·{" "}
            <Time value={item.handoff.rewritten_at} />
          </p>
          <h4>这是什么</h4>
          <Markdown body={item.handoff.summary} />
          <h4>为什么需要你</h4>
          <Markdown body={item.handoff.why_human} />
          <h4>怎么做</h4>
          <Markdown body={item.instructions} />
          <h4>做完会怎样</h4>
          <Markdown body={item.handoff.expected_outcome} />
          <p>完成后请回传：{item.expected_return}</p>
        </section>
      ) : (
        <details>
          <summary>操作步骤与期望返回</summary>
          <Markdown body={item.instructions} />
          <p>期望返回：{item.expected_return}</p>
        </details>
      )}
      {item.original_request && (
        <details>
          <summary>查看改写前的内容</summary>
          <Markdown body={item.original_request.instructions} />
          <p>原请求原因：{item.original_request.why_human}</p>
          <p>原期望返回：{item.original_request.expected_return}</p>
        </details>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run([projectId, item.id, "complete", text], (key) =>
            client.completeAction(projectId, item.id, text, key),
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
      <RequestFeedback
        interactive
        pending={action.busy}
        pendingMessage="提交中…"
        error={action.error}
        message={action.message}
      />
    </article>
  );
}
function Incident({
  incident,
  projectId,
  elapsed,
}: {
  readonly incident: NeedsPage["incidents"][number];
  readonly projectId: string;
  readonly elapsed: number;
}) {
  return (
    <article
      className="needs-item urgent"
      aria-label={`运行异常 ${incident.id}`}
    >
      <header className="needs-meta">
        <EmployeeIdentity
          {...incident}
          author_role={incident.role_id}
          showTitle={false}
        />
        <IdTag id={incident.id} label={incident.role_id} />
        <StatusTag status={incident.runtime_state} />
        <span className="hint">{waitLabel(incident.waited_ms, elapsed)}</span>
        <span className="needs-cards">
          <CardLink projectId={projectId} id={incident.card_id} />
        </span>
      </header>
      {incident.disconnected_at && (
        <p>
          失联时间：
          <Time value={incident.disconnected_at} />
        </p>
      )}
      {incident.last_run && (
        <p>
          最近 Run：
          <IdTag id={incident.last_run.id} label="执行" />{" "}
          {incident.last_run.summary}
        </p>
      )}
      <CopyCommand
        label="查看终端"
        command={cliCommand(projectId, "assignment attach", incident.id)}
      />
      <CopyCommand
        label="检查异常"
        command={cliCommand(projectId, "attention")}
      />
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
  const { data, pending, error, reload, interactive } = resource;
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    if (!data) return;
    const sampled = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - sampled), 60000);
    return () => clearInterval(timer);
  }, [data]);
  const props = { client, projectId, done: reload, elapsed };
  const total = data
    ? data.decisions.length +
      data.human_actions.length +
      data.incidents.length +
      (data.attention?.length ?? 0)
    : 0;
  const blocking = (data?.decisions ?? []).filter(
    (q) => q.blocking && !q.followup_notice && !isMergeConfirmation(q),
  );
  const followups = (data?.decisions ?? []).filter((q) => q.followup_notice);
  const merges = (data?.decisions ?? []).filter(
    (q) => !q.followup_notice && isMergeConfirmation(q),
  );
  const other = (data?.decisions ?? []).filter(
    (q) => !q.blocking && !q.followup_notice && !isMergeConfirmation(q),
  );
  return (
    <section aria-label="Needs You" className="needs-page">
      <PageTitle
        title="Needs You"
        description={
          total > 0
            ? `${total} 件事等你处理。`
            : "在这里拍板、确认合并和回报执行结果。"
        }
      />
      <Feedback
        pending={pending}
        interactive={interactive}
        error={error}
        retry={reload}
      />
      {data && (
        <>
          {total === 0 && (
            <EmptyState>
              没有需要你处理的事。Agent 提出拍板或需要你确认合并时会出现在这里。
            </EmptyState>
          )}
          {!!data.incidents.length && (
            <section className="needs-group" aria-label="运行异常">
              <h2>运行异常（{data.incidents.length}）</h2>
              {data.incidents.map((incident) => (
                <Incident
                  key={incident.id}
                  incident={incident}
                  projectId={projectId}
                  elapsed={elapsed}
                />
              ))}
            </section>
          )}
          {!!data.attention?.length && (
            <section className="needs-group" aria-label="审核恢复异常">
              <h2>审核恢复异常（{data.attention.length}）</h2>
              {data.attention.map((finding) => (
                <article
                  className="needs-item urgent"
                  key={`${finding.decision_id}/${finding.work_item_id}`}
                >
                  <header className="needs-meta">
                    <IdTag id={finding.work_item_id} label="审核工作项" />
                    <span className="hint">
                      {waitLabel(finding.waited_ms, elapsed)}
                    </span>
                    <CardLink projectId={projectId} id={finding.card_id} />
                  </header>
                  <p>{finding.detail}</p>
                </article>
              ))}
            </section>
          )}
          {!!blocking.length && (
            <section className="needs-group" aria-label="阻塞拍板">
              <h2>阻塞拍板（{blocking.length}）</h2>
              {blocking.map((q) => (
                <Decision key={q.id} q={q} {...props} />
              ))}
            </section>
          )}
          {!!merges.length && (
            <section className="needs-group" aria-label="合并确认">
              <h2>合并确认（{merges.length}）</h2>
              {merges.map((q) => (
                <MergeConfirmation key={q.id} q={q} {...props} />
              ))}
            </section>
          )}
          {!!other.length && (
            <section className="needs-group" aria-label="其他拍板">
              <h2>其他拍板（{other.length}）</h2>
              {other.map((q) => (
                <Decision key={q.id} q={q} {...props} />
              ))}
            </section>
          )}
          {!!followups.length && (
            <section className="needs-group" aria-label="拍板落实">
              <h2>拍板落实（{followups.length}）</h2>
              {followups.map((q) => (
                <Decision key={q.id} q={q} {...props} />
              ))}
            </section>
          )}
          {!!data.human_actions.length && (
            <section className="needs-group" aria-label="待你执行">
              <h2>待你执行（{data.human_actions.length}）</h2>
              {data.human_actions.map((item) => (
                <HumanAction key={item.id} item={item} {...props} />
              ))}
            </section>
          )}
          {!!data.notices?.length && (
            <Notices notices={data.notices} {...props} />
          )}
        </>
      )}
    </section>
  );
}

/** §7.4 知会: delegated merges and decisions; informational, never blocking. */
function Notices({
  notices,
  client,
  projectId,
  done,
}: {
  notices: readonly NoticeView[];
  client: CardiganClient;
  projectId: string;
  done: () => void;
}) {
  const unread = notices.filter((n) => !n.read);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const mark = async (ids: readonly string[]) => {
    if (busy || !ids.length) return;
    setBusy(true);
    setError("");
    try {
      await client.markNoticesRead(projectId, ids);
      done();
    } catch (cause) {
      setError(describeWriteError(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="needs-group" aria-label="知会">
      <h2>知会（未读 {unread.length}）</h2>
      <p className="hint">
        PM 代为确认的合并和代拍的决定，不需要你处理；有疑问可在卡片里追问。
      </p>
      {unread.length > 1 && (
        <button
          type="button"
          disabled={busy}
          onClick={() => mark(unread.map((n) => n.id))}
        >
          全部标为已读
        </button>
      )}
      <RequestFeedback
        interactive
        pending={busy}
        pendingMessage="正在标记已读…"
        error={error}
      />
      {notices.map((n) => (
        <article
          key={n.id}
          className={n.read ? "needs-item read" : "needs-item"}
          aria-label={`知会 ${n.decision_id}`}
        >
          <header className="needs-meta">
            <StatusTag
              status={n.read ? "done" : "active"}
              label={
                n.kind === "merge"
                  ? n.resolved_by === "system"
                    ? "超时自动合并"
                    : "PM 代确认合并"
                  : "PM 代拍"
              }
            />
            <IdTag id={n.decision_id} label="拍板" />
            {n.card_id && <CardLink projectId={projectId} id={n.card_id} />}
            <Time value={n.at} />
          </header>
          {n.question && <p className="hint">{n.question}</p>}
          <Markdown body={n.body} />
          <footer>
            <a
              href={routeHash({
                kind: "decision-history",
                projectId,
                ...(n.card_id ? { filters: { card_id: n.card_id } } : {}),
              })}
            >
              查看拍板记录
            </a>
            {!n.read && (
              <button
                type="button"
                disabled={busy}
                onClick={() => mark([n.id])}
              >
                标为已读
              </button>
            )}
          </footer>
        </article>
      ))}
    </section>
  );
}
