import type { PromptObservation, Runtime } from "@cardigan/domain";
import { expect, test, vi } from "vitest";
import { setup } from "../test-support/dispatch-stalls.js";

// C-842 (sensen SEN-C-234, A-662): the turn ended with `API Error:
// Connection lost mid-response`, the CLI sat at its empty editor and the Run
// stayed running. Host ops' restart and stop were refused without a next
// step, so PM Ops opened a human item for an operator stop that would have
// lost the session's context. A refusal now says what happens next.

function stopped(screen: "disconnect" | "outage" | "clear" = "disconnect") {
  const f = setup("local");
  f.ownTerminals();
  const a = f.target.assignment;
  const run = f.session(a, false);
  f.store.uow.run((tx) =>
    tx.runs.put(f.project, {
      ...tx.runs.get(f.project, run.id)!,
      harness: "claude-code",
    }),
  );
  f.runtime.observe_prompt = vi.fn<NonNullable<Runtime["observe_prompt"]>>(
    async (_ref, binding: PromptObservation) => ({
      ok: true as const,
      value:
        screen !== "clear" &&
        binding.require_upstream_error ===
          (screen === "disconnect" ? "disconnect" : true),
    }),
  );
  const stop = (key: string) =>
    f.service.tools.execute(f.context, "host_ops_stop_assignment", {
      target_id: a.id,
      reason: "fixture",
      idempotency_key: key,
    });
  const append = (type: string, payload: Record<string, unknown>) =>
    f.store.uow.run((tx) => {
      const e = {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(f.project),
        type,
        actor: { kind: "system" as const, project_id: f.project },
        payload,
        created_at: f.clock.now(),
      };
      tx.events.append(f.project, e);
      return e;
    });
  return { ...f, a, run, stop, append };
}

test("C-842: stopping a running session at a dropped-connection empty editor is refused with the automatic resume as the next step", async () => {
  const f = stopped("disconnect");
  const error = await f.stop("stop-1").catch((e: unknown) => e);
  expect(error).toMatchObject({
    code: "illegal_transition",
    details: { reason: "run_busy", next_step: "upstream_resume_due" },
  });
  const message = (error as Error).message;
  expect(message).toMatch(/^会话未停止：/u);
  expect(message).toContain(
    `${f.run.id} 仍在进行，会话停在连接中断后的空输入框上`,
  );
  expect(message).toContain("自动给它发一次接续消息");
  expect(f.runtime.release).not.toHaveBeenCalled();
});

test("C-842: a session already waiting for its resume, or just resumed, says so", async () => {
  const f = stopped("disconnect");
  const started = f.append("upstream_outage_started", {
    provider: "relay",
    cause: "disconnect",
  });
  f.append("upstream_outage_session_added", {
    outage_id: started.id,
    provider: "relay",
    assignment_id: f.a.id,
    run_id: f.run.id,
    error: "disconnect",
  });
  const waiting = await f.stop("stop-2").catch((e: unknown) => e);
  expect(waiting).toMatchObject({
    details: { next_step: "upstream_resume_pending" },
  });
  expect((waiting as Error).message).toContain(
    "确认模型服务 relay 可用后自动给它发一次接续消息",
  );
  f.append("upstream_outage_resolved", {
    outage_id: started.id,
    provider: "relay",
  });
  f.append("upstream_outage_resume", {
    outage_id: started.id,
    run_id: f.run.id,
    result: "sent",
  });
  const sent = await f.stop("stop-3").catch((e: unknown) => e);
  expect(sent).toMatchObject({
    details: { next_step: "upstream_resume_sent" },
  });
  expect((sent as Error).message).toMatch(
    /系统已在 \d\d:\d\dZ 给 R-\d+ 的会话发了接续消息/u,
  );
});

test("C-842: once the Run used up its resumes the refusal names the operator follow-up", async () => {
  const f = stopped("outage");
  const started = f.append("upstream_outage_started", { provider: "relay" });
  f.append("upstream_outage_session_added", {
    outage_id: started.id,
    provider: "relay",
    assignment_id: f.a.id,
    run_id: f.run.id,
  });
  f.append("upstream_outage_resolved", {
    outage_id: started.id,
    provider: "relay",
  });
  f.append("upstream_outage_resume", {
    outage_id: started.id,
    run_id: f.run.id,
    result: "sent",
  });
  f.advance(11 * 60_000);
  const error = await f.stop("stop-4").catch((e: unknown) => e);
  expect(error).toMatchObject({
    details: { next_step: "upstream_resume_exhausted" },
  });
  expect((error as Error).message).toContain(
    "请操作员在控制端给该会话发一句接续消息",
  );
});

test("C-842: a refusal of a session not stopped on a model API error is unchanged", async () => {
  const f = stopped("clear");
  const error = await f.stop("stop-5").catch((e: unknown) => e);
  expect(error).toMatchObject({
    code: "illegal_transition",
    details: { reason: "run_busy" },
  });
  expect((error as { details: object }).details).not.toHaveProperty(
    "next_step",
  );
  expect((error as Error).message).not.toContain("接续");
});
