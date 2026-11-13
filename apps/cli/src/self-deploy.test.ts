import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assignment } from "@cardigan/domain";
import { RunCapacityDeferred } from "@cardigan/host";
import { defaultRoleDefinition } from "@cardigan/roles";
import { Store, writeRole } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { startAssignmentById } from "./assignment.js";
import type { CliIo } from "./io.js";
import { runSelfDeployCommand } from "./self-deploy.js";

vi.mock("./assignment.js", () => ({ startAssignmentById: vi.fn() }));

test("post-deploy starts the replacement Ops as host automation only when it has no Run", async () => {
  const root = await mkdtemp(join(tmpdir(), "cg-self-deploy-"));
  const dataDir = join(root, "data");
  const store = Store.open({ dataDir });
  const start = vi.mocked(startAssignmentById);
  start.mockReset();
  start.mockRejectedValueOnce(new RunCapacityDeferred("R-1", 1));
  const io: CliIo = {
    env: {
      CARDIGAN_DATA_DIR: dataDir,
      CARDIGAN_CONFIG_DIR: root,
      CARDIGAN_DEPLOYMENT_CHANGED_ROLES: '["pm"]',
    },
    cwd: root,
    platform: "linux",
    stdout: () => {},
    stderr: () => {},
    signals: { on: () => {}, off: () => {} },
    spawnInherit: () => {
      throw new Error("No real launch");
    },
    captureCommand: async () => {
      throw new Error("No real command");
    },
  };
  try {
    await writeFile(
      join(root, "self-deploy.yaml"),
      JSON.stringify({
        initial_release: root,
        initial_sha: "a".repeat(40),
        ready_timeout_ms: 1000,
        stop_timeout_ms: 1000,
        build_timeout_ms: 1000,
        poll_interval_ms: 1000,
      }),
      { mode: 0o600 },
    );
    store.createProject({ id: "cardigan" });
    store.uow.run((tx) => {
      writeRole(
        tx,
        "cardigan",
        {
          ...defaultRoleDefinition("pm", {
            harness: "codex",
            launch_profile_ref: "fixture",
          }),
          core_prompt: "",
          instructions: "Previous instructions",
          version: 1,
        },
        { mode: "add" },
      );
      tx.assignments.put("cardigan", {
        id: "A-50",
        scope: "standing",
        standing_mode: "ops",
        role_id: "pm",
        role_version: 1,
        status: "active",
        runtime_state: "not_provisioned",
        machine_id: "local",
        runtime_ref: null,
        mcp_token_id: "fixture",
        created_at: "2026-01-01T00:00:00.000Z",
      } as Assignment);
    });
    expect(await runSelfDeployCommand(["roles"], io)).toBe(0);
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]?.[0]).toMatchObject({
      project_id: "cardigan",
      automatic: true,
    });
    const id = start.mock.calls[0]?.[0].assignment_id;
    if (!id) throw new Error("Expected replacement assignment");
    store.uow.run((tx) =>
      tx.runs.put("cardigan", {
        id: tx.ids.next("cardigan", "run"),
        assignment_id: id,
        trigger_event_id: tx.ids.nextEventId(),
        kind: "initial",
        status: "queued",
        role_version: 2,
        model: "fixture",
        agent_cli_version: "fixture",
        outcome: null,
        summary: "",
      }),
    );
    expect(await runSelfDeployCommand(["roles"], io)).toBe(0);
    expect(start).toHaveBeenCalledOnce();
    await expect(
      runSelfDeployCommand(["roles"], {
        ...io,
        env: { ...io.env, CARDIGAN_TOKEN: "fixture-token" },
      }),
    ).rejects.toThrow("Agent 不可调用");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
