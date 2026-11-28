import {
  type Assignment,
  type CommandState,
  type PromptObservation,
  type Run,
  type Runtime,
  runAwaitingUpstreamResume,
  type UpstreamApiError,
  type UpstreamOutagePolicy,
  upstreamOutageJoinAllowed,
  upstreamOutageOfRun,
} from "@cardigan/domain";

export type UpstreamErrorNextStep =
  /** The Run waits for its outage's resume message. */
  | "upstream_resume_pending"
  /** A resume message was sent within the resume window. */
  | "upstream_resume_sent"
  /** The screen shows the error; the next silence review records it. */
  | "upstream_resume_due"
  /** The screen shows the error and the Run used up its resumes. */
  | "upstream_resume_exhausted";

const kind = (error: UpstreamApiError | undefined) =>
  error === "disconnect" ? "连接中断" : "模型服务报错";
const clock = (at: string) => `${at.slice(11, 16)}Z`;
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/**
 * C-842: a host-ops restart or stop of a session whose Run is still running
 * while its CLI sits at an empty editor under a model API error (an outage
 * or a dropped connection) is refused by the ordinary guards. Name the next
 * step instead: the system resumes the session itself after confirming the
 * model service answers, or, once it used up its resumes, who takes over.
 * The screen is only matched, never read back.
 */
export async function upstreamErrorNextStep(
  state: CommandState,
  a: Assignment,
  runtime: Pick<Runtime, "observe_prompt">,
  now: string,
  policy: UpstreamOutagePolicy,
): Promise<{ step: UpstreamErrorNextStep; text: string } | undefined> {
  const run = state.runs.findLast(
    (r) => r.assignment_id === a.id && r.status === "running",
  );
  if (!run) return;
  const outage = upstreamOutageOfRun(state, run.id);
  const session = outage?.sessions.findLast((s) => s.run_id === run.id);
  if (outage && runAwaitingUpstreamResume(state, run.id, now, policy))
    return {
      step: "upstream_resume_pending",
      text: `${run.id} 仍在进行，会话停在${kind(session?.error)}后的空输入框上，系统已登记：确认模型服务 ${outage.provider} 可用后自动给它发一次接续消息，接上原来的上下文，不必重启或停止；结果记在卡片时间线。`,
    };
  const resume = session?.resume;
  if (
    resume &&
    (resume.result === "sent" || resume.result === "unconfirmed") &&
    Date.parse(now) - Date.parse(resume.at) < policy.resume_window_ms
  )
    return {
      step: "upstream_resume_sent",
      text: `系统已在 ${clock(resume.at)} 给 ${run.id} 的会话发了接续消息，正在等它恢复；${minutes(policy.resume_window_ms)} 分钟内仍没有进展时按会话失活流程提醒主机运维，届时再处理。`,
    };
  const shown = await shownError(state, a, run, runtime);
  if (!shown) return;
  if (
    upstreamOutageJoinAllowed(
      state,
      run.id,
      shown,
      policy.disconnect_resume_limit,
    )
  )
    return {
      step: "upstream_resume_due",
      text: `${run.id} 仍在进行，会话停在${kind(shown)}后的空输入框上：静默满失活告警阈值后，系统确认模型服务可用，会自动给它发一次接续消息，接上原来的上下文，不必重启或停止。`,
    };
  return {
    step: "upstream_resume_exhausted",
    text: `${run.id} 的会话又停在${kind(shown)}后的空输入框上，本轮的自动接续已经用完（连接中断每轮最多 ${policy.disconnect_resume_limit} 次，服务报错每轮 1 次）。下一步：用 request_human_action 请操作员在控制端给该会话发一句接续消息（保留上下文）；仍不恢复时再由人停止该指派。`,
  };
}

async function shownError(
  state: CommandState,
  a: Assignment,
  run: Run,
  runtime: Pick<Runtime, "observe_prompt">,
): Promise<UpstreamApiError | undefined> {
  const ref = a.runtime_ref;
  if (
    !ref ||
    !runtime.observe_prompt ||
    (run.harness !== "claude-code" && run.harness !== "codex")
  )
    return;
  const observe = async (error: UpstreamApiError) => {
    const binding: PromptObservation = {
      project_id: state.project_id,
      assignment_id: a.id,
      harness: run.harness as PromptObservation["harness"],
      require_upstream_error: error === "disconnect" ? "disconnect" : true,
    };
    const seen = await runtime
      .observe_prompt?.(ref, binding)
      .catch(() => undefined);
    return !!(seen?.ok && seen.value);
  };
  if (await observe("outage")) return "outage";
  if (await observe("disconnect")) return "disconnect";
}
