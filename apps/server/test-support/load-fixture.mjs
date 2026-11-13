import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { resolveWebConfig } from "../dist/web/config.js";
import { startWebServer } from "../dist/web/server.js";

/** Synthetic data only. No dispatcher, external runtime or production files. */
export async function loadFixture(password = randomBytes(32).toString("hex")) {
  const dataDir = await mkdtemp(join(tmpdir(), "cardigan-load-"));
  const store = Store.open({ dbPath: join(dataDir, "fixture.sqlite") });
  const project = "load-fixture";
  const now = "2026-01-01T00:00:00.000Z";
  store.createProject({ id: project, name: "加载测量夹具" });
  store.setWebPassword(password);
  store.uow.run((tx) => {
    for (let i = 1; i <= 210; i++) {
      const id = `C-${i}`;
      tx.cards.put(project, {
        id,
        project_id: project,
        title: `加载测量：工作台卡片 ${i}`,
        goal: "合成目标与验收内容。".repeat(30),
        acceptance_criteria: ["功能与回归检查通过。".repeat(20)],
        source: { kind: "quote", text: "合成需求".repeat(30) },
        out_of_scope: [],
        related_cards: [],
        priority: i % 5,
        status: i <= 150 ? "done" : "in_progress",
        ...(i <= 150 ? { resolution: "done" } : {}),
        template: "dev",
        template_version: 1,
        merge_policy: "confirm",
        created_by: "human",
        created_at: now,
      });
      for (let n = 0; n < 20; n++) {
        const seq = tx.ids.nextEventSequence(project, id);
        tx.events.append(project, {
          id: tx.ids.nextEventId(),
          card_id: id,
          seq,
          type: "comment_posted",
          actor: { kind: "human", project_id: project },
          payload: { body: "合成评论内容。".repeat(40) },
          created_at: now,
        });
        const entry = tx.ids.nextTimelineEntryId(project, id);
        tx.timeline.put(project, {
          id: entry,
          short_id: entry,
          card_id: id,
          event_seq: seq,
          type: "comment",
          body: "合成评论内容。".repeat(40),
          author: "human",
          refs: [],
          mentions: [],
          retracted: false,
          created_at: now,
        });
      }
    }
    tx.roles.put(project, {
      role_id: "coder",
      role_version: 1,
      allowed_tools: [],
      capabilities: [],
    });
    for (let i = 1; i <= 577; i++) {
      const card = `C-${((i - 1) % 210) + 1}`;
      tx.work_items.put(project, {
        id: `W-${i}`,
        card_id: card,
        title: "合成工作项",
        kind: "produce",
        role_id: "coder",
        required: true,
        depends_on: [],
        completion_criteria: [],
        status: "in_progress",
        assignment_id: `A-${i}`,
      });
      tx.assignments.put(project, {
        id: `A-${i}`,
        scope: "work_item",
        work_item_id: `W-${i}`,
        role_id: "coder",
        role_version: 1,
        status: "active",
        runtime_state: "idle",
        machine_id: "fixture",
        runtime_ref: null,
        mcp_token_id: "fixture-unused",
        created_at: now,
      });
      tx.runs.put(project, {
        id: `R-${i}`,
        assignment_id: `A-${i}`,
        trigger_event_id: "fixture",
        kind: "initial",
        status: "completed",
        role_version: 1,
        model: "fixture",
        agent_cli_version: "fixture",
        started_at: now,
        ended_at: now,
        outcome: "completed",
        summary: "合成执行结果",
      });
    }
  });
  const server = await startWebServer({
    store,
    dataDir,
    log: () => {},
    config: resolveWebConfig({}, { port: 0 }),
  });
  return {
    url: server.url,
    project,
    token: store.createWebSession().token,
    async close() {
      await server.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
