import { type CommandState, cardReadAccess } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import {
  SOURCE_SECRET,
  sourceMergeSystemFixture,
} from "../../domain/src/commands/source-merge/test-fixtures.js";
import { authenticate } from "./auth.js";
import { executeCommand } from "./commands/execute.js";
import { getCardTool } from "./tools/get-card.js";
import { getUpdatesTool } from "./tools/get-updates.js";

function seed(store: Store, state: CommandState) {
  const project = state.project_id;
  store.createProject({ id: project });
  store.uow.run((tx) => {
    for (const v of state.cards) tx.cards.put(project, v);
    for (const v of state.work_items) tx.work_items.put(project, v);
    for (const v of state.assignments) tx.assignments.put(project, v);
    for (const v of state.roles) tx.roles.put(project, v);
    for (const v of state.runs) tx.runs.put(project, v);
    for (const v of state.deliveries) tx.deliveries.put(project, v);
    for (const v of state.reviews) tx.reviews.put(project, v);
    for (const v of state.decisions) tx.decisions.put(project, v);
    for (const v of state.project_preferences ?? [])
      tx.project_preferences.put(project, v);
    for (const v of state.timeline) tx.timeline.put(project, v);
    for (const v of state.events) tx.events.append(project, v);
  });
}

test("C-311: sensitive source text never reaches ordinary-card MCP reads, including legacy evidence", async () => {
  const { f, source, q, propose, confirm } = await sourceMergeSystemFixture();
  f.commit(propose());
  for (const phase of ["proposal", "confirmed", "legacy"]) {
    if (phase === "confirmed") f.commit(confirm());
    const store = Store.open({ dbPath: ":memory:" });
    try {
      const state: CommandState =
        phase === "legacy"
          ? {
              ...f.state,
              decisions: f.state.decisions.map((d) =>
                d.id === q.id && d.source_unrelated_suggestion
                  ? {
                      ...d,
                      source_unrelated_suggestion: {
                        ...d.source_unrelated_suggestion,
                        source_basis: SOURCE_SECRET,
                      },
                    }
                  : d,
              ),
              events: f.state.events.map((e) =>
                e.type.startsWith("source_merge_unrelated_")
                  ? {
                      ...e,
                      payload: {
                        ...(e.payload as Record<string, string>),
                        source_basis: SOURCE_SECRET,
                      },
                    }
                  : e,
              ),
            }
          : f.state;
      seed(store, state);
      const issued = store.issueToken({
        project_id: state.project_id,
        assignment_id: f.coder.id,
        role: {
          role_version: f.coder.role_version,
          allowed_tools: ["get_card", "get_updates"],
        },
      });
      const auth = authenticate(store, issued.token);
      if (!auth.ok) throw new Error("Missing fixture identity");
      const context = { store, identity: auth.value };
      expect(
        cardReadAccess({
          project_id: state.project_id,
          assignment: f.coder,
          card: state.cards.find((c) => c.id === source.card_id),
          work_items: state.work_items,
        }),
      ).toBe("summary");
      const restricted = (await getCardTool.handler(
        { card_id: source.card_id },
        context,
      )) as { card: object };
      expect(Object.keys(restricted.card).sort()).toEqual([
        "id",
        "status",
        "title",
      ]);
      for (const result of [
        await getCardTool.handler({ card_id: f.card.id }, context),
        await getUpdatesTool.handler(
          { card_id: f.card.id, since_seq: 0 },
          context,
        ),
      ]) {
        expect(JSON.stringify(result)).not.toContain(SOURCE_SECRET);
        expect(JSON.stringify(result)).not.toContain('"source_basis"');
      }
      // Redaction is a projection: it cannot rewrite stored authorization evidence.
      expect(
        store.uow.read((tx) => tx.decisions.get(state.project_id, q.id))
          ?.source_unrelated_suggestion?.source_basis,
      ).toBe(
        state.decisions.find((d) => d.id === q.id)?.source_unrelated_suggestion
          ?.source_basis,
      );
    } finally {
      store.close();
    }
  }
});

test("C-311: MCP command output and idempotent replay cannot expose old plaintext fingerprints", async () => {
  const { f, q, ops } = await sourceMergeSystemFixture();
  const store = Store.open({ dbPath: ":memory:" });
  try {
    seed(store, f.state);
    const issued = store.issueToken({
      project_id: f.state.project_id,
      assignment_id: ops.id,
      role: {
        role_version: ops.role_version,
        allowed_tools: ["resolve_delegated_decision"],
      },
    });
    const auth = authenticate(store, issued.token);
    if (!auth.ok) throw new Error("Missing identity");
    const context = { store, identity: auth.value };
    const result = {
      ...q,
      source_unrelated_suggestion: { source_basis: SOURCE_SECRET, version: 1 },
    };
    const params = { decision_id: q.id };
    let reductions = 0;
    const call = () =>
      executeCommand(
        context,
        "resolve_delegated_decision",
        "legacy-result",
        params,
        () => {
          reductions++;
          return {
            ok: true,
            value: {
              data: result,
              changes: [],
              events: [],
              timeline: [],
              token_requests: [],
            },
          };
        },
      );
    for (let n = 0; n < 2; n++) {
      const output = call();
      expect(JSON.stringify(output)).not.toContain(SOURCE_SECRET);
      expect(JSON.stringify(output)).not.toContain('"source_basis"');
      expect(output.source_unrelated_suggestion.version).toBe(1);
    }
    expect(reductions).toBe(1);
  } finally {
    store.close();
  }
});
