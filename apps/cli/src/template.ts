import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  builtinCardTemplatesForFlow,
  type CardTemplateDefinition,
  latestCardTemplate,
  manageCardTemplate,
  type TemplateChange,
} from "@cardigan/domain";
import { openStore } from "@cardigan/store";
import { parse } from "yaml";
import { CliError, EXIT } from "./errors.js";
import {
  announceDataDir,
  resolveActor,
  resolveProject,
  runCommand,
} from "./host.js";
import type { CliIo } from "./io.js";

const USAGE = [
  "cardigan template list [--project <p>]",
  "cardigan template show <id> [--version <n>]",
  "cardigan template add|update --file <template.yaml>",
  "cardigan template copy <id> <new-id> [--version <n>]",
  "cardigan template deactivate|activate <id>",
  "cardigan template rollback <id> --version <n>",
  "通用：--project <p>、--data-dir <目录>；show 不指定版本时列出当前内容及版本历史。",
].join("\n");
export async function runTemplateCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  const [action, ...rest] = args;
  const positions: string[] = [],
    flags: Record<string, string> = {};
  function fail(message: string): never {
    throw new CliError(message, EXIT.usage, [USAGE]);
  }
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] as string;
    if (!token.startsWith("--")) {
      positions.push(token);
      continue;
    }
    const name = token.slice(2),
      value = rest[++i];
    if (
      !["project", "data-dir", "version", "file"].includes(name) ||
      flags[name] !== undefined ||
      !value?.trim() ||
      value.startsWith("--")
    )
      fail(`不合法的参数：${token}`);
    flags[name] = value;
  }
  const version =
    flags.version === undefined ? undefined : Number(flags.version);
  if (version !== undefined && (!Number.isSafeInteger(version) || version < 1))
    fail("版本必须是正整数");
  if (
    ![
      "list",
      "show",
      "add",
      "copy",
      "update",
      "deactivate",
      "activate",
      "rollback",
    ].includes(action ?? "")
  )
    fail("不认识的模板命令");
  const expected =
    action === "copy"
      ? 2
      : ["list", "add", "update"].includes(action ?? "")
        ? 0
        : 1;
  if (positions.length !== expected) fail("模板参数数量不正确");
  let change: TemplateChange | undefined;
  if (action === "add" || action === "update") {
    if (!flags.file) fail("需要 --file YAML 文件");
    let definition: unknown;
    try {
      definition = parse(await readFile(resolve(io.cwd, flags.file), "utf8"));
    } catch {
      fail("无法读取或解析模板 YAML 文件");
    }
    if (
      !definition ||
      typeof definition !== "object" ||
      Array.isArray(definition)
    )
      fail("模板必须是 YAML 对象");
    change = { action, definition: definition as CardTemplateDefinition };
  } else if (action === "copy")
    change = {
      action,
      template_id: positions[0] as string,
      new_id: positions[1] as string,
      ...(version === undefined ? {} : { version }),
    };
  else if (action === "rollback") {
    if (version === undefined) fail("回退需要 --version");
    change = { action, template_id: positions[0] as string, version };
  } else if (action === "activate" || action === "deactivate")
    change = { action, template_id: positions[0] as string };
  const store = openStore({ dataDir: announceDataDir(io, flags["data-dir"]) });
  try {
    const project = resolveProject(store, io, flags.project);
    if (change) {
      const params = change;
      const template = runCommand(store, {
        operation: {
          add: "创建模板",
          update: "更新模板",
          copy: "复制模板",
          deactivate: "停用模板",
          activate: "启用模板",
          rollback: "回退模板",
        }[params.action],
        target:
          "definition" in params
            ? (params.definition.id ?? (flags.file as string))
            : params.template_id,
        project_id: project,
        actor: resolveActor(io, project, store),
        reduce: (s, a, p) => manageCardTemplate(s, a, params, p),
      });
      io.stdout(
        `已保存模板 ${template.id} v${template.version}（${template.status === "active" ? "启用" : "停用"}）`,
      );
    } else {
      const templates = store.uow
        .read((tx) => [
          ...tx.card_templates.list(project),
          ...builtinCardTemplatesForFlow(
            tx.project_preferences.get(project, project)?.flow_version,
          ),
        ])
        .filter(
          (t, index, all) =>
            all.findIndex((v) => v.id === t.id && v.version === t.version) ===
            index,
        );
      if (action === "list") {
        for (const id of [...new Set(templates.map((t) => t.id))].sort()) {
          const t = latestCardTemplate(templates, id);
          if (t)
            io.stdout(
              `${t.id} v${t.version} ${t.status === "active" ? "启用" : "停用"}${t.builtin ? " 内置" : ""} — ${t.title}`,
            );
        }
      } else {
        const t =
          version === undefined
            ? latestCardTemplate(templates, positions[0] as string)
            : templates.find(
                (t) => t.id === positions[0] && t.version === version,
              );
        if (!t) fail("模板版本不存在");
        io.stdout(
          JSON.stringify(
            {
              ...t,
              history: templates
                .filter((v) => v.id === t.id)
                .map((v) => v.version)
                .sort((a, b) => a - b),
            },
            null,
            2,
          ),
        );
      }
    }
    return EXIT.ok;
  } finally {
    store.close();
  }
}
