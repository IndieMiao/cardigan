/** M3.T2/M3.5: expectations from plan §3.4 and development plan §7.1–§7.3, §6.4.
 * Setup uses CLI pm create, createCard + assign commands, real MCP and Runtime ports.
 * No repository writes or implementation imports. Mutation evidence is in the PR.
 */

// M3.T2: only public CLI, host commands, MCP, Runtime ports and read-only Store APIs.
import { EventEmitter, on } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CliIo,
  createProcessIo,
  main,
  runCommand,
  startAssignment,
} from "@cardigan/cli";
import {
  type Assignment,
  type AssignmentId,
  assign,
  createCard,
  dispatchRun,
  type Notification,
  queueRun,
  type Runtime,
  type RuntimeLaunch,
  type RuntimeRef,
  type RuntimeResult,
  STANDING_ONLY_TOOLS,
  STANDING_ROLE_TOOLS,
} from "@cardigan/domain";
import { launchRun } from "@cardigan/host";
import {
  corePromptFor,
  parseLaunchConfig,
  TOKEN_FILE_NAME,
} from "@cardigan/roles";
import type { RuntimeEvent } from "@cardigan/runtime-herdr";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, test } from "vitest";
import { stubGit } from "./git-test-support.js";
import { startCardiganServer } from "./index.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

