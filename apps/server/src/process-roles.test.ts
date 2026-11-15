import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test, vi } from "vitest";

type Message = { type: string; role?: string; url?: string; web_url?: string };
function child(role: "web" | "background", dataDir: string, mcp = 0, web = 0) {
  const processChild = spawn(
    process.execPath,
    [
      new URL("../test-support/process-role-child.mjs", import.meta.url)
        .pathname,
      role,
      dataDir,
      String(mcp),
      String(web),
    ],
    {
      env: {
        PATH: process.env.PATH,
        NODE_OPTIONS: process.env.NODE_OPTIONS,
        CARDIGAN_CONFIG_DIR: dataDir,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const messages: Message[] = [];
  processChild.on("message", (message) => messages.push(message as Message));
  const exited = new Promise<number | null>((resolve) =>
    processChild.once("exit", resolve),
  );
  return { process: processChild, messages, exited };
}
async function message(target: ReturnType<typeof child>, type: string) {
  await vi.waitFor(() =>
    expect(target.messages.some((m) => m.type === type)).toBe(true),
  );
  return target.messages.find((m) => m.type === type) as Message;
}
function data(result: unknown) {
  return JSON.parse(
    (result as { content: { text: string }[] }).content[0]?.text ?? "{}",
  );
}

test.runIf(process.platform === "linux")(
  "real role processes: one loop owner, external-IO drain, SSE/MCP catch-up, auth and restart",
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cg-role-processes-"));
    const store = Store.open({ dataDir });
    const children: ChildProcess[] = [];
    const client = new Client({ name: "role-fixture", version: "1" });
    let stream: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const abort = new AbortController();
    try {
      store.createProject({ id: "fixture" });
      store.createProject({ id: "other" });
      store.setWebPassword("synthetic password");
      writeFileSync(
        join(dataDir, "index.html"),
        "<html>synthetic fixture</html>",
      );
      store.uow.run((tx) => {
        tx.cards.put("fixture", {
          id: "C-2",
          project_id: "fixture",
          title: "Outside token scope",
          goal: "",
          acceptance_criteria: [],
          source: { kind: "quote", text: "synthetic" },
          out_of_scope: [],
          related_cards: [],
          priority: 1,
          status: "todo",
          template: "dev",
          created_by: "human",
          created_at: new Date().toISOString(),
        });
        tx.roles.put("fixture", {
          role_id: "coder",
          role_version: 1,
          allowed_tools: ["get_updates"],
          capabilities: [],
        });
        tx.assignments.put("fixture", {
          id: "A-1",
          scope: "work_item",
          work_item_id: "W-1",
          role_id: "coder",
          role_version: 1,
          status: "active",
          runtime_state: "not_provisioned",
          machine_id: "local",
          runtime_ref: null,
          mcp_token_id: "fixture",
          created_at: new Date().toISOString(),
        });
      });
      const token = store.issueToken({
        project_id: "fixture",
        assignment_id: "A-1",
        role: { role_version: 1, allowed_tools: ["get_updates"] },
      }).token;
      const web = child("web", dataDir);
      children.push(web.process);
      const ready = await message(web, "ready");
      const webUrl = ready.web_url as string;
      const mcpPort = Number(new URL(ready.url as string).port);
      const webPort = Number(new URL(webUrl).port);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(ready.url as string), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      expect(
        (await fetch(`${webUrl}/api/projects/fixture/stream`)).status,
      ).toBe(401);
      const login = await fetch(`${webUrl}/api/login`, {
        method: "POST",
        headers: { origin: webUrl, "content-type": "application/json" },
        body: JSON.stringify({ password: "synthetic password" }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie")?.split(";")[0] as string;
      const response = await fetch(
        `${webUrl}/api/projects/fixture/stream?after=project:0`,
        { headers: { cookie }, signal: abort.signal },
      );
      expect(response.status).toBe(200);
      stream = response.body?.getReader();
      let frames = "";
      const reading = (async () => {
        try {
          while (stream) {
            const next = await stream.read();
            if (next.done) break;
            frames += new TextDecoder().decode(next.value);
          }
        } catch {
          /* aborted at cleanup */
        }
      })();
      const background = child("background", dataDir, mcpPort, webPort);
      children.push(background.process);
      await message(background, "ready");
      await message(background, "reconciling");
      // Web never started this loop; background holds external IO without a SQL transaction.
      expect(web.messages.some((m) => m.type === "reconciling")).toBe(false);
      expect((await fetch(`${webUrl}/api/session`)).status).toBe(200);
      expect(
        data(
          await client.callTool({
            name: "get_updates",
            arguments: { since_seq: 0 },
          }),
        ).events,
      ).toEqual([]);
      const duplicate = child("background", dataDir, mcpPort, webPort);
      children.push(duplicate.process);
      await message(duplicate, "failed");
      expect(await duplicate.exited).toBe(1);
      // Stop drains the blocked reconciliation instead of releasing its ownership early.
      background.process.send("stop");
      await message(background, "stopping");
      expect(background.process.exitCode).toBeNull();
      background.process.send("release");
      expect(await background.exited).toBe(0);
      await vi.waitFor(() =>
        expect(frames).toContain('"type":"reconcile_finding"'),
      );
      expect(frames.match(/"type":"reconcile_finding"/g)).toHaveLength(1);
      const updates = data(
        await client.callTool({
          name: "get_updates",
          arguments: { since_seq: 0 },
        }),
      );
      expect(updates.events).toHaveLength(1);
      expect(updates.events[0].actor.project_id).toBe("fixture");
      const forbidden = await client.callTool({
        name: "get_updates",
        arguments: { card_id: "C-2", since_seq: 0 },
      });
      expect(forbidden.isError).toBe(true);
      // A new owner starts only after the old owner's drained exit releases flock.
      const replacement = child("background", dataDir, mcpPort, webPort);
      children.push(replacement.process);
      await message(replacement, "ready");
      await message(replacement, "reconciling");
      replacement.process.send("release");
      replacement.process.send("stop");
      expect(await replacement.exited).toBe(0);
      const after = data(
        await client.callTool({
          name: "get_updates",
          arguments: { since_seq: updates.latest_seq },
        }),
      );
      expect(after.events).toEqual([]); // Same durable finding is not published twice on restart.
      abort.abort();
      await reading;
      await client.close();
      web.process.send("stop");
      expect(await web.exited).toBe(0);
    } finally {
      abort.abort();
      await stream?.cancel().catch(() => {});
      await client.close();
      for (const processChild of children)
        if (processChild.exitCode === null && processChild.signalCode === null)
          processChild.kill("SIGKILL");
      await Promise.all(
        children.map((processChild) =>
          processChild.exitCode !== null || processChild.signalCode !== null
            ? Promise.resolve()
            : new Promise((resolve) => processChild.once("exit", resolve)),
        ),
      );
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
  15000,
);
