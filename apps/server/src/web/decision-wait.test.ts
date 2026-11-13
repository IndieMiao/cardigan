import { requestDecision } from "@cardigan/domain";
import { startMcpServer } from "@cardigan/mcp-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "vitest";
import { m5Cross, TEST_PASSWORD } from "../../test-support/m5-cross.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

test("Web and MCP report the same project Decision request time and elapsed wait", async () => {
  const f = await m5Cross();
  const mcp = await startMcpServer({
    store: f.store(),
    port: 0,
    clock: { now: () => new Date(f.now()).toISOString() },
    log: () => {},
    deliveryVerifier: () => {
      throw new Error("This fixture only reads decisions");
    },
  });
  const client = new Client({ name: "decision-wait", version: "1" });
  try {
    const office = f
      .state()
      .assignments.find(
        (a) => a.scope === "standing" && a.standing_mode === "office",
      );
    if (!office) throw new Error("Missing PM Office");
    await f.start(office);
    const q = f.command((state, actor, ports) =>
      requestDecision(
        state,
        actor,
        {
          kind: "choose",
          category: "scope_change",
          question: "Project direction",
          context: "Choose next phase",
          options: [{ key: "go", description: "Go", impact: "Proceed" }],
          recommended: "go",
          decider: "human",
          plain_summary: TEST_PLAIN_SUMMARY,
          blocking: false,
          affected_cards: [],
          affected_work_items: [],
        },
        ports,
      ),
    );
    const event = f
      .state()
      .events.find(
        (e) =>
          e.type === "decision_requested" &&
          typeof e.payload === "object" &&
          e.payload !== null &&
          "decision_id" in e.payload &&
          e.payload.decision_id === q.id,
      );
    if (!event) throw new Error("Missing request event");
    expect(event.card_id).toBeUndefined();
    expect(f.state().timeline.some((e) => e.decision_id === q.id)).toBe(false);
    f.setTime(Date.parse(event.created_at) + 90000);
    await f.password(TEST_PASSWORD);
    await f.login();
    const web = await f.call(f.projectPath("/needs-you"));
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcp.url), {
        requestInit: {
          headers: { authorization: `Bearer ${f.token(office)}` },
        },
      }),
    );
    const result = await client.callTool({
      name: "list_needs_you",
      arguments: {},
    });
    expect(web.status).toBe(200);
    expect(result.isError).not.toBe(true);
    for (const body of [web.json, result.structuredContent])
      expect(body).toMatchObject({
        decisions: [
          { id: q.id, opened_at: event.created_at, waited_ms: 90000 },
        ],
      });
  } finally {
    await client.close();
    await mcp.close();
    await f.close();
  }
});
