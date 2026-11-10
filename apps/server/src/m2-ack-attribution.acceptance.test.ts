/**
 * M2.T1 cross-acceptance: an Assignment may only acknowledge its own Run.
 *
 * A standing PM Assignment (scope `standing`) has no work item, so the
 * `run_started` work-item guard does not protect it: the only defence is that
 * the MCP endpoint acknowledges the caller's own dispatched Run, never a run id
 * from the request (M2 plan §4 step 8, §10.4).
 *
 * Everything here goes through public surfaces: the CLI (in process), the real
 * store, the real MCP server and MCP clients.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { humanActor, main, runCommand } from "@cardigan/cli";
import {
  type Assignment,
  dispatchRun,
  type ProjectId,
  queueRun,
} from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type CardiganServer, startCardiganServer } from "./server.js";

const project_id = "p-attribution" as ProjectId;
const MODEL = "fictional-model";
const CLI_VERSION = "pi 1.5.0-fictional";

let dataDir: string;
let server: CardiganServer;
let output: string[];
let errors: string[];
let coderToken: string;
let pmToken: string;
let pmRun: string;
let coderRun: string;

/** Run the CLI in process; the environment is the temp data directory. */
async function cardigan(argv: readonly string[]): Promise<number> {
  output = [];
  errors = [];
  return main(argv, {
    env: { CARDIGAN_DATA_DIR: dataDir },
    cwd: dataDir,
    platform: process.platform,
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("these commands must not spawn");
    },
    captureCommand: async () => ({ code: 1, stdout: "", stderr: "" }),
  });
}

/** The token `printToken` shows exactly once. */
function issuedToken(): string {
  const lines = output
    .join("\n")
    .split("\n")
    .map((line) => line.trim());
  const start = lines.indexOf(
    "Token（只显示这一次，复制后请自行保存，不要写进仓库）：",
  );
  const token = lines[start + 1];
  if (token === undefined)
    throw new Error(`no token in:\n${output.join("\n")}`);
  return token;
}

/** Queue and dispatch a Run for `assignmentId`, as the host would. */
function dispatchFor(store: Store, assignmentId: string): string {
  runCommand(store, {
    project_id,
    actor: humanActor(project_id),
    reduce: (state, actor, ports) =>
      queueRun(
        state,
        actor,
        {
          assignment_id: assignmentId as Assignment["id"],
          model: MODEL,
          agent_cli_version: CLI_VERSION,
        },
        ports,
      ),
  });
  const run = store.uow.read((tx) =>
    tx.runs
      .list(project_id)
      .find(
        (candidate) =>
          candidate.assignment_id === (assignmentId as Assignment["id"]) &&
          candidate.status === "queued",
      ),
  );
  if (run === undefined) throw new Error(`no queued run for ${assignmentId}`);
  runCommand(store, {
    project_id,
    actor: humanActor(project_id),
    reduce: (state, actor, ports) =>
      dispatchRun(
        state,
        actor,
        {
          run_id: run.id,
          runtime_ref: {
            machine_id: "local",
            runtime_machine: "local",
            terminal_ref: "t1",
            agent_name: `fixture-${assignmentId.toLowerCase()}`,
          },
        },
        ports,
      ),
  });
  return run.id;
}

const status = (store: Store, runId: string) =>
  store.uow.read((tx) => tx.runs.get(project_id, runId as never))?.status;

function connect(token: string): Promise<Client> {
  const client = new Client({ name: "fixture-agent", version: "0" });
  return client
    .connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    )
    .then(() => client);
}

