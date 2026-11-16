import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test, vi } from "vitest";
import { startMcpServer } from "./server.js";
import {
  acceptingVerifierFor,
  project_id,
  seedProject,
} from "./test-support.js";

test("probe tools remain token-scoped; malformed and rejected calls are audited without their parameters", async () => {
  const store = Store.open({ dbPath: ":memory:" });
  const { assignment } = seedProject(store, {
    allowed_tools: ["run_probe", "whoami"],
  });
  const token = (allowed_tools: ("run_probe" | "whoami")[]) =>
    store.issueToken({
      project_id,
      assignment_id: assignment.id,
      role: { role_version: 1, allowed_tools },
    }).token;
  const old = token(["whoami"]),
    current = token(["whoami", "run_probe"]);
  const execute = vi.fn(async (context, _input) => ({
    assignment: context.identity.actor.assignment_id,
    status: "queued",
  }));
  const audit = vi.fn();
  const server = await startMcpServer({
    store,
    deliveryVerifier: acceptingVerifierFor,
    port: 0,
    probeHost: { execute },
    auditProbeCall: audit,
    acknowledgeRuns: false,
    log: () => {},
  });
  const clients: Client[] = [];
  const connect = async (secret: string) => {
    const c = new Client({ name: "probe-test", version: "1" });
    clients.push(c);
    await c.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${secret}` } },
      }),
    );
    return c;
  };
  try {
    const a = await connect(old);
    expect((await a.listTools()).tools.map((t) => t.name)).not.toContain(
      "run_probe",
    );
    expect(
      (
        await a.callTool({
          name: "run_probe",
          arguments: {
            probe: "config",
            operation: "smoke",
            idempotency_key: "one",
          },
        })
      ).isError,
    ).toBe(true);
    const b = await connect(current);
    const input = {
      probe: "github",
      operation: "smoke",
      idempotency_key: "two",
    };
    for (const patch of [
      { command: "secret" },
      { path: "/private" },
      { assignment_id: "A-2" },
      { sha: "a".repeat(40) },
      { branch: "main" },
      { operation: "push" },
      { parameters: { run_id: 123 } },
      { probe: "model" },
    ])
      expect(
        (
          await b.callTool({
            name: "run_probe",
            arguments: { ...input, ...patch },
          })
        ).isError,
      ).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(
      (await b.callTool({ name: "run_probe", arguments: input })).isError,
    ).not.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].identity.actor.assignment_id).toBe(
      assignment.id,
    );
    expect(audit).toHaveBeenCalledTimes(10);
    expect(audit.mock.calls.map((c) => c[1])).toContain("forbidden_tool");
    expect(audit.mock.calls.map((c) => c[1])).toContain("validation_failed");
    expect(audit.mock.calls.map((c) => c[1])).toContain("ok");
    expect(JSON.stringify(audit.mock.calls)).not.toContain("/private");
    execute.mockRejectedValueOnce(new Error("SECRET /private/provider.pem"));
    const failed = await b.callTool({ name: "run_probe", arguments: input });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain("SECRET");
    expect(JSON.stringify(failed)).not.toContain("provider.pem");
  } finally {
    for (const c of clients) await c.close();
    await server.close();
    store.close();
  }
});
