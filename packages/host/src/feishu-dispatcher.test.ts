import { EventEmitter } from "node:events";
import { WSClient } from "@larksuiteoapi/node-sdk";
import { expect, test, vi } from "vitest";
import { feishuDispatcher } from "./feishu-dispatcher.js";
import { privateSdkLogger } from "./feishu-sdk.js";

test("pinned WS event frame dispatches card.action.trigger and serializes its response without a listener", async () => {
  const receive = vi.fn(() => ({ toast: { type: "info", content: "处理中" } }));
  const dispatcher = feishuDispatcher(receive);
  const ws = new WSClient({
    appId: "fixture-app",
    appSecret: "fixture",
    logger: privateSdkLogger,
  });
  // Replace only the socket boundary. Exercise the installed SDK's WS frame handler,
  // fragment assembler, event dispatcher, and response encoding together, offline.
  const frame = ws as unknown as {
    eventDispatcher: typeof dispatcher;
    handleEventData(f: unknown): Promise<void>;
    sendMessage(f: { payload: Uint8Array }): void;
  };
  frame.eventDispatcher = dispatcher;
  const sent = vi.spyOn(frame, "sendMessage").mockImplementation(() => {});
  try {
    await frame.handleEventData({
      headers: Object.entries({
        type: "event",
        message_id: "m",
        sum: "1",
        seq: "0",
      }).map(([key, value]) => ({ key, value })),
      payload: Buffer.from(
        JSON.stringify({
          schema: "2.0",
          header: {
            event_type: "card.action.trigger",
            event_id: "e",
            app_id: "fixture-app",
            tenant_key: "t",
          },
          event: {
            operator: { open_id: "person" },
            context: { open_message_id: "msg" },
            action: { value: { ref: "r" } },
          },
        }),
      ),
    });
    expect(receive).toHaveBeenCalledWith(
      "action",
      expect.objectContaining({
        event_id: "e",
        app_id: "fixture-app",
        operator: { open_id: "person" },
      }),
    );
    const reply = JSON.parse(
      Buffer.from(sent.mock.calls[0]![0].payload).toString(),
    );
    expect(JSON.parse(Buffer.from(reply.data, "base64").toString())).toEqual(
      receive.mock.results[0]?.value,
    );
  } finally {
    ws.close({ force: true });
  }
});

test("the SDK reconnects after close and stops reconnecting at shutdown (offline socket)", async () => {
  vi.useFakeTimers();
  const connected = vi.fn(),
    reconnecting = vi.fn();
  const ws = new WSClient({
    appId: "cli_0000000000000000",
    appSecret: "fixture",
    logger: privateSdkLogger,
    autoReconnect: true,
    onReconnecting: reconnecting,
    onReconnected: connected,
  });
  const internal = ws as unknown as {
    wsConfig: { updateWs(v: unknown): void; setWSInstance(s: unknown): void };
    pullConnectConfig(): Promise<{ ok: true }>;
    connect(): Promise<boolean>;
  };
  const fakeSocket = () =>
    Object.assign(new EventEmitter(), {
      readyState: 1,
      terminate: vi.fn(),
      close: vi.fn(),
    });
  let socket = fakeSocket();
  internal.wsConfig.updateWs({ reconnectNonce: 0, reconnectInterval: 1 });
  vi.spyOn(internal, "pullConnectConfig").mockResolvedValue({ ok: true });
  const connect = vi.spyOn(internal, "connect").mockImplementation(async () => {
    socket = fakeSocket();
    internal.wsConfig.setWSInstance(socket);
    return true;
  });
  try {
    await ws.start({ eventDispatcher: feishuDispatcher(() => undefined) });
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.getConnectionStatus().state).toBe("connected");
    socket.emit("close");
    expect(reconnecting).toHaveBeenCalledTimes(1);
    expect(ws.getConnectionStatus().state).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(10);
    expect(connected).toHaveBeenCalledTimes(1);
    expect(ws.getConnectionStatus().state).toBe("connected");
    ws.close({ force: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(ws.getConnectionStatus().state).toBe("idle");
  } finally {
    ws.close({ force: true });
    vi.useRealTimers();
  }
});