describe("an Assignment may only acknowledge its own Run", () => {
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "cardigan-attribution-"));
    expect(await cardigan(["init"])).toBe(0);
    expect(await cardigan(["project", "create", project_id])).toBe(0);
    expect(
      await cardigan([
        "role",
        "add",
        project_id,
        "pm",
        "--allowed-tools",
        "create_card,assign,record_decision,submit_review",
      ]),
    ).toBe(0);
    expect(
      await cardigan([
        "role",
        "add",
        project_id,
        "coder",
        "--allowed-tools",
        "whoami,get_card",
      ]),
    ).toBe(0);
    expect(
      await cardigan([
        "role",
        "add",
        project_id,
        "reviewer",
        "--allowed-tools",
        "submit_review",
      ]),
    ).toBe(0);
    expect(
      await cardigan([
        "card",
        "create",
        "--template",
        "dev",
        "--title",
        "Fictional card",
        "--goal",
        "Acknowledge the right Run",
        "--acceptance",
        "only the caller's Run starts",
        "--repo",
        "example/repo",
      ]),
    ).toBe(0);

    // A coder Assignment with its own token.
    expect(await cardigan(["assign", "W-1", "--role", "coder"])).toBe(0);
    coderToken = issuedToken();
    // A standing PM Assignment (no work item) with its own token.
    expect(await cardigan(["pm", "create", "--office"])).toBe(0);
    pmToken = issuedToken();

    const store = Store.open({ dataDir });
    try {
      const assignments = store.uow.read((tx) =>
        tx.assignments.list(project_id),
      );
      const pm = assignments.find(
        (candidate) => candidate.scope === "standing",
      );
      const coder = assignments.find(
        (candidate) => candidate.scope === "work_item",
      );
      if (pm === undefined || coder === undefined)
        throw new Error("assignments missing");
      expect(pm.id).toBe("A-2");
      expect(pm.work_item_id).toBeUndefined();
      pmRun = dispatchFor(store, pm.id);
    } finally {
      store.close();
    }

    server = await startCardiganServer({
      config: { dataDir, host: "127.0.0.1", port: 0 },
    });
  });

  afterEach(async () => {
    await server?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("a coder with no Run of its own cannot acknowledge the PM's Run", async () => {
    // The dangerous case: the PM's Run is the only dispatched Run in the
    // project, and the coder has nothing of its own to acknowledge.
    const client = await connect(coderToken);
    try {
      await client.callTool({ name: "whoami", arguments: {} });
      await client.callTool({
        name: "get_card",
        arguments: { card_id: "C-1" },
      });
    } finally {
      await client.close();
    }

    const store = Store.open({ dataDir });
    try {
      // Nothing of the coder's moved, and the standing PM Run is untouched:
      // no work item guard protects it, only the attribution check.
      expect(status(store, pmRun)).toBe("dispatched");
      const pmEvents = store
        .getUpdates({
          project_id,
          since_seq: 0,
        })
        .events.filter(
          (event) =>
            event.type === "run_started" &&
            (event.payload as { run_id?: string }).run_id === pmRun,
        );
      expect(pmEvents).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("a coder with its own dispatched Run acknowledges only that one", async () => {
    const seeded = Store.open({ dataDir });
    try {
      const coder = seeded.uow
        .read((tx) => tx.assignments.list(project_id))
        .find((candidate) => candidate.scope === "work_item");
      if (coder === undefined) throw new Error("coder assignment missing");
      coderRun = dispatchFor(seeded, coder.id);
    } finally {
      seeded.close();
    }

    const client = await connect(coderToken);
    try {
      await client.callTool({ name: "whoami", arguments: {} });
      // The coder's Run is running now, so a second call must be a no-op.
      await client.callTool({ name: "whoami", arguments: {} });
    } finally {
      await client.close();
    }

    const store = Store.open({ dataDir });
    try {
      expect(status(store, coderRun)).toBe("running");
      expect(status(store, pmRun)).toBe("dispatched");
    } finally {
      store.close();
    }
  });

  test("the standing PM acknowledges its own Run without touching a work item", async () => {
    const client = await connect(pmToken);
    try {
      await client.callTool({ name: "whoami", arguments: {} });
    } finally {
      await client.close();
    }

    const store = Store.open({ dataDir });
    try {
      expect(status(store, pmRun)).toBe("running");
      // The coder never ran here, so no coder Run exists to have advanced.
      expect(
        store.uow
          .read((tx) => tx.runs.list(project_id))
          .filter((run) => run.assignment_id === "A-1"),
      ).toEqual([]);
      // A standing Assignment owns no work item, so none changed.
      const items = store.uow.read((tx) => tx.work_items.list(project_id));
      expect(items.filter((item) => item.assignment_id === "A-2")).toEqual([]);
      expect(items.map((item) => item.status)).not.toContain("in_progress");
    } finally {
      store.close();
    }
  });
});
