import { main } from "@cardigan/cli";
import {
  completeHumanAction,
  dispatchRun,
  finishRun,
  type Runtime,
  releaseAssignment,
  requestHumanAction,
} from "@cardigan/domain";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { m3Fixture } from "../test-support/m3-acceptance.js";
import { Dispatcher } from "./dispatch.js";
import { routeProjectEvents } from "./dispatch-inbox.js";
import { resolveWebConfig } from "./web/config.js";
import { type RunningWebServer, startWebServer } from "./web/server.js";

let f: ReturnType<typeof m3Fixture>, web: RunningWebServer | undefined;
beforeEach(() => {
  f = m3Fixture();
});
afterEach(async () => {
  await web?.close();
  web = undefined;
  f.close();
});

const requestAction = (blocked = false) =>
  f.apply(
    (s, a, p) =>
      requestHumanAction(
        s,
        a,
        {
          card_id: f.card.id,
          instructions: "Provide sanitized copy",
          why_human: "Manual export",
          expected_return: "Location",
          blocked_work_items: blocked ? [f.produce.id] : [],
        },
        p,
      ),
    f.actor(f.coder),
  ).data;
const resultText = "脱敏副本已准备好，可继续审核";
async function login() {
  if (!f.dataDir) throw new Error("Missing fixture directory");
  f.store.setWebPassword("human action test password");
  web = await startWebServer({
    store: f.store,
    dataDir: f.dataDir,
    config: resolveWebConfig({}, { port: 0 }),
  });
  const response = await fetch(`${web.url}/api/login`, {
    method: "POST",
    headers: { origin: web.url, "content-type": "application/json" },
    body: JSON.stringify({ password: "human action test password" }),
  });
  expect(response.status).toBe(200);
  await response.body?.cancel();
  return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
}
const cli = (args: string[], output: string[] = []) =>
  main(args, {
    env: { CARDIGAN_DATA_DIR: f.dataDir },
    cwd: f.dataDir,
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
  });

test.each(["CLI", "Workbench"])(
  "%s completion reaches the requester and waiting reviewers through one persisted bell per recipient",
  async (entry) => {
    const original = f.start(f.coder);
    const action = requestAction(true);
    f.apply(
      (s, a, p) =>
        finishRun(
          s,
          a,
          {
            run_id: original.id,
            outcome: "blocked",
            summary: "Waiting for copy",
          },
          p,
        ),
      f.actor(f.coder),
    );
    if (entry === "CLI") {
      const output: string[] = [];
      expect(
        await cli(
          ["human-action", "done", action.id, "--text", resultText],
          output,
        ),
        output.join("\n"),
      ).toBe(0);
    } else {
      const cookie = await login();
      const response = await fetch(
        `${web?.url}/api/projects/${f.id}/human-actions/${encodeURIComponent(action.id)}/complete`,
        {
          method: "POST",
          headers: {
            cookie,
            origin: web?.url ?? "",
            "content-type": "application/json",
          },
          body: JSON.stringify({ text: resultText }),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: "done",
        result: { text: resultText },
      });
    }
    const event = f
      .state()
      .events.findLast((e) => e.type === "human_action_completed");
    if (!event) throw new Error("Missing completion event");
    const queued = f
      .state()
      .runs.find(
        (r) => r.assignment_id === f.coder.id && r.status === "queued",
      );
    expect(queued?.trigger_event_id).toBe(event.id);
    const wake = vi.fn(async () => ({
      ok: true as const,
      value: { sent: true },
    }));
    const runtime: Runtime = {
      status: async () => ({
        ok: true,
        value: { process: "alive", agent: "idle", observed_seq: 1 },
      }),
      wake,
      provision: async () => {
        throw new Error("Use host startup");
      },
      release: async () => ({ ok: true, value: undefined }),
      interrupt: async () => ({ ok: true, value: undefined }),
      resume_or_replace: async () => {
        throw new Error("Unused");
      },
      human_entry: async () => ({ ok: true, value: "fixture" }),
    };
    const dispatcher = new Dispatcher({
      store: f.store,
      runtime,
      clock: f.clock,
      snapshot: async () => ({
        model: "test-model",
        agent_cli_version: "test-cli",
      }),
      startRun: async ({ run, assignment }) => {
        f.apply((s, a, p) =>
          dispatchRun(
            s,
            a,
            {
              run_id: run.id,
              runtime_ref: {
                machine_id: "local",
                runtime_machine: "local",
                terminal_ref: assignment.id,
                agent_name: assignment.id,
              },
            },
            p,
          ),
        );
      },
    });
    await dispatcher.tick();
    await dispatcher.tick();
    const notes = () =>
      f.store
        .listNotifications({ project_id: f.id })
        .filter((n) => n.event_id === event.id);
    expect(notes().map((n) => n.recipient)).toEqual(
      expect.arrayContaining(
        [f.coder, f.reviewer, f.pm].map((a) => ({
          kind: "assignment",
          assignment_id: a.id,
        })),
      ),
    );
    expect(notes()).toHaveLength(3);
    expect(
      notes().every((n) => n.status === "belled" && n.attempts === 1),
    ).toBe(true);
    expect(
      notes().find(
        (n) =>
          n.recipient.kind === "assignment" &&
          n.recipient.assignment_id === f.coder.id,
      )?.run_id,
    ).toBe(queued?.id);
    expect(wake).toHaveBeenCalledOnce();
    expect(JSON.stringify(wake.mock.calls)).not.toContain(resultText);
    const updates = f.store.getUpdates({
      project_id: f.id,
      card_id: f.card.id,
    });
    expect(updates.timeline).toContainEqual(
      expect.objectContaining({
        card_id: f.card.id,
        human_action_id: action.id,
        body: resultText,
      }),
    );
    for (const a of [f.coder, f.reviewer, f.pm])
      f.store.ackEvents({
        project_id: f.id,
        assignment_id: a.id,
        card_id: f.card.id,
        up_to_seq: event.seq,
      });
    await dispatcher.tick();
    expect(notes().every((n) => n.status === "acked")).toBe(true);
  },
);

test("without an active requester or Ops, Web and CLI Needs You show the completed result", async () => {
  const action = requestAction();
  f.apply((s, a, p) =>
    releaseAssignment(s, a, { assignment_id: f.coder.id }, p),
  );
  f.apply((s, a, p) =>
    completeHumanAction(
      s,
      a,
      { human_action_id: action.id, text: resultText },
      p,
    ),
  );
  routeProjectEvents(f.store, f.id);
  const event = f
    .state()
    .events.findLast((e) => e.type === "human_action_completed");
  expect(
    f.store
      .listNotifications({ project_id: f.id })
      .filter((n) => n.event_id === event?.id)
      .map((n) => n.recipient.kind),
  ).toContain("needs_you");
  const cookie = await login();
  const response = await fetch(`${web?.url}/api/projects/${f.id}/needs-you`, {
    headers: { cookie },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    human_actions: [
      { id: action.id, card_id: f.card.id, completion_notice: resultText },
    ],
  });
  const output: string[] = [];
  expect(await cli(["needs-you"], output)).toBe(0);
  for (const text of [action.id, f.card.id, resultText, "PM Ops"])
    expect(output.join("\n")).toContain(text);
});
