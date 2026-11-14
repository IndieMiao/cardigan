import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ExtMessageAdapters,
  extMessageAdapters,
  loadExtMessageConfig,
  sendExtMessage,
} from "@cardigan/host";
import { listExtMessages, openStore } from "@cardigan/store";
import { CliError, EXIT } from "./errors.js";
import { announceDataDir, hasToken } from "./host.js";
import type { CliIo } from "./io.js";

export async function runExtMessageCommand(
  argv: readonly string[],
  io: CliIo,
  adapters: ExtMessageAdapters = extMessageAdapters,
): Promise<number> {
  if (hasToken(io))
    throw new CliError("此命令仅限人类操作，Token 模式不可用。", EXIT.usage);
  const [command, ...args] = argv;
  if (command !== "status" && command !== "test")
    throw new CliError(
      "用法：cardigan ext-message status | test --channel <名>",
      EXIT.usage,
    );
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i]?.startsWith("--") ? args[i]?.slice(2) : undefined;
    const value = args[++i];
    if (
      !name ||
      !["data-dir", "channel"].includes(name) ||
      !value ||
      value.startsWith("--")
    )
      throw new CliError("外部通知参数无效", EXIT.usage);
    flags[name] = value;
  }
  if (command === "test") {
    const path = join(
      io.env.CARDIGAN_CONFIG_DIR ??
        join(io.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "cardigan"),
      "ext-message.yaml",
    );
    const c = loadExtMessageConfig(path);
    const name = flags.channel;
    if (
      c.status !== "loaded" ||
      !c.config.enabled ||
      !name ||
      !c.config.channels[name]?.enabled
    )
      throw new CliError("外部通知未启用或配置无效", EXIT.usage);
    const factory = adapters[name];
    if (!factory) throw new CliError("此渠道适配器尚未安装", EXIT.usage);
    let result: string;
    try {
      result = await sendExtMessage(
        factory(c.config.channels[name]?.credential),
        { title: "Cardigan 外部通知测试", url: c.config.workbench_url },
        c.config.policy.timeout_ms,
      );
    } catch {
      result = "unknown";
    }
    io.stdout(result === "sent" ? "测试消息已发送" : "测试消息未能确认送达");
    return result === "sent" ? EXIT.ok : EXIT.failure;
  }
  const store = openStore({ dataDir: announceDataDir(io, flags["data-dir"]) });
  try {
    const status = store.database
      .prepare("SELECT doc FROM ext_message_host_status WHERE id = 1")
      .get();
    const recent = new Map<string, unknown>();
    for (const r of listExtMessages(store.database))
      recent.set(r.channel, {
        channel: r.channel,
        status: r.status,
        attempts: r.attempts,
        error: r.last_error,
        at: r.updated_at,
      });
    io.stdout(
      JSON.stringify(
        {
          configuration: status
            ? JSON.parse(String(status.doc))
            : { status: "not_loaded" },
          recent: [...recent.values()],
        },
        null,
        2,
      ),
    );
    return EXIT.ok;
  } finally {
    store.close();
  }
}
