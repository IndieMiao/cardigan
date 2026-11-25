import type { ExtMessage } from "@cardigan/domain";
import { expired } from "./feishu-inbox.js";
export function feishuCard(
  message: ExtMessage,
  ref: string,
  options: readonly { key: string; label: string }[],
) {
  const text = (content: string) => ({ tag: "plain_text", content });
  const link = (url: string, label: string) => ({
    tag: "button",
    text: text(label),
    behaviors: [{ type: "open_url", default_url: url }],
  });
  const form = {
    tag: "form",
    name: "operation",
    elements: [
      {
        tag: "input",
        name: "note",
        placeholder: text("理由或结果"),
        max_length: 1000,
      },
      ...options.map((o, i) => ({
        tag: "button",
        name: `choice_${i}`,
        text: text(
          Array.from(o.label || o.key)
            .slice(0, 60)
            .join(""),
        ),
        form_action_type: "submit",
        behaviors: [{ type: "callback", value: { ref, key: o.key } }],
      })),
    ],
  };
  return JSON.stringify({
    schema: "2.0",
    config: { update_multi: true, enable_forward: false },
    // C-674: lead with the full number (`SEN-C-34`) so chats spanning projects stay unambiguous.
    header: {
      title: text(
        "ref" in message && message.ref
          ? `${message.ref} ${message.title}`
          : message.title,
      ),
    },
    body: {
      elements: [
        ...(options.length ? [form] : []),
        link(message.url, "在 Workbench 查看"),
      ],
    },
  });
}
export function feishuReceipt(state: string, url: string) {
  return feishuCard(
    {
      url,
      title:
        state === "done"
          ? "已由你处理"
          : state === "held"
            ? "已暂缓"
            : state === "stale"
              ? expired
              : "未完成，请在 Workbench 处理",
    },
    "",
    [],
  );
}
