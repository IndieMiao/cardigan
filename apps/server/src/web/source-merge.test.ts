import {
  type Decision,
  mergeRequiresHuman,
  recordDecision,
  requestDecision,
  updateCard,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import type { CardDetail, NeedsPage } from "../../../web/src/api.js";
import { m5Cross, TEST_PASSWORD } from "../../test-support/m5-cross.js";

test("C-311: MCP proposes only; authenticated HTTP confirms atomically and Store retains the audit", async () => {
  const f = await m5Cross();
  try {
    await f.password(TEST_PASSWORD);
    await f.login();
    const product = await f.deliver(
      f.primary,
      await f.change(f.primary.owner, "label.txt", "label only\n"),
    );
    await f.review(f.primary.verifier, product);
    await f.complete(product);
    const source = f.command((s, a, p) =>
      requestDecision(
        s,
        a,
        {
          category: "credential",
          kind: "choose",
          question: "轮换账号",
          context: "合成来源",
          options: [{ key: "yes", description: "同意", impact: "轮换账号" }],
          recommended: "yes",
          affected_cards: [],
          affected_work_items: [],
          blocking: false,
          decider: "human",
          plain_summary: {
            changed: "轮换账号",
            impact: "旧账号停用",
            risk: "涉及凭据",
          },
        },
        p,
      ),
    );
    f.command((s, a, p) =>
      recordDecision(
        s,
        a,
        {
          decision_id: source.id,
          option: "yes",
          rationale: "同意",
          raw_quote: "同意",
        },
        p,
      ),
    );
    // Isolated synthetic card source; no real project data or credentials.
    f.command((s) => ({
      ok: true,
      value: {
        data: null,
        changes: s.cards
          .filter((c) => c.id === f.card.id)
          .map((c) => ({
            collection: "cards" as const,
            entity: {
              ...c,
              source: { kind: "decision" as const, decision_id: source.id },
            },
          })),
        events: [],
        timeline: [],
        token_requests: [],
      },
    }));
    const q = f
      .state()
      .decisions.findLast((q) => q.trigger === "merge_confirmation");
    const ops = f
      .state()
      .assignments.find(
        (a) => a.scope === "standing" && a.standing_mode === "ops",
      );
    const office = f
      .state()
      .assignments.find(
        (a) => a.scope === "standing" && a.standing_mode === "office",
      );
    if (!q || !ops || !office) throw new Error("Missing fixture actors");
    await f.start(ops);
    await f.start(office);
    const args = {
      decision_id: q.id,
      option: "merge",
      rationale: "核对来源",
      escalate: true,
      source_unrelated: {
        decision_id: source.id,
        rationale: "只改标签，不使用账号",
      },
    };
    for (const extra of [
      { confirmed_by: "human" },
      { merge_related: false },
      { via: "needs_you" },
    ]) {
      expect(
        (
          await f.raw(ops, "resolve_delegated_decision", {
            ...args,
            source_unrelated: { ...args.source_unrelated, ...extra },
          })
        ).isError,
      ).toBe(true);
    }
    expect(
      (await f.raw(office, "resolve_delegated_decision", args)).isError,
    ).toBe(true);
    const proposed = await f.mcp<Decision>(
      ops,
      "resolve_delegated_decision",
      args,
    );
    expect(proposed.resolution).toBeUndefined();
    expect(mergeRequiresHuman(f.state(), q)).toBe(true);
    const read = async () => {
      const needs = (await f.call(f.projectPath("/needs-you?section=merges")))
        .json as NeedsPage;
      const shown = [...needs.decisions, ...needs.pm_held_merges].find(
        (d) => d.id === q.id,
      )?.source_unrelated_suggestion;
      expect(shown).toBeDefined();
      expect(shown).not.toHaveProperty("basis");
      expect(shown).not.toHaveProperty("source_basis");
      const detail = (
        await f.call(f.projectPath(`/cards/${f.card.id}?limit=1&type=system`))
      ).json as CardDetail;
      expect(
        detail.merge_confirmations?.find((d) => d.id === q.id)
          ?.source_unrelated_suggestion,
      ).toEqual(shown);
      return shown;
    };
    const shown = await read();
    expect(shown?.stale).toBe(false);
    const path = f.projectPath(`/decisions/${q.id}/source-unrelated`);
    const body = {
      card_id: f.card.id,
      source_decision_id: source.id,
      version: shown?.version,
    };
    expect(
      (
        await f.call(path, {
          method: "POST",
          body,
          anonymous: true,
          headers: { authorization: `Bearer ${f.token(ops)}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await f.call(path, {
          method: "POST",
          body,
          headers: { origin: "https://example.invalid" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.call(path, {
          method: "POST",
          body: { ...body, confirmed_by: "human" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.call(path, {
          method: "POST",
          body: { ...body, card_id: "C-999" },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.raw(ops, "record_decision", {
          decision_id: q.id,
          option: "merge",
          raw_quote: "本人同意来源无关",
          rationale: "本人确认",
          source_unrelated: body,
        })
      ).isError,
    ).toBe(true);
    const before = f.state().events.length;
    const writes = await Promise.all(
      ["confirm-a", "confirm-b"].map((key) =>
        f.call(path, {
          method: "POST",
          body,
          headers: { "idempotency-key": key },
        }),
      ),
    );
    expect(writes.map((r) => r.status)).toEqual([200, 200]);
    const events = f
      .state()
      .events.filter((e) => e.type === "source_merge_unrelated_confirmed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: { kind: "human", project_id: f.project.project_id },
      card_id: f.card.id,
      payload: {
        source_decision_id: source.id,
        rationale: args.source_unrelated.rationale,
      },
    });
    expect(f.state().events.length).toBeGreaterThan(before);
    expect(
      f.state().decisions.find((d) => d.id === q.id)?.resolution,
    ).toBeUndefined();
    expect((await read())?.confirmed?.by).toBe("human");
    const reopened = Store.open({ dataDir: f.dataDir });
    try {
      const state = reopened.uow.read((tx) =>
        loadCommandState(tx, f.project.project_id),
      );
      expect(
        state.events.filter(
          (e) => e.type === "source_merge_unrelated_confirmed",
        ),
      ).toEqual(events);
      expect(mergeRequiresHuman(state, q)).toBe(false);
    } finally {
      reopened.close();
    }
    // A later card revision invalidates the consent and stale UI requests.
    f.command((s, a, p) =>
      updateCard(s, a, { card_id: f.card.id, title: "新内容" }, p),
    );
    expect(mergeRequiresHuman(f.state(), q)).toBe(true);
    expect((await read())?.stale).toBe(true);
    expect(
      (
        await f.call(path, {
          method: "POST",
          body,
          headers: { "idempotency-key": "after-revision" },
        })
      ).status,
    ).toBe(409);
    expect(
      f
        .state()
        .events.filter((e) => e.type === "source_merge_unrelated_confirmed"),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});
