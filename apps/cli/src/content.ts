import { open } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import {
  type CommandEffect,
  markCardDone,
  parseId,
  parseTimelineEntryId,
  postComment,
  type Result,
  uploadAttachment,
} from "@cardigan/domain";
import {
  attachmentMimeForExtension,
  loadCommandState,
  MAX_ATTACHMENT_BYTES,
  persistEffect,
  prepareAttachmentFile,
  ToolError,
} from "@cardigan/mcp-server";
import { openStore } from "@cardigan/store";
import { CliError, EXIT, formatCommandError } from "./errors.js";
import {
  announceDataDir,
  humanActor,
  resolveProject,
  systemClock,
} from "./host.js";
import type { CliIo } from "./io.js";

const USAGE = [
  "用法：",
  "  cardigan card done <C-n> --result <文字> [--file <证据>]...",
  "  cardigan comment add <C-n> (--text <内容> | --text-file <路径>) [--file <路径>]... [--note <说明>]",
  "  cardigan attachment add <C-n> --file <路径> [--note <说明>] [--kind evidence|artifact] [--basis <q(n)>] [--entry <C-n#k>]",
  "",
  "评论正文二选一，支持 Markdown；--file 可重复，附件均为 evidence。",
  "--note 为本次所有附件的一句话说明，最多 200 字符；文件名自动取本地文件名。",
  "单独上传默认 evidence；artifact 必须带 --basis（拍板编号请加引号）。",
  "省略 --entry 时创建一条“上传附件”评论；指定时挂到当前卡片的已有条目。",
  "附件每个不超过 10 MiB，按扩展名识别：png、jpg/jpeg、gif、webp、avif、svg、html/htm、md/markdown、txt/log、json、pdf。",
  "通用：--project <p> 省略时取 CARDIGAN_PROJECT，再取数据库里唯一的项目；",
  "      --data-dir <路径> 省略时取 CARDIGAN_DATA_DIR，再取 ~/.local/share/cardigan。",
].join("\n");

function usage(message: string): never {
  throw new CliError(message, EXIT.usage, [USAGE]);
}

function parseArgs(command: string, args: readonly string[]) {
  if (args[0] !== (command === "card_done" ? "done" : "add"))
    usage(`用法：cardigan ${command} add ...`);
  const flags: Record<string, string> = {};
  const files: string[] = [],
    positionals: string[] = [];
  const allowed = [
    "project",
    "data-dir",
    "file",
    ...(command === "card_done"
      ? ["result"]
      : command === "comment"
        ? ["text", "text-file", "note"]
        : ["kind", "basis", "entry", "note"]),
  ];
  for (let i = 1; i < args.length; i += 1) {
    const token = args[i] as string;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const separator = token.indexOf("=");
    const name = token.slice(2, separator < 0 ? undefined : separator);
    if (!allowed.includes(name)) usage(`不认识的选项：--${name}`);
    const value = separator < 0 ? args[++i] : token.slice(separator + 1);
    if (value === undefined || (separator < 0 && value.startsWith("--")))
      usage(`--${name} 需要一个值`);
    if (!value.trim()) usage(`--${name} 不能为空`);
    if (name === "file") files.push(value);
    else {
      if (flags[name] !== undefined) usage(`--${name} 不能重复`);
      flags[name] = value;
    }
  }
  if (command === "card_done" && !flags.result?.trim())
    usage("--result 必须填写完成结果");
  const card = parseId("card", positionals[0]);
  if (positionals.length !== 1 || !card.ok)
    usage("请提供一个合法的卡片编号（形如 C-3）");
  if (
    command === "comment" &&
    (flags.text === undefined) === (flags["text-file"] === undefined)
  )
    usage("必须二选一：--text 或 --text-file");
  if (command === "attachment" && files.length !== 1)
    usage("attachment add 必须提供一个 --file；多个文件请用 comment add");
  if (flags.note !== undefined && files.length === 0)
    usage("--note 需要同时提供 --file");
  const kind = flags.kind ?? "evidence";
  if (kind !== "evidence" && kind !== "artifact")
    usage("--kind 只接受 evidence、artifact");
  if (kind === "artifact" && flags.basis === undefined)
    usage("artifact 附件必须提供 --basis 拍板编号");
  const basis =
    flags.basis === undefined ? undefined : parseId("decision", flags.basis);
  if (basis && !basis.ok) usage("--basis 需要合法的拍板编号（形如 q(3)）");
  const entry =
    flags.entry === undefined ? undefined : parseTimelineEntryId(flags.entry);
  if (entry && !entry.ok) usage("--entry 需要合法的条目编号（形如 C-3#2）");
  return {
    cardId: card.value.id,
    flags,
    files,
    kind: kind as "evidence" | "artifact",
    basis: basis?.ok ? basis.value.id : undefined,
    entry: entry?.ok ? entry.value.id : undefined,
  };
}

