import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Assignment,
  queueRun,
  type Role,
  type Runtime,
} from "@cardigan/domain";
import { parseLaunchConfig } from "@cardigan/roles";
import { Store, writeRole } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { applyCommand } from "./commands.js";
import { launchRun } from "./launch.js";

/**
 * C-600: the real host start flow marks a new session as waiting for its
 * native Card tool listing only when the host enables the check, and every
 * launch names the Card MCP host in NO_PROXY.
 */
test.each([
  { harness: "codex", verify: true, expected: "pending" },
  { harness: "claude-code", verify: true, expected: "pending" },
  // Pi may connect lazily from cached tool metadata: never verified.
  { harness: "pi", verify: true, expected: undefined },
  { harness: "codex", verify: false, expected: undefined },
] as const)(
  "C-600 $harness host launch (verify=$verify) records the session handshake and bypasses proxies for Card MCP",
  async ({ harness, verify, expected }) => {
    const root = await mkdtemp(join(tmpdir(), "cg-mcp-session-"));
    const dataDir = join(root, "data");
    await mkdir(dataDir, { mode: 0o700 });
    const store = Store.open({ dataDir });
    const project = "mcp-session";
    const clock = { now: () => "2026-01-01T00:00:00.000Z" };
    const role: Role = {
      role_id: "pm",
      version: 1,
      display_name: "PM",
      kind: "standing",
      harness,
      core_prompt: "Fixture",
      launch_profile_ref: "fixture",
      allowed_tools: ["whoami", "finish_run"],
      capabilities: [],
      abilities: [],
      worktree: "none",
      required_machine_tags: [],
    };
    const runtime = {
      provision: vi.fn(async () => ({
        ok: true,
        value: {
          machine_id: "local",
          runtime_machine: "local",
          terminal_ref: "fixture",
          agent_name: "fixture",
        },
      })),
      release: vi.fn(async () => ({ ok: true, value: undefined })),
    } as unknown as Runtime;
    try {
      store.createProject({ id: project, name: "MCP session" });
      const assignment: Assignment = {
        id: "A-1",
        scope: "standing",
        standing_mode: "ops",
        role_id: "pm",
        role_version: 1,
        status: "active",
        runtime_state: "not_provisioned",
        runtime_ref: null,
        machine_id: "local",
        mcp_token_id: "fixture",
        created_at: clock.now(),
      };
      store.uow.run((tx) => {
        writeRole(tx, project, role, { mode: "add" });
        tx.assignments.put(project, assignment);
      });
      const actor = { kind: "human" as const, project_id: project };
      const run = applyCommand(store, {
        project,
        actor,
        clock,
        reduce: (state, who, ports) =>
          queueRun(
            state,
            who,
            {
              assignment_id: assignment.id,
              model: "fixture",
              agent_cli_version: "fixture",
            },
            ports,
          ),
      });
      const launched = await launchRun(
        {
          store,
          runtime,
          dataDir,
          execution: { mode: "local", dataDir },
          clock,
          mcpUrl: "http://127.0.0.1:3004/mcp",
          ...(verify ? { verifyMcpSession: true } : {}),
          launch: {
            config: parseLaunchConfig({
              profiles: { fixture: { harness, model: "fixture" } },
            }),
            secrets: {},
          },
        },
        { project, assignment_id: assignment.id, actor, run },
      );
      expect(launched.run.status).toBe("dispatched");
      expect(
        store.uow.read((tx) => tx.assignments.get(project, assignment.id))
          ?.mcp_handshake,
      ).toBe(expected);
      // The key lives only in the harness's own MCP configuration; the
      // Assignment keeps its digest.
      const config =
        harness === "codex"
          ? await readFile(
              join(launched.run_dir, "codex", "config.toml"),
              "utf8",
            )
          : harness === "claude-code"
            ? await readFile(join(launched.run_dir, "mcp.json"), "utf8")
            : "";
      const key = /"X-Cardigan-Session"\s*[:=]\s*"([A-Za-z0-9_-]+)"/u.exec(
        config,
      )?.[1];
      const digest = store.uow.read((tx) =>
        tx.assignments.get(project, assignment.id),
      )?.mcp_session_key_sha256;
      if (expected) {
        expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/u);
        expect(digest).toBe(
          createHash("sha256")
            .update(key ?? "")
            .digest("hex"),
        );
        const script = await readFile(
          join(launched.run_dir, "launch.sh"),
          "utf8",
        );
        expect(script).not.toContain(key);
      } else {
        expect(digest).toBeUndefined();
        if (!verify) expect(config).not.toContain("X-Cardigan-Session");
      }
      const script = await readFile(
        join(launched.run_dir, "launch.sh"),
        "utf8",
      );
      expect(script).toContain("cardigan_bypass '127.0.0.1'");
      expect(script).toContain('export NO_PROXY="$cardigan_upper"');
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
