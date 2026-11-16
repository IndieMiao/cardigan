import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginIdleAssignmentRoleUpgrade,
  finishIdleAssignmentRoleUpgrade,
} from "@cardigan/domain";
import { issueAssignmentToken, launchEntities } from "@cardigan/host";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import { defaultRoleDefinition } from "@cardigan/roles";
import { Store, writeRole } from "@cardigan/store";
import { expect, test } from "vitest";
import {
  fixture,
  human,
} from "../../../packages/domain/src/commands/test-fixtures.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

test.each(["cli_first", "launch_first"])(
  "token issuance shares the pending fence and audited scope: %s",
  async (order) => {
    const dir = mkdtempSync(join(tmpdir(), "cg-token-upgrade-"));
    const store = Store.open({ dataDir: dir });
    const state = fixture();
    const owner = { ...state.assignments[0]!, runtime_ref: null };
    const project = human.project_id;
    const role = defaultRoleDefinition("coder", {
      harness: "codex",
      launch_profile_ref: "fixture",
    });
    const errors: string[] = [];
    const io: CliIo = {
      env: { CARDIGAN_DATA_DIR: dir, CARDIGAN_CONFIG_DIR: dir },
      cwd: dir,
      platform: "linux",
      stdout: () => {}, // Never retain or print the synthetic credentials.
      stderr: (line) => errors.push(line),
      signals: { on: () => undefined, off: () => undefined },
      spawnInherit: () => {
        throw new Error("No terminal needed");
      },
      captureCommand: async () => {
        throw new Error("No Git needed");
      },
    };
    const cli = () =>
      main(["token", "issue", owner.id, "--project", project], io);
    const launch = () =>
      issueAssignmentToken(
        store,
        project,
        launchEntities(store, project, owner.id),
      );
    const tokens = () =>
      store.uow.run((tx) => tx.tokensForAssignment(project, owner.id));
    const advance = (finish: boolean) =>
      store.uow.run((tx) => {
        const effect = (
          finish
            ? finishIdleAssignmentRoleUpgrade
            : beginIdleAssignmentRoleUpgrade
        )(
          loadCommandState(tx, project),
          { kind: "system", project_id: project },
          owner.id,
          { ids: tx.ids, clock: { now: () => "2030-01-01T00:00:00Z" } },
        );
        if (!effect.ok) throw new Error(effect.error.message);
        persistEffect(tx, project, effect.value);
        if (!finish)
          for (const token of tx.tokensForAssignment(project, owner.id))
            tx.revokeToken(token.id);
      });
    try {
      store.createProject({ id: project });
      store.uow.run((tx) => {
        tx.cards.put(project, { ...state.cards[0]!, flow_version: 1 });
        tx.work_items.put(project, state.work_items[0]!);
        tx.assignments.put(project, owner);
        writeRole(
          tx,
          project,
          { ...role, version: 1, allowed_tools: ["get_card"] },
          { mode: "add" },
        );
        writeRole(tx, project, { ...role, version: 2 }, { mode: "update" });
        tx.issueToken({
          project_id: project,
          assignment_id: owner.id,
          role: { role_version: 1, allowed_tools: ["get_card"] },
        });
      });
      advance(false);
      const pendingTokens = tokens();
      expect(await cli()).not.toBe(0);
      expect(errors.join("\n")).toContain("upgrade is pending");
      expect(() => launch()).toThrow("upgrade is pending");
      expect(tokens()).toEqual(pendingTokens);
      advance(true);
      if (order === "cli_first") {
        expect(await cli()).toBe(0);
        launch();
      } else {
        launch();
        expect(await cli()).toBe(0);
      }
      expect(tokens().at(-1)).toMatchObject({
        role_version: 2,
        allowed_tools: expect.arrayContaining([
          "request_check",
          "get_check_log",
        ]),
      });
      expect(tokens().filter((t) => t.revoked_at === null)).toHaveLength(1);
      // A narrower same-version token remains narrow through both entrances;
      // flow upgrade must see that ceiling, even though the role has the tools.
      store.uow.run((tx) => {
        for (const token of tx.tokensForAssignment(project, owner.id))
          tx.revokeToken(token.id);
        tx.issueToken({
          project_id: project,
          assignment_id: owner.id,
          role: { role_version: 2, allowed_tools: ["get_card"] },
        });
      });
      expect(await cli()).toBe(0);
      expect(launch().record.allowed_tools).toEqual(["get_card"]);
      const before = store.uow.read((tx) => loadCommandState(tx, project));
      expect(
        await main(
          [
            "card",
            "flow-upgrade",
            state.cards[0]!.id,
            "--to",
            "5",
            "--project",
            project,
          ],
          io,
        ),
      ).not.toBe(0);
      expect(errors.join("\n")).toContain("有效预检工具");
      expect(store.uow.read((tx) => loadCommandState(tx, project))).toEqual(
        before,
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
