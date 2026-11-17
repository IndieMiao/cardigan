import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommandEffect,
  type Repository,
  setProjectPreferences,
  updateWorkItem,
} from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { independentReviewLimitFixture } from "../../domain/src/commands/independent-review-limit/test-fixtures.js";
import { human, value } from "../../domain/src/commands/test-fixtures.js";
import { authenticate } from "./auth.js";
import { loadCommandState, persistEffect } from "./commands/execute.js";
import { managementTools } from "./commands/management-tools.js";

test.each(["revoke-first", "resolve-first", "rollback"] as const)(
  "independent grants use fresh serialized transactions, keep audit atomic and survive restart: %s",
  async (order) => {
    const t = independentReviewLimitFixture();
    await t.limited();
    const project = t.f.state.project_id;
    const dir = mkdtempSync(join(tmpdir(), "review-limit-transaction-"));
    let first = Store.open({ dataDir: dir });
    const second = Store.open({ dataDir: dir });
    try {
      first.createProject({ id: project });
      first.uow.run((tx) => {
        for (const collection of [
          "project_preferences",
          "card_templates",
          "cards",
          "work_items",
          "assignments",
          "runs",
          "deliveries",
          "reviews",
          "decisions",
          "human_actions",
          "attachments",
          "cursors",
          "roles",
          "timeline",
        ] as const)
          for (const entity of t.f.state[collection] ?? [])
            (tx[collection] as Repository<typeof entity, never>).put(
              project,
              entity,
            );
        for (const e of t.f.state.events) {
          tx.ids.nextEventSequence(project, e.card_id);
          tx.events.append(project, e);
        }
      });
      const read = (store: Store) =>
        store.uow.read((tx) => loadCommandState(tx, project));
      // Prime both caches before the competing connection commits.
      expect(read(first)).toEqual(read(second));
      const change = (store: Store, enabled: boolean) =>
        store.uow.run((tx) => {
          const effect = value(
            setProjectPreferences(
              loadCommandState(tx, project),
              human,
              { independent_review_limit_delegation: enabled },
              t.f.io,
            ),
          );
          persistEffect(tx, project, effect);
        });
      const resolve = (store: Store, abort = false) =>
        store.uow.run((tx) => {
          const result = updateWorkItem(
            loadCommandState(tx, project),
            t.pm,
            {
              work_item_id: t.item.id,
              review_limit_decision: {
                decision_id: t.decision().id,
                option: "raise_limit",
                rationale: "New version",
              },
            },
            t.f.io,
          );
          if (result.ok)
            persistEffect(tx, project, result.value as CommandEffect<unknown>);
          if (abort) throw new Error("abort after audit");
          return result;
        });
      if (order === "rollback") {
        const before = read(first);
        expect(() => resolve(first, true)).toThrow("abort after audit");
        expect(read(second)).toEqual(before);
        expect(resolve(second).ok).toBe(true);
      } else if (order === "revoke-first") {
        change(first, false);
        expect(resolve(second).ok).toBe(true);
      } else {
        const tool = managementTools(t.f.io.clock).find(
          (tool) => tool.name === "update_work_item",
        );
        if (!tool || t.pm.kind !== "assignment")
          throw new Error("Missing Ops tool");
        const token = first.issueToken({
          project_id: project,
          assignment_id: t.pm.assignment_id,
          role: { role_version: 1, allowed_tools: ["update_work_item"] },
        }).token;
        const context = {
          store: first,
          identity: value(authenticate(first, token)),
        };
        const args = {
          idempotency_key: "grant",
          work_item_id: t.item.id,
          review_limit_decision: {
            decision_id: t.decision().id,
            option: "raise_limit",
            rationale: "New version",
          },
        };
        const result = await tool.handler(tool.input.parse(args), context);
        expect(result).toMatchObject({ max_review_rounds: 2 });
        expect(await tool.handler(tool.input.parse(args), context)).toEqual(
          result,
        );
        expect(() =>
          tool.handler(
            tool.input.parse({ ...args, idempotency_key: "duplicate" }),
            context,
          ),
        ).toThrow();
        change(second, false);
      }
      change(second, true);
      expect(resolve(first).ok).toBe(false);
      first.close();
      first = Store.open({ dataDir: dir });
      const persisted = read(first);
      const granted = 1;
      expect(
        persisted.decisions.filter(
          (q) =>
            q.resolution?.via === "delegated" &&
            q.resolution.option === "raise_limit",
        ),
      ).toHaveLength(granted);
      expect(
        persisted.events.filter(
          (e) =>
            e.type === "decision_resolved" && e.payload.via === "delegated",
        ),
      ).toHaveLength(granted);
      expect(
        persisted.work_items.find((w) => w.id === t.item.id),
      ).toMatchObject({ max_review_rounds: 1 + granted });
      expect(resolve(first).ok).toBe(false);
    } finally {
      first.close();
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
