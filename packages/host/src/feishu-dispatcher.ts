import { feishuSdk, privateSdkLogger } from "./feishu-sdk.js";
export function feishuDispatcher(
  receive: (kind: "binding" | "action", event: unknown) => unknown,
) {
  const { EventDispatcher } = feishuSdk();
  return new EventDispatcher({ logger: privateSdkLogger }).register({
    "im.message.receive_v1": async (event) => receive("binding", event),
    "card.action.trigger": async (event: unknown) => receive("action", event),
  });
}
