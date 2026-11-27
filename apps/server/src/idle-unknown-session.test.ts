import { queueRun, type Run, type Runtime } from "@cardigan/domain";
import { DEFAULT_DONE_SESSION_RELEASE_MS } from "@cardigan/host";
import { expect, test, vi } from "vitest";
import { setup } from "../test-support/dispatch-stalls.js";
import { Dispatcher } from "./dispatch.js";

// C-838 (sensen SEN-C-182, A-639 on mac-mini, Claude Code): the previous turn
// ended and the session sat idle on the emulator slot, blocking its own queued
// Run twice in a day. hc takes activity only from OSC 7501, which Claude Code
// never emits, so the session read `unknown`; the C-759 patrol released only
// on `done`, host_ops_stop_assignment refused (agent_unknown), and a human had
// to run `assignment stop`. The bound empty editor is now the idle evidence.

function unknownIdle(harness: NonNullable<Run["harness"]> = "claude-code") {
  const f = setup("local");
  f.ownTerminals();
  const original = vi.mocked(f.runtime.status).getMockImplementation()!;
  // hc reports no activity at all for this CLI.
  vi.mocked(f.runtime.status).mockImplementation(async (ref) => {
    const seen = await original(ref);
    return seen.ok &&
      seen.value.process === "alive" &&
      !f.working.has(ref.terminal_ref)
      ? { ok: true, value: { ...seen.value, agent: "unknown" } }
      : seen;
  });
  // As the adapter: without a system-ended turn, a live terminal of this
  // identity is alive whatever its activity.
  const strict = f.runtime.observe_retirement!;
  f.runtime.observe_retirement = vi.fn(async (ref, identity) => {
    if (identity.system_finished_turn) return strict(ref, identity);
    const seen = await f.runtime.status(ref);
    return {
      ok: true as const,
      value:
        seen.ok && seen.value.process === "alive"
          ? ("alive" as const)
          : ("exited" as const),
    };
  });
  let editor = true;
  const observe_prompt = vi.fn<NonNullable<Runtime["observe_prompt"]>>(
    async () => ({ ok: true, value: editor }),
  );
  f.runtime.observe_prompt = observe_prompt;
  const queue = () =>
    f.apply((s, a, p) =>
      queueRun(
        s,
        a,
        {
          assignment_id: f.target.assignment.id,
          model: "fixture",
          agent_cli_version: "fixture",
        },
        p,
      ),
    ) as Run;
  // The ended turn the session ran.
  const ended = queue();
  f.store.uow.run((tx) => {
    const at = f.clock.now();
    tx.runs.put(f.project, {
      ...ended,
      status: "completed",
      outcome: "completed",
      summary: "fixture",
      harness,
      started_at: at,
      finished_at: at,
    } as Run);
  });
  const queued = queue();
  const events = (type: string) =>
    f.state().events.filter((e) => e.type === type);
  const owner = () =>
    f.state().assignments.find((a) => a.id === f.target.assignment.id)!;
  const pass = async () => {
    await f.service.tick();
    await new Promise((resolve) => setTimeout(resolve, 100));
  };
  return {
    ...f,
    queued,
    events,
    owner,
    pass,
    observe_prompt,
    set editor(value: boolean) {
      editor = value;
    },
  };
}

test("C-838: an ended Claude Code turn with no reported activity, idle on its empty editor, is released after the threshold; its own queued Run starts in a new session", async () => {
  const f = unknownIdle();
  const ref = f.owner().runtime_ref;
  f.advance(DEFAULT_DONE_SESSION_RELEASE_MS - 60_000);
  await f.pass();
  expect(f.runtime.release).not.toHaveBeenCalled();
  f.advance(61_000);
  await f.service.tick();
  await vi.waitFor(() =>
    expect(f.events("session_replaced")).toMatchObject([
      {
        payload: {
          assignment_id: f.owner().id,
          reason: "idle_session_stopped",
          trigger: "turn_done",
          queued_run_id: f.queued.id,
          idle_basis: "bound_idle_prompt",
          cancelled_run_ids: [],
          old_runtime_ref: ref,
        },
      },
    ]),
  );
  // Observed before deciding and again right before closing.
  expect(f.observe_prompt.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(f.observe_prompt).toHaveBeenCalledWith(ref, {
    project_id: f.project,
    assignment_id: f.owner().id,
    harness: "claude-code",
  });
  expect(f.runtime.release).toHaveBeenCalledExactlyOnceWith(ref, {
    force: true,
  });
  expect(f.owner()).toMatchObject({ runtime_ref: null, status: "active" });
  const dispatcher = new Dispatcher(f.options);
  try {
    await dispatcher.tick();
    await dispatcher.tick();
    expect(f.options.startRun).toHaveBeenCalledOnce();
    expect(f.options.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        run: expect.objectContaining({ id: f.queued.id }),
      }),
    );
  } finally {
    await dispatcher.close();
  }
});

test("C-838: without the empty editor, with a reported turn, a Run in flight or another harness, the unknown session is kept", async () => {
  // The CLI shows a turn, a draft or a confirmation: no editor.
  const f = unknownIdle();
  f.editor = false;
  f.advance(DEFAULT_DONE_SESSION_RELEASE_MS + 60_000);
  await f.pass();
  expect(f.runtime.release).not.toHaveBeenCalled();
  // hc reports work: the editor is not even consulted.
  f.editor = true;
  f.working.add(f.owner().runtime_ref!.terminal_ref);
  f.observe_prompt.mockClear();
  f.advance(DEFAULT_DONE_SESSION_RELEASE_MS + 60_000);
  await f.pass();
  expect(f.observe_prompt).not.toHaveBeenCalled();
  expect(f.runtime.release).not.toHaveBeenCalled();
  // A Run on the session started meanwhile.
  f.working.clear();
  f.store.uow.run((tx) =>
    tx.runs.put(f.project, {
      ...f.queued,
      status: "running",
      started_at: f.clock.now(),
    }),
  );
  f.advance(DEFAULT_DONE_SESSION_RELEASE_MS + 60_000);
  await f.pass();
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.owner().runtime_ref).not.toBeNull();
  expect(f.events("session_replaced")).toEqual([]);

  // A harness without a bound editor is never read.
  const g = unknownIdle("pi");
  g.advance(DEFAULT_DONE_SESSION_RELEASE_MS + 60_000);
  await g.pass();
  expect(g.observe_prompt).not.toHaveBeenCalled();
  expect(g.runtime.release).not.toHaveBeenCalled();
});

test("C-838: the editor must still be shown right before the terminal is closed", async () => {
  const f = unknownIdle();
  // Shown when deciding, gone (a new turn) on the re-read before closing.
  let calls = 0;
  f.observe_prompt.mockImplementation(async () => ({
    ok: true,
    value: ++calls === 1,
  }));
  f.advance(DEFAULT_DONE_SESSION_RELEASE_MS + 60_000);
  await f.pass();
  await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.owner().runtime_ref).not.toBeNull();
  // A transient refusal: no PM hand-off.
  expect(f.events("session_release_held")).toEqual([]);
});
