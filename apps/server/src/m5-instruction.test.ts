import { createWorkItem, type Event, issueInstruction } from "@cardigan/domain";
import { routeEvent } from "@cardigan/router";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, test } from "vitest";
import { type M4Cross, m4Cross } from "../test-support/m4-cross.js";

let f: M4Cross | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

test("M5.2: only standing Ops sees and calls issue_instruction; replay routes one persisted instruction", async () => {
  const s = await m4Cross();
  f = s;
  const ops = s.state().assignments.find((a) => a.standing_mode === "ops");
  const office = s
    .state()
    .assignments.find((a) => a.standing_mode === "office");
  if (!ops || !office) throw new Error("Missing standing PM");
  for (const a of [office, s.primary.owner, s.pm, ops]) {
    await s.start(a);
    const client = new Client({ name: "instruction", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(s.url()), {
          requestInit: { headers: { Authorization: `Bearer ${s.token(a)}` } },
        }),
      );
      const listed = (await client.listTools()).tools.map((t) => t.name);
      expect(listed.includes("issue_instruction")).toBe(a.id === ops.id);
      const who = (await client.callTool({ name: "whoami", arguments: {} }))
        .structuredContent as { allowed_tools: string[] };
      expect(who.allowed_tools.includes("issue_instruction")).toBe(
        a.id === ops.id,
      );
      const params = {
        name: "issue_instruction",
        arguments: {
          card_id: s.card.id,
          work_item_id: s.primary.owner.work_item_id,
          body: "Please implement this",
          idempotency_key: "instruction-once",
        },
      };
      const result = await client.callTool(params);
      if (a.id !== ops.id)
        expect(result.structuredContent).toMatchObject({
          error: { code: "forbidden_tool" },
        });
      else {
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          type: "instruction",
          author: `assignment:${ops.id}`,
        });
        expect((await client.callTool(params)).structuredContent).toEqual(
          result.structuredContent,
        );
        expect(
          (
            await client.callTool({
              name: "issue_instruction",
              arguments: { body: "Missing target", idempotency_key: "invalid" },
            })
          ).structuredContent,
        ).toMatchObject({ error: { code: "validation_failed" } });
      }
    } finally {
      await client.close();
    }
  }
  const events = s
    .state()
    .events.filter((e) => e.type === "instruction_issued");
  expect(events).toHaveLength(1);
  expect(
    routeEvent({ event: events[0] as Event, snapshot: s.state() })
      .notifications,
  ).toContainEqual(
    expect.objectContaining({
      recipient: { kind: "assignment", assignment_id: s.primary.owner.id },
    }),
  );
  const unassigned = s.command((state, actor, ports) =>
    createWorkItem(
      state,
      actor,
      {
        card_id: s.card.id,
        title: "New work",
        kind: "produce",
        role_id: "coder",
        required: false,
        completion_criteria: [],
      },
      ports,
    ),
  );
  s.command((state, actor, ports) =>
    issueInstruction(
      state,
      actor,
      {
        card_id: s.card.id,
        work_item_id: unassigned.id,
        body: "Please allocate",
      },
      ports,
    ),
  );
  const last = s
    .state()
    .events.filter((e) => e.type === "instruction_issued")
    .at(-1) as Event;
  expect(
    routeEvent({ event: last, snapshot: s.state() }).notifications,
  ).toContainEqual(expect.objectContaining({ recipient: { kind: "pm_ops" } }));
});