const ok = <T>(value: T): RuntimeResult<T> => ({ ok: true, value });
class PmRuntime implements Runtime {
  readonly bus = new EventEmitter();
  readonly launches: { assignment: Assignment; launch: RuntimeLaunch }[] = [];
  readonly bells: { id: AssignmentId; text: string }[] = [];
  readonly working = new Set<AssignmentId>();
  readonly fail = new Set<AssignmentId>();
  /** Terminals whose process is gone: the dispatcher must open a new session. */
  readonly gone = new Set<AssignmentId>();
  readonly refs = new Map<string, AssignmentId>();
  async provision(
    a: Assignment,
    _role: unknown,
    _machine: unknown,
    launch: RuntimeLaunch,
  ) {
    const ref: RuntimeRef = {
      machine_id: "local",
      runtime_machine: "local",
      terminal_ref: `terminal-${a.id}`,
      agent_name: launch.agent_name,
    };
    this.launches.push({ assignment: a, launch });
    this.refs.set(ref.terminal_ref, a.id);
    return ok(ref);
  }
  async wake(ref: RuntimeRef, text: string) {
    const id = this.refs.get(ref.terminal_ref);
    if (!id) throw new Error("Unknown terminal");
    this.bells.push({ id, text });
    return this.fail.has(id)
      ? {
          ok: false as const,
          error: {
            code: "runtime_unavailable" as const,
            message: "Injected terminal failure",
          },
        }
      : ok({ sent: true });
  }
  async status(ref: RuntimeRef) {
    const id = this.refs.get(ref.terminal_ref);
    if (id === undefined || this.gone.has(id))
      return {
        ok: false as const,
        error: {
          code: "runtime_not_found" as const,
          message: "No such terminal",
        },
      };
    return ok({
      process: "alive" as const,
      agent: this.working.has(id) ? ("working" as const) : ("idle" as const),
      observed_seq: 1,
    });
  }
  async interrupt() {
    return ok(undefined);
  }
  async release() {
    return ok(undefined);
  }
  async human_entry() {
    return ok("fixture terminal");
  }
  async resume_or_replace(ref: RuntimeRef) {
    return ok(ref);
  }
  async *events(ref: RuntimeRef, signal?: AbortSignal) {
    try {
      for await (const [event] of on(this.bus, ref.terminal_ref, { signal }))
        yield ok(event as RuntimeEvent);
    } catch (e) {
      if (!signal?.aborted) throw e;
    }
  }
  lost(a: AssignmentId) {
    const terminal_ref = `terminal-${a}`;
    this.bus.emit(terminal_ref, {
      seq: 2,
      type: "terminal.finished",
      terminal_ref,
      observations: [
        {
          terminal_ref,
          status: { process: "exited", agent: "unknown", observed_seq: 2 },
        },
      ],
    } satisfies RuntimeEvent);
  }
}
async function pmFixture(automaticOps = false) {
  let standingReady = automaticOps;
  const root = await mkdtemp(join(tmpdir(), "cardigan-pm-acceptance-")),
    dataDir = join(root, "data"),
    project = "pm-acceptance";
  let output = "",
    errors = "",
    count = 0,
    offset = 0;
  const clock = { now: () => new Date(Date.now() + offset).toISOString() };
  const runtime = new PmRuntime();
  const io: CliIo = {
    ...createProcessIo(),
    cwd: root,
    env: { CARDIGAN_DATA_DIR: dataDir, CARDIGAN_PROJECT: project },
    stdout: (s) => {
      output += s;
    },
    stderr: (s) => {
      errors += s;
    },
    captureCommand: async () => ({
      code: 0,
      stdout: "claude 2.0.0",
      stderr: "",
    }),
  };
  const launch = {
    config: parseLaunchConfig({
      profiles: { fixture: { harness: "claude-code", model: "fixture-model" } },
    }),
    secrets: {},
  };
  const cli = async (...args: string[]) => {
    output = "";
    errors = "";
    const code = await main(args, io, {
      start: async (input) => {
        const result = await startAssignment({
          ...input,
          dataDir,
          runtime,
          launch,
          mcpUrl: server.url,
        });
        dirs.set(input.assignment_id, result.run_dir);
        return 0;
      },
    });
    if (code !== 0) throw new Error(`CLI failed: ${errors}`);
    if (args[0] === "pm" && args[1] === "start") standingReady = true;
    return output;
  };
  await cli("project", "create", project);
  for (const role_id of ["pm", "coder", "reviewer"] as const) {
    const file = join(root, `${role_id}.json`);
    await writeFile(
      file,
      JSON.stringify({
        role_id,
        display_name: role_id,
        kind:
          role_id === "pm"
            ? "standing"
            : role_id === "coder"
              ? "produce"
              : "verify",
        core_prompt: corePromptFor(role_id),
        harness: "claude-code",
        launch_profile_ref: "fixture",
        worktree: "none",
        allowed_tools: STANDING_ROLE_TOOLS.filter(
          (tool) =>
            role_id === "pm" ||
            (![
              "record_decision",
              "resolve_delegated_decision",
              "triage_human_action",
              "replace_verification_work_item",
            ].includes(tool) &&
              !(STANDING_ONLY_TOOLS as readonly string[]).includes(tool) &&
              !(
                role_id === "coder"
                  ? ["submit_review", "withdraw_review"]
                  : ["submit_delivery"]
              ).includes(tool)),
        ),
        capabilities: [],
        abilities: [],
        required_machine_tags: [],
      }),
    );
    await cli("role", "add", "--file", file);
  }
  const pmOutput = [
    await cli("pm", "create", "--office"),
    await cli("pm", "create", "--ops"),
  ];
  const store = Store.open({ dataDir, clock });
  const credentials = new Map<AssignmentId, string>();
  function remember(text: string) {
    for (const word of text.split(/\s+/)) {
      const token = store.verifyToken(word);
      if (token) credentials.set(token.assignment_id, word);
    }
  }
  for (const output of pmOutput) remember(output);
  const human = { kind: "human" as const, project_id: project };
  const card = runCommand(store, {
    project_id: project,
    actor: human,
    clock,
    reduce: (s, a, p) =>
      createCard(
        s,
        a,
        {
          title: "PM acceptance",
          goal: "Ship",
          acceptance_criteria: ["Works"],
          source: { kind: "quote", text: "Build" },
          repo: "fixture",
          base_branch: "main",
        },
        p,
      ),
  });
  const items = store.uow.read((tx) => tx.work_items.list(project));
  for (const item of items)
    runCommand(store, {
      project_id: project,
      actor: human,
      clock,
      reduce: (s, a, p) =>
        assign(s, a, { work_item_id: item.id, role_id: item.role_id }, p),
    });
  const assignments = () =>
    store.uow.read((tx) => tx.assignments.list(project));
  const office = assignments().filter(
    (a) => a.scope === "standing",
  )[0] as Assignment;
  const ops = assignments().filter(
    (a) => a.scope === "standing",
  )[1] as Assignment;
  // Setup has already assigned every item. Mark this initial card as read so
  // its new-card bell cannot race the explicit PM starts under test.
  store.ackEvents({
    project_id: project,
    assignment_id: ops.id,
    card_id: card.id,
    up_to_seq: store.getUpdates({ project_id: project, card_id: card.id })
      .latest_seq,
  });
  const coder = assignments().find((a) => a.role_id === "coder") as Assignment;
  const reviewer = assignments().find(
    (a) => a.role_id === "reviewer",
  ) as Assignment;
  const dirs = new Map<AssignmentId, string>();
  const faults: unknown[] = [];
  let serverUrl: string | undefined;
  const server = await startCardiganServer({
    store,
    config: { dataDir, host: "localhost", port: 0 },
    warn: () => {},
    log: () => {},
    // This fixture has no repository: routing is the subject, so the delivery
    // verifier accepts the fabricated SHA (the Git path is covered elsewhere).
    git: stubGit(),
    dispatcher: {
      runtime,
      clock,
      // Explicit pm-start tests retain control until that host launch completes.
      // Routing tests opt into automatic bootstrap and consume its current credentials.
      standing: (_project, kind, state) =>
        standingReady
          ? state.assignments.find(
              (a) =>
                a.scope === "standing" &&
                a.role_id === "pm" &&
                a.status === "active" &&
                a.standing_mode === (kind === "pm_ops" ? "ops" : "office"),
            )?.id
          : undefined,
      intervalMs: 5,
      lossGraceMs: 60_000,
      inactivityGraceMs: 3_600_000,
      eventSilenceMs: 86_400_000,
      onError: (e) => faults.push(e),
      snapshot: async () => ({
        model: "fixture-model",
        agent_cli_version: "2.0.0",
      }),
      startRun: async ({ assignment, run, bell }) => {
        await expect.poll(() => serverUrl).toBeDefined();
        const result = await launchRun(
          {
            store,
            runtime,
            launch,
            mcpUrl: serverUrl as string,
            dataDir,
            clock,
          },
          {
            project,
            assignment_id: assignment.id,
            run,
            actor: { kind: "system", project_id: project },
            first_prompt: bell,
          },
        );
        dirs.set(assignment.id, result.run_dir);
      },
    },
  });
  serverUrl = server.url;
  const clients = new Map<AssignmentId, Client>();
  // Routing tests isolate the scheduler from pm-start token rotation. Start through
  // the domain's public launch commands; CLI-issued credentials stay unchanged.
  async function provision(a: Assignment) {
    if (a.id === ops.id) {
      // C-384 starts the missing Ops session; wait for its credentials, never queue twice.
      await expect.poll(() => dirs.has(a.id)).toBe(true);
      return;
    }
    if (!credentials.has(a.id)) remember(await cli("token", "issue", a.id));
    const run = runCommand(store, {
      project_id: project,
      actor: human,
      clock,
      reduce: (s, actor, p) =>
        queueRun(
          s,
          actor,
          {
            assignment_id: a.id,
            model: "fixture-model",
            agent_cli_version: "2.0.0",
          },
          p,
        ),
    });
    const result = await runtime.provision(a, undefined, undefined, {
      command: "fixture-agent",
      args: [],
      cwd: root,
      agent_name: a.id,
      labels: {},
    });
    if (!result.ok) throw new Error(result.error.message);
    runCommand(store, {
      project_id: project,
      actor: human,
      clock,
      reduce: (s, actor, p) =>
        dispatchRun(s, actor, { run_id: run.id, runtime_ref: result.value }, p),
    });
  }
  async function tokenFor(a: Assignment): Promise<string> {
    return (
      await readFile(join(dirs.get(a.id) as string, TOKEN_FILE_NAME), "utf8")
    ).trim();
  }
  async function client(a: Assignment) {
    if (!clients.has(a.id)) {
      await expect
        .poll(() => dirs.has(a.id) || credentials.has(a.id))
        .toBe(true);
      const token = dirs.has(a.id)
        ? (
            await readFile(
              join(dirs.get(a.id) as string, TOKEN_FILE_NAME),
              "utf8",
            )
          ).trim()
        : credentials.get(a.id);
      const c = new Client({ name: "pm-acceptance", version: "1" });
      await c.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      clients.set(a.id, c);
    }
    return clients.get(a.id) as Client;
  }
  async function raw(
    a: Assignment,
    name: string,
    args: Record<string, unknown> = {},
  ) {
    return (await client(a)).callTool({
      name,
      arguments: { ...args, idempotency_key: `pm-acceptance-${++count}` },
    });
  }
  async function call(
    a: Assignment,
    name: string,
    args: Record<string, unknown> = {},
  ) {
    const result = await raw(a, name, args);
    if (result.isError) throw new Error(JSON.stringify(result));
    return result.structuredContent as Record<string, unknown>;
  }
  async function finish(
    a: Assignment,
    outcome: "completed" | "failed" = "completed",
  ) {
    await call(a, "whoami");
    const run = store.uow
      .read((tx) => tx.runs.list(project))
      .find((r) => r.assignment_id === a.id && r.status === "running");
    if (run)
      await call(a, "finish_run", {
        run_id: run.id,
        outcome,
        summary: "Ready for the next event",
      });
  }
  async function routed() {
    const seq = store.getUpdates({
      project_id: project,
      card_id: card.id,
    }).latest_seq;
    await expect
      .poll(() => store.routerCursor(project, card.id))
      .toBeGreaterThanOrEqual(seq);
    expect(faults).toEqual([]);
  }
  return {
    root,
    store,
    project,
    card,
    items,
    office,
    ops,
    coder,
    reviewer,
    runtime,
    url: server.url,
    cli,
    provision,
    tokenFor,
    call,
    raw,
    client,
    finish,
    routed,
    assignments,
    clock,
    advance: (ms: number) => {
      offset += ms;
    },
    script: (a: Assignment) =>
      readFile(join(dirs.get(a.id) as string, "first.md"), "utf8"),
    async close() {
      await server.close();
      for (const c of clients.values()) await c.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

let f: Awaited<ReturnType<typeof pmFixture>> | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

// P01 (fixed): token rotation keeps the previous scope, so the CLI-created Ops
// restriction survives every restart of the shared pm role.
test("P01 §7.1: pm start preserves Office/Ops MCP capability separation under the shared pm role", async () => {
  f = await pmFixture();
  await f.cli("pm", "start");
  const office = await f.call(f.office, "whoami"),
    ops = await f.call(f.ops, "whoami");
  expect(office).toMatchObject({
    role_id: "pm",
    allowed_tools: expect.arrayContaining(["record_decision"]),
  });
  expect(ops).toMatchObject({ role_id: "pm" });
  const decision = await f.call(f.office, "request_decision", {
    card_id: f.card.id,
    kind: "choose",
    category: "general",
    question: "Approve the next step?",
    context: "Permission boundary probe",
    options: [{ key: "continue", description: "Continue", impact: "Proceed" }],
    recommended: "continue",
    affected_cards: [f.card.id],
    affected_work_items: [],
    blocking: false,
    decider: "human",
    plain_summary: TEST_PLAIN_SUMMARY,
  });
  const forbidden = await f.raw(f.ops, "record_decision", {
    decision_id: decision.id,
    option: "continue",
    rationale: "Probe",
    raw_quote: "Probe",
  });
  expect(JSON.stringify(forbidden)).toContain("forbidden_tool");
  expect(ops.allowed_tools).not.toContain("record_decision");
});

// P01b (fixed): the same restriction holds when the Dispatcher, not the CLI,
// opens the next Ops terminal and rotates its token.
test("P01b §7.1: a Dispatcher-started Ops session keeps the narrowed tool scope", async () => {
  f = await pmFixture();
  await f.cli("pm", "start");
  await f.call(f.ops, "whoami");
  const launches = () =>
    f.runtime.launches.filter((entry) => entry.assignment.id === f.ops.id)
      .length;
  const before = launches();
  // The Ops terminal exits; the next routed event must open a fresh session
  // through the same host flow the Dispatcher uses (launchRun).
  f.runtime.gone.add(f.ops.id);
  await f.finish(f.ops);
  // S4: Ops' own finished Run no longer rings it again, so the relaunch has to
  // come from a real escalation (§6.4): the coder finishes without output.
  await f.provision(f.coder);
  await f.finish(f.coder);
  await expect.poll(launches).toBeGreaterThan(before);

  const fresh = new Client({ name: "pm-acceptance-relaunch", version: "1" });
  await fresh.connect(
    new StreamableHTTPClientTransport(new URL(f.url), {
      requestInit: {
        headers: { Authorization: `Bearer ${await f.tokenFor(f.ops)}` },
      },
    }),
  );
  const who = (await fresh.callTool({ name: "whoami", arguments: {} }))
    .structuredContent as Record<string, unknown>;
  expect(who).toMatchObject({ role_id: "pm" });
  expect(who.allowed_tools).not.toContain("record_decision");
  const names = (await fresh.listTools()).tools.map((tool) => tool.name);
  expect(names).not.toContain("record_decision");
  await fresh.close();
});

test("S4 §7.1: an Ops Run that ends normally raises no run_attention for Ops", async () => {
  f = await pmFixture();
  await f.cli("pm", "start");
  await f.call(f.ops, "whoami");
  await f.finish(f.ops);
  // `run_finished` for a standing Assignment is a project-level event.
  const seq = f.store.getUpdates({ project_id: f.project }).latest_seq;
  await expect
    .poll(() => f?.store.routerCursor(f.project, ""))
    .toBeGreaterThanOrEqual(seq);
  const own = f.store
    .listNotifications({ project_id: f.project })
    .filter(
      (note) =>
        note.recipient.kind === "pm_ops" &&
        ["run_attention", "escalation"].includes(note.kind),
    );
  expect(own).toEqual([]);
});

test("P02 M3.5: pm start skips running Office and Ops without another Run or terminal", async () => {
  f = await pmFixture();
  await f.cli("pm", "start");
  await f.call(f.office, "whoami");
  await f.call(f.ops, "whoami");
  const project = f.project;
  const before = f.store.uow.read((tx) => tx.runs.list(project));
  const launches = f.runtime.launches.length;
  expect(await f.cli("pm", "start")).toMatch(/跳过/);
  expect(f.store.uow.read((tx) => tx.runs.list(project))).toEqual(before);
  expect(f.runtime.launches).toHaveLength(launches);
});

test("P03 §7.1–§7.3: default pm Core Prompt describes both duties, interrupt limits and verbatim decisions", () => {
  const prompt = corePromptFor("pm");
  expect(prompt).toMatch(/PM Office/);
  expect(prompt).toMatch(/PM Ops/);
  expect(prompt).toMatch(/需求/);
  expect(prompt).toMatch(/分配|重排/);
  expect(prompt).toMatch(/Needs You/);
  expect(prompt).toMatch(/重大风险/);
  expect(prompt).toMatch(/普通评论.*(?:不|禁止)|(?:不|禁止).*普通评论/);
  expect(prompt).toMatch(/record_decision/);
  expect(prompt).toMatch(/原话/);
});

// P04 (fixed): each first prompt names the context it runs in (§3.4).
test("P04 §7.1: pm start supplies distinct Office and Ops first prompts", async () => {
  f = await pmFixture();
  await f.cli("pm", "start");
  expect(await f.script(f.office)).toMatch(/pm[_-]office|PM Office/);
  expect(await f.script(f.ops)).toMatch(/pm[_-]ops|PM Ops/);
});

type Fixture = Awaited<ReturnType<typeof pmFixture>>;
const notices = (s: Fixture, a: Assignment) =>
  s.store
    .listNotifications({ project_id: s.project })
    .filter((n: Notification) =>
      n.recipient.kind === "assignment"
        ? n.recipient.assignment_id === a.id
        : (a.id === s.office.id && n.recipient.kind === "pm_office") ||
          (a.id === s.ops.id && n.recipient.kind === "pm_ops"),
    );
async function routingSetup(idleOffice = true) {
  const s = await pmFixture(true);
  f = s;
  for (const a of [s.office, s.ops, s.coder]) {
    await s.provision(a);
    await s.call(a, "whoami");
  }
  if (idleOffice) await s.finish(s.office);
  await s.routed();
  return s;
}
const delivery = (s: Fixture) =>
  s.call(s.coder, "submit_delivery", {
    work_item_id: s.coder.work_item_id,
    kind: "code",
    summary: "Ready for review",
    subject: { kind: "git_head", value: "a".repeat(40) },
    requested_verifiers: [s.reviewer.work_item_id],
  });

test.each(["comment", "delivery", "pass", "reject", "execution failure"])(
  "P05 §7.3: %s never interrupts idle PM Office",
  async (kind) => {
    const s = await routingSetup();
    if (kind === "comment")
      await s.call(s.coder, "post_comment", {
        card_id: s.card.id,
        body: "Ordinary progress",
      });
    else if (kind === "execution failure") await s.finish(s.coder, "failed");
    else {
      const d = await delivery(s);
      if (kind !== "delivery")
        await s.call(s.reviewer, "submit_review", {
          delivery_id: d.id,
          target_sha: "a".repeat(40),
          kind: "code",
          issues:
            kind === "reject"
              ? [
                  {
                    severity: "major",
                    must_fix: true,
                    pre_existing: false,
                    description: "Needs correction",
                  },
                ]
              : [],
        });
    }
    await s.routed();
    expect(notices(s, s.office)).toEqual([]);
    expect(s.runtime.bells.filter((b) => b.id === s.office.id)).toEqual([]);
  },
);

test("P06 §7.2/§6.7: Ops escalations wait while busy, then merge into one delivery", async () => {
  const s = await routingSetup(false);
  s.runtime.working.add(s.ops.id);
  await s.finish(s.coder);
  await s.provision(s.coder);
  await s.finish(s.coder);
  await s.routed();
  const pending = notices(s, s.ops).filter((n) => n.kind === "run_attention");
  expect(pending.length).toBeGreaterThanOrEqual(2);
  expect(pending.every((n) => n.status === "pending")).toBe(true);
  expect(s.runtime.bells.filter((b) => b.id === s.ops.id)).toEqual([]);
  expect(await s.cli("inbox")).toContain("pending");
  // End Ops via a real internal decision, leaving its pending escalations unread.
  await s.call(s.ops, "request_decision", {
    card_id: s.card.id,
    kind: "choose",
    category: "general",
    question: "Clarify the internal dependency",
    context: "Next run handles escalations",
    options: [{ key: "clarify", description: "Clarify", impact: "Continue" }],
    recommended: "clarify",
    affected_cards: [s.card.id],
    affected_work_items: [],
    blocking: true,
    decider: "role:coder",
  });
  s.runtime.working.delete(s.ops.id);
  await expect
    .poll(() =>
      notices(s, s.ops)
        .filter((n) => pending.some((p) => p.id === n.id))
        .every((n) => n.status === "belled"),
    )
    .toBe(true);
  const bells = s.runtime.bells.filter((b) => b.id === s.ops.id);
  expect(bells).toHaveLength(1);
  const delivered = notices(s, s.ops).filter((n) =>
    pending.some((p) => p.id === n.id),
  );
  expect(new Set(delivered.map((n) => n.run_id)).size).toBe(1);
  expect(new Set(delivered.map((n) => n.bell))).toEqual(
    new Set([bells[0]?.text]),
  );
  expect(bells[0]?.text).toContain(
    `${Math.min(...delivered.map((n) => n.seq))}..`,
  );
  expect(bells[0]?.text).toContain(
    `..${Math.max(...delivered.map((n) => n.seq))}`,
  );
  expect(notices(s, s.office)).toEqual([]);
});

test("P07 §6.4/§7.3: decisions and human actions appear in needs-you, Office gets only a brief hint", async () => {
  const s = await routingSetup();
  // This scenario explicitly leaves process choices to the human.
  await s.cli("preference", "set", "decision-delegation", "general", "off");
  const question = "MAJOR-RISK: stop release before irreversible data loss";
  const decision = await s.call(s.coder, "request_decision", {
    card_id: s.card.id,
    kind: "choose",
    category: "general",
    question,
    context: "Detailed private risk context",
    options: [{ key: "stop", description: "Stop", impact: "Pause release" }],
    recommended: "stop",
    affected_cards: [s.card.id],
    affected_work_items: [],
    blocking: false,
    decider: "human",
    plain_summary: TEST_PLAIN_SUMMARY,
  });
  expect(decision.decider).toBe("role:pm");
  await s.call(s.ops, "resolve_delegated_decision", {
    decision_id: decision.id,
    option: "stop",
    rationale: "Escalated after PM triage",
    escalate: true,
    plain_summary: TEST_PLAIN_SUMMARY,
  });
  await expect
    .poll(() => s.runtime.bells.filter((b) => b.id === s.office.id).length)
    .toBe(1);
  await s.call(s.office, "ack_events", {
    card_id: s.card.id,
    up_to_seq: s.store.getUpdates({ project_id: s.project, card_id: s.card.id })
      .latest_seq,
  });
  await s.finish(s.office);
  const action = await s.call(s.coder, "request_human_action", {
    card_id: s.card.id,
    instructions: "Inspect the release switch",
    why_human: "Human credentials needed",
    expected_return: "Result",
    blocked_work_items: [],
  });
  await s.call(s.ops, "triage_human_action", {
    human_action_id: action.id,
    disposition: "human",
    rationale: "The human must inspect the switch",
    title: "Check the release switch",
    summary: "The release needs a physical switch check.",
    why_human: "Only you can access the physical switch.",
    expected_outcome: "The release can continue after the check.",
    instructions: "Inspect the release switch",
    expected_return: "Result",
  });
  await s.routed();
  const needs = await s.cli("needs-you");
  expect(needs).toContain(String(decision.id));
  expect(needs).toContain(String(action.id));
  expect(needs).toContain(question);
  await expect
    .poll(() => s.runtime.bells.filter((b) => b.id === s.office.id).length)
    .toBe(2);
  const bell = s.runtime.bells.find((b) => b.id === s.office.id)?.text ?? "";
  expect(bell).toContain(s.card.id);
  expect(bell).not.toContain(question);
  expect(bell).not.toContain("Detailed private risk context");
  expect(bell.length).toBeLessThan(500);
  await expect((await s.client(s.ops)).listTools()).resolves.not.toMatchObject({
    tools: expect.arrayContaining([
      expect.objectContaining({ name: "record_decision" }),
    ]),
  });
  expect(
    JSON.stringify(
      await s.raw(s.ops, "record_decision", {
        decision_id: decision.id,
        option: "stop",
        rationale: "Stop",
        raw_quote: "Stop",
      }),
    ),
  ).toContain("forbidden_tool");
  await s.call(s.office, "record_decision", {
    decision_id: decision.id,
    option: "stop",
    rationale: "Protect data",
    raw_quote: "Stop release",
  });
  await s.cli("human-action", "done", String(action.id), "--text", "Checked");
  const after = await s.cli("needs-you");
  expect(after).not.toContain(String(decision.id));
  expect(after).not.toContain(String(action.id));
});

test("P08 M3.5: inbox and attention show delivery_failed after a real wake failure; Office stays quiet", async () => {
  const s = await routingSetup();
  await s.finish(s.coder);
  s.runtime.fail.add(s.coder.id);
  await s.call(s.office, "post_comment", {
    card_id: s.card.id,
    work_item_id: s.coder.work_item_id,
    body: "Please inspect this work",
  });
  await expect
    .poll(() => notices(s, s.coder).some((n) => n.status === "delivery_failed"))
    .toBe(true);
  for (const command of ["inbox", "attention"]) {
    const output = await s.cli(command);
    expect(output).toContain("delivery_failed");
    expect(output).toContain(s.coder.id);
  }
  expect(notices(s, s.office)).toEqual([]);
});

test("P09 M3.5: attention shows needs_attention for a running Agent without MCP activity", async () => {
  const s = await routingSetup();
  await s.finish(s.ops);
  s.advance(3_600_001);
  await expect
    .poll(() => notices(s, s.coder).some((n) => n.status === "needs_attention"))
    .toBe(true);
  const output = await s.cli("attention");
  expect(output).toContain("needs_attention");
  expect(output).toContain(s.coder.id);
});

// P10 (fixed): needs-you lists runtime incidents alongside decisions and actions.
test("P10 §13.9/M3.5: runtime loss becomes unknown then lost; attention, needs-you and Office report it", async () => {
  const s = await routingSetup();
  await expect
    .poll(() => s.runtime.bus.listenerCount(`terminal-${s.coder.id}`))
    .toBeGreaterThan(0);
  s.runtime.lost(s.coder.id);
  await expect
    .poll(() => s.assignments().find((a) => a.id === s.coder.id)?.runtime_state)
    .toBe("unknown");
  s.advance(60_001);
  await expect
    .poll(() => s.assignments().find((a) => a.id === s.coder.id)?.runtime_state)
    .toBe("lost");
  const attention = await s.cli("attention");
  expect(attention).toContain(s.coder.id);
  expect(attention).toContain("lost");
  await expect
    .poll(() => s.runtime.bells.some((b) => b.id === s.office.id))
    .toBe(true);
  expect(await s.cli("needs-you")).toContain(s.coder.id);
});

// P11 (fixed): a failed Run without output escalates to PM Ops, never to Office.
test("P11 §7.3: Agent execution failure escalates to Ops without interrupting Office", async () => {
  const s = await routingSetup(false);
  await s.finish(s.coder, "failed");
  await s.routed();
  expect(notices(s, s.ops).length).toBeGreaterThan(0);
  expect(notices(s, s.office)).toEqual([]);
});

// P12 (fixed): --assignment on a standing PM also matches its logical recipient.
test("P12 M3.5: inbox --assignment includes pending notifications for that standing PM", async () => {
  const s = await routingSetup(false);
  await s.finish(s.coder);
  await s.routed();
  const all = await s.cli("inbox");
  expect(all).toContain("pending");
  expect(await s.cli("inbox", "--assignment", s.office.id)).not.toBe(all);
  expect(await s.cli("inbox", "--assignment", s.ops.id)).toBe(all);
});
