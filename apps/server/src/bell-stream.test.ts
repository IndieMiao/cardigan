import { acknowledgeRun, postComment } from "@cardigan/domain";
import {
  authenticate,
  createMcpServer,
  getUpdatesTool,
  unwrap,
} from "@cardigan/mcp-server";
import { recordNotification } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, onTestFinished, test, vi } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { Dispatcher } from "./dispatch.js";

// Follow the actual delivered address through MCP. Receiving a bell, or reading
// some other stream successfully, is not evidence that the original event was read.
test.each([
  ["card", false],
  ["card", true],
  ["project", false],
  ["project", true],
] as const)(
  "%s notification: read and receipt the original event (first write refused=%s)",
  async (stream, refuseFirst) => {
    const f = recoveryFixture();
    onTestFinished(f.close);
    const pm = f.pm();
    f.session(pm);
    f.skipEvents();
    const owner = stream === "card" ? pm : f.target.assignment;
    const { card } = f.target;
    const source =
      stream === "card"
        ? f.apply((s, a, p) =>
            postComment(
              s,
              a,
              {
                card_id: card.id,
                body: "Please check this card",
                mentions: [pm.id],
              },
              p,
            ),
          ).event_seq
        : f.store.uow.run((tx) => {
            const id = tx.ids.nextEventId(),
              seq = tx.ids.nextEventSequence(f.project);
            tx.events.append(f.project, {
              id,
              seq,
              type: "fixture_notice",
              actor: { kind: "system", project_id: f.project },
              created_at: f.clock.now(),
              payload: {},
            });
            recordNotification(f.store.database, {
              project_id: f.project,
              event_id: id,
              seq,
              recipient: { kind: "assignment", assignment_id: owner.id },
              kind: "instruction",
              at: f.clock.now(),
            });
            return seq;
          });
    const sourceEvent = f
      .state()
      .events.find(
        (e) =>
          e.card_id === (stream === "card" ? card.id : undefined) &&
          e.seq === source,
      );
    if (!sourceEvent) throw Error("Missing source event");
    let refuse = refuseFirst;
    const writes: string[] = [];
    vi.mocked(f.runtime.wake).mockImplementation(async (ref, text, gates) => {
      const addressed = ref.terminal_ref === f.refFor(owner).terminal_ref;
      if (addressed && refuse) {
        refuse = false;
        return { ok: true, value: { sent: false, withdrawn: true } };
      }
      if (!gates?.before_send?.())
        return { ok: true, value: { sent: false, withdrawn: true } };
      if (addressed) writes.push(text);
      return { ok: true, value: { sent: true } };
    });
    await new Dispatcher(f.options).tick();
    await new Dispatcher(f.options).tick();
    expect(writes).toHaveLength(1);
    const note = f.store
      .listNotifications({ project_id: f.project, assignment_id: owner.id })
      .find((n) => n.event_id === sourceEvent.id);
    if (!note?.run_id) throw Error("Original notification not settled");
    const id = note.run_id;
    expect(note.status).toBe("belled");
    f.apply(
      (s, a, p) => acknowledgeRun(s, a, { run_id: id }, p),
      f.actorFor(owner),
    );
    const token = f.store.issueToken({
      project_id: f.project,
      assignment_id: owner.id,
      role: {
        role_version: owner.role_version,
        allowed_tools: ["get_updates"],
      },
    }).token;
    const server = createMcpServer({
      store: f.store,
      identity: unwrap(authenticate(f.store, token)),
      tools: [getUpdatesTool],
      log: () => {},
    });
    const client = new Client({ name: "bell-reader", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(left);
    await client.connect(right);
    try {
      const read = async (args: { card_id?: string }) => {
        const result = await client.callTool({
          name: "get_updates",
          arguments: args,
        });
        expect(result.isError).not.toBe(true);
        return result.structuredContent?.events;
      };
      const receipt = () =>
        f.store.uow.read(
          (tx) => tx.runs.get(f.project, id)?.bell_delivery?.received_at,
        );
      const event = expect.objectContaining({ id: sourceEvent.id });
      expect(
        await read(stream === "card" ? {} : { card_id: card.id }),
      ).not.toContainEqual(event);
      expect(receipt()).toBeUndefined();
      const address = /^\[bell\] (card|project)=(\S+)/.exec(writes[0] ?? "");
      if (!address?.[2]) throw Error("Missing bell address");
      expect(
        await read(address[1] === "card" ? { card_id: address[2] } : {}),
      ).toContainEqual(event);
      expect(receipt()).toBeDefined();
      expect(address.slice(1)).toEqual([
        stream,
        stream === "card" ? card.id : f.project,
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  },
);