/** Bound attachment reads before allocating a base64 copy; decode checks again after IO. */
async function readFile(path: string, io: CliIo, attachment: boolean) {
  try {
    const file = await open(resolve(io.cwd, path), "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile())
        throw new CliError(`不是普通文件：${path}`, EXIT.usage);
      if (attachment && stat.size > MAX_ATTACHMENT_BYTES)
        throw new CliError(`附件超过 10 MiB：${path}`, EXIT.usage);
      return await file.readFile();
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      `无法读取文件：${path}，请检查文件是否存在及读取权限`,
      EXIT.usage,
    );
  }
}

export async function runContentCommand(
  command: "comment" | "attachment" | "card_done",
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  const p = parseArgs(command, args);
  const must = <T>(result: Result<T>, operation: string): T => {
    if (result.ok) return result.value;
    throw new CliError(
      formatCommandError(operation, p.cardId, result.error),
      EXIT.usage,
    );
  };
  const dataDir = announceDataDir(io, p.flags["data-dir"]);
  const store = openStore({ dataDir });
  try {
    const project = resolveProject(store, io, p.flags.project);
    const body =
      command === "card_done"
        ? (p.flags.result as string)
        : command === "attachment"
          ? "上传附件"
          : p.flags["text-file"] === undefined
            ? (p.flags.text as string)
            : (await readFile(p.flags["text-file"], io, false)).toString(
                "utf8",
              );
    if (!body.trim()) usage("评论正文不能为空");
    const prepared: {
      mime: string;
      original_filename: string;
      receipt: Awaited<ReturnType<typeof prepareAttachmentFile>>;
    }[] = [];
    for (const path of p.files) {
      const mime = attachmentMimeForExtension(extname(path));
      if (mime === undefined)
        usage(`不支持的附件类型：${extname(path) || "无扩展名"}`);
      const content = await readFile(path, io, true);
      try {
        prepared.push({
          mime,
          original_filename: basename(path),
          receipt: await prepareAttachmentFile(
            content.toString("base64"),
            dataDir,
          ),
        });
      } catch (error) {
        if (error instanceof ToolError)
          must({ ok: false, error: error.toDomainError() }, "上传附件");
        throw error;
      }
    }
    const output = store.uow.run((tx) => {
      const actor = humanActor(project);
      const ports = { clock: systemClock, ids: tx.ids };
      const save = <T>(result: Result<CommandEffect<T>>, operation: string) => {
        const effect = must(result, operation);
        persistEffect(tx, project, effect);
        return effect.data;
      };
      // Persist the anchor and every attachment in one transaction. Blob IO stays outside.
      let entry = p.entry;
      const lines: string[] = [];
      if (entry === undefined) {
        const comment = save(
          postComment(
            loadCommandState(tx, project),
            actor,
            {
              card_id: p.cardId,
              body,
            },
            ports,
          ),
          command === "card_done" ? "完成卡片" : "发表评论",
        );
        if (!comment) throw new CliError("评论保存失败", EXIT.failure);
        entry = comment.id;
        lines.push(`已发表评论 ${entry}`);
      }
      const attachments = [];
      for (const { mime, original_filename, receipt } of prepared) {
        const attachment = save(
          uploadAttachment(
            loadCommandState(tx, project),
            actor,
            {
              card_id: p.cardId,
              mime,
              original_filename,
              ...(p.flags.note === undefined ? {} : { note: p.flags.note }),
              kind: p.kind,
              attach_to: { kind: "timeline_entry", id: entry },
              ...(p.basis === undefined ? {} : { basis: p.basis }),
            },
            receipt,
            ports,
          ),
          "上传附件",
        );
        attachments.push(attachment.id);
        lines.push(`已上传附件 ${attachment.id}（挂到 ${entry}）`);
      }
      if (command === "card_done") {
        save(
          markCardDone(
            loadCommandState(tx, project),
            actor,
            { card_id: p.cardId, result: body, attachments },
            ports,
          ),
          "完成卡片",
        );
        lines.push(`已完成卡片 ${p.cardId}`);
      }
      return lines;
    });
    io.stdout(output.join("\n"));
    return EXIT.ok;
  } finally {
    store.close();
  }
}
