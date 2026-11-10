import {
  activateMember,
  createMember,
  deactivateMember,
  type Member,
  type MemberCommandPorts,
  type MemberEffect,
  type MemberId,
  parseId,
  type Result,
  type UpdateMemberInput,
  updateMember,
} from "@cardigan/domain";
import { persistMemberEffect, Store } from "@cardigan/store";
import { uploadAvatarFile, validateLibraryAvatar } from "./avatar.js";
import { CliError, EXIT, formatCommandError } from "./errors.js";
import { announceDataDir, resolveGlobalActor, systemClock } from "./host.js";
import type { CliIo } from "./io.js";

const USAGE = [
  "用法：cardigan member <命令>（全局成员，无需选择项目）",
  "  add --name <名字> --title <职位> --role <角色> [--avatar library:<人物 id> | --avatar-file <路径>]",
  "  list [--role <角色>] [--all]",
  "  update <M-n> [--name <名字>] [--title <职位>] [--avatar library:<人物 id> | --avatar-file <路径>]",
  "  deactivate <M-n> / activate <M-n>",
  "可用 --data-dir <目录> 指定数据库；update 的头像传空字符串可清空；当前仅支持 owner，数据库初始化时已创建占位所有者。",
].join("\n");
const editableFlags = ["name", "title", "avatar", "avatar-file"];

function parse(args: readonly string[]) {
  const [command, ...rest] = args;
  if (
    !["add", "list", "update", "deactivate", "activate"].includes(command ?? "")
  ) {
    throw new CliError("请指定有效的成员命令", EXIT.usage, [USAGE]);
  }
  const allowed = new Set([
    "data-dir",
    ...(command === "add"
      ? [...editableFlags, "role"]
      : command === "update"
        ? editableFlags
        : command === "list"
          ? ["role", "all"]
          : []),
  ]);
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index] as string;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const key = token.slice(2, equals < 0 ? undefined : equals);
    if (!allowed.has(key))
      throw new CliError(`不认识的选项：--${key}`, EXIT.usage, [USAGE]);
    if (Object.hasOwn(flags, key))
      throw new CliError(`选项 --${key} 不能重复`, EXIT.usage);
    if (key === "all") {
      if (equals >= 0) throw new CliError("--all 不接受值", EXIT.usage);
      flags.all = "true";
      continue;
    }
    const value = equals < 0 ? rest[++index] : token.slice(equals + 1);
    if (value === undefined || (equals < 0 && value.startsWith("--")))
      throw new CliError(`--${key} 需要一个值`, EXIT.usage);
    if (value.length === 0 && !(command === "update" && key === "avatar"))
      throw new CliError(`--${key} 不能为空`, EXIT.usage);
    flags[key] = value;
  }
  const needsId = command !== "add" && command !== "list";
  if (needsId && positionals.length === 0)
    throw new CliError(
      `缺少成员编号：cardigan member ${command} M-1${command === "update" ? " --name 邵杰" : ""}（用 cardigan member list 查看编号）`,
      EXIT.usage,
    );
  if (positionals.length !== (needsId ? 1 : 0))
    throw new CliError("成员命令的位置参数不正确", EXIT.usage, [USAGE]);
  if (needsId && !parseId("member", positionals[0]).ok)
    throw new CliError("成员编号必须为 M-n（正整数）", EXIT.usage);
  if (
    command === "add" &&
    ["name", "title", "role"].some((key) => flags[key] === undefined)
  )
    throw new CliError("新增成员需要 --name、--title 和 --role", EXIT.usage);
  if (
    command === "update" &&
    !editableFlags.some((key) => flags[key] !== undefined)
  )
    throw new CliError("至少指定一个成员修改字段", EXIT.usage);
  if (flags.avatar !== undefined && flags["avatar-file"] !== undefined)
    throw new CliError("--avatar 和 --avatar-file 不能同时使用", EXIT.usage);
  validateLibraryAvatar(flags.avatar);
  return { command, flags, id: positionals[0] as MemberId };
}

export async function runMemberCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  const actor = resolveGlobalActor(io);
  const { command, flags, id } = parse(args);
  const dataDir = announceDataDir(io, flags["data-dir"]);
  const avatar =
    flags["avatar-file"] === undefined
      ? flags.avatar
      : await uploadAvatarFile(flags["avatar-file"], dataDir, io);
  const store = Store.open({ dataDir });
  try {
    if (command === "list") {
      const members = store.uow
        .read((tx) => tx.members.list())
        .filter(
          (member) =>
            (flags.all !== undefined || member.status === "active") &&
            (flags.role === undefined || member.role === flags.role),
        );
      io.stdout(
        members.length === 0
          ? "没有符合条件的成员"
          : members
              .map(
                (member) =>
                  `${member.id}  ${member.name}  ${member.title}  角色：${member.role}  ${member.status === "active" ? "在职" : "已停用"}`,
              )
              .join("\n"),
      );
      return EXIT.ok;
    }
    const member = store.uow.run((tx) => {
      const members = tx.members.list();
      const ports: MemberCommandPorts = {
        clock: systemClock,
        ids: tx.global_ids,
      };
      const patch: UpdateMemberInput = {
        ...(flags.name === undefined ? {} : { name: flags.name }),
        ...(flags.title === undefined ? {} : { title: flags.title }),
        ...(avatar === undefined ? {} : { avatar: avatar || null }),
      };
      let result: Result<MemberEffect>;
      switch (command) {
        case "add":
          result = createMember(
            members,
            actor,
            {
              ...patch,
              name: flags.name as string,
              title: flags.title as string,
              role: flags.role as Member["role"],
            },
            ports,
          );
          break;
        case "update":
          result = updateMember(members, actor, id, patch, ports);
          break;
        case "activate":
          result = activateMember(members, actor, id, ports);
          break;
        default:
          result = deactivateMember(members, actor, id, ports);
      }
      if (!result.ok)
        throw new CliError(
          formatCommandError(
            command === "add"
              ? "创建成员"
              : command === "update"
                ? "更新成员"
                : command === "activate"
                  ? "恢复成员"
                  : "停用成员",
            command === "add" ? (flags.name as string) : id,
            result.error,
          ),
          EXIT.usage,
        );
      persistMemberEffect(tx, result.value);
      return result.value.data;
    });
    printMember(
      io,
      member,
      command === "add"
        ? "已创建"
        : command === "update"
          ? "已更新"
          : command === "activate"
            ? "已恢复"
            : "已停用",
    );
    return EXIT.ok;
  } finally {
    store.close();
  }
}

function printMember(io: CliIo, member: Member, action: string): void {
  io.stdout(
    `${action}成员 ${member.id}：${member.name}（${member.title}）；角色：${member.role}`,
  );
}
