import {
  activateEmployee,
  activeOwner,
  createEmployee,
  deactivateEmployee,
  type Employee,
  type EmployeeCommandPorts,
  type EmployeeEffect,
  type EmployeeId,
  parseId,
  type Result,
  type UpdateEmployeeInput,
  updateEmployee,
} from "@cardigan/domain";
import {
  acceptedHostProfiles,
  assertLaunchFence,
  selectableLaunchConfig,
  withLaunchSnapshot,
} from "@cardigan/host";
import { validateLaunchSecrets } from "@cardigan/roles";
import { persistEmployeeEffect, Store } from "@cardigan/store";
import { uploadAvatarFile, validateLibraryAvatar } from "./avatar.js";
import { loadConfig, loadSecrets } from "./config.js";
import { CliError, EXIT, formatCommandError } from "./errors.js";
import { announceDataDir, resolveGlobalActor, systemClock } from "./host.js";
import type { CliIo } from "./io.js";
import { cliLaunchPaths, type LaunchPaths } from "./paths.js";

const USAGE = [
  "用法：cardigan employee <命令>（全局员工，无需选择项目）",
  "  add --name <名字> --title <职位> --role <角色> [--bio <简介>] [--avatar library:<人物 id> | --avatar-file <路径>] [--launch-profile <名字>]",
  "  list [--role <角色>] [--all]",
  "  update <E-n> [--role <角色>] [--name <名字>] [--title <职位>] [--bio <简介>] [--avatar library:<人物 id> | --avatar-file <路径>] [--launch-profile <名字>]",
  "  deactivate <E-n> / activate <E-n>",
  "可用 --data-dir <目录> 指定数据库；update 的简介、头像、启动配置传空字符串可清空。",
].join("\n");
const editableFlags = [
  "role",
  "name",
  "title",
  "bio",
  "avatar",
  "avatar-file",
  "launch-profile",
];

function parse(args: readonly string[]) {
  const [command, ...rest] = args;
  if (
    !["add", "list", "update", "deactivate", "activate"].includes(command ?? "")
  ) {
    throw new CliError("请指定有效的员工命令", EXIT.usage, [USAGE]);
  }
  const allowed = new Set([
    "data-dir",
    ...(command === "add" || command === "update"
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
    if (
      value.length === 0 &&
      !(
        command === "update" &&
        ["bio", "avatar", "launch-profile"].includes(key)
      )
    )
      throw new CliError(`--${key} 不能为空`, EXIT.usage);
    flags[key] = value;
  }
  const needsId = command !== "add" && command !== "list";
  if (needsId && positionals.length === 0)
    throw new CliError(
      `缺少员工编号：cardigan employee ${command} E-1${command === "update" ? " --name 诸葛亮" : ""}（用 cardigan employee list 查看编号）`,
      EXIT.usage,
    );
  if (positionals.length !== (needsId ? 1 : 0))
    throw new CliError("员工命令的位置参数不正确", EXIT.usage, [USAGE]);
  if (needsId && !parseId("employee", positionals[0]).ok)
    throw new CliError("员工编号必须为 E-n（正整数）", EXIT.usage);
  if (
    command === "add" &&
    ["name", "title", "role"].some((key) => flags[key] === undefined)
  )
    throw new CliError("新增员工需要 --name、--title 和 --role", EXIT.usage);
  if (
    command === "update" &&
    !editableFlags.some((key) => flags[key] !== undefined)
  )
    throw new CliError("至少指定一个员工修改字段", EXIT.usage);
  if (flags.avatar !== undefined && flags["avatar-file"] !== undefined)
    throw new CliError("--avatar 和 --avatar-file 不能同时使用", EXIT.usage);
  validateLibraryAvatar(flags.avatar);
  return { command, flags, id: positionals[0] as EmployeeId };
}

/** Prepare standalone validation without holding the writer through a catalog fetch.
 * Once a host has adopted a generation, disk candidates are never a fallback. */
async function employeeProfileLookup(
  store: Store,
  paths: LaunchPaths,
  io: CliIo,
) {
  const hosted = () => acceptedHostProfiles(store);
  if (hosted() !== undefined) return () => hosted() ?? [];
  const fence = withLaunchSnapshot(
    store,
    paths.configDir,
    paths.dataDir,
    (f) => f,
  );
  const config = await loadConfig(paths);
  const secrets = await loadSecrets(paths, io);
  validateLaunchSecrets(config, secrets);
  const names = Object.keys(
    selectableLaunchConfig({ config, secrets }).profiles,
  );
  return () => {
    // Host startup or another publisher may have won since validation.
    const accepted = hosted();
    if (accepted !== undefined) return accepted;
    assertLaunchFence(store, paths.configDir, paths.dataDir, fence);
    return names;
  };
}

export async function runEmployeeCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  const actor = resolveGlobalActor(io);
  const { command, flags, id } = parse(args);
  const profile = flags["launch-profile"];
  const dataDir = announceDataDir(io, flags["data-dir"]);
  const avatar =
    flags["avatar-file"] === undefined
      ? flags.avatar
      : await uploadAvatarFile(flags["avatar-file"], dataDir, io);
  const store = Store.open({ dataDir });
  try {
    if (command === "list") {
      const employees = store.uow
        .read((tx) => tx.employees.list())
        .filter(
          (employee) =>
            (flags.all !== undefined || employee.status === "active") &&
            (flags.role === undefined || employee.role_id === flags.role),
        );
      io.stdout(
        employees.length === 0
          ? "没有符合条件的员工"
          : employees
              .map(
                (employee) =>
                  `${employee.id}  ${employee.name}  ${employee.title}  角色：${employee.role_id}  ${employee.status === "active" ? "在职" : "已停用"}`,
              )
              .join("\n"),
      );
      return EXIT.ok;
    }
    const lookup = profile
      ? await employeeProfileLookup(store, cliLaunchPaths(io, dataDir), io)
      : undefined;
    const employee = store.uow.run((tx) => {
      const profiles = lookup?.();
      const employees = tx.employees.list();
      const ports: EmployeeCommandPorts = {
        clock: systemClock,
        ids: tx.global_ids,
        roleTransferFacts: tx.employees.roleTransferFacts,
        ...(profiles === undefined ? {} : { launch_profiles: profiles }),
      };
      const patch: UpdateEmployeeInput = {
        ...(flags.role === undefined ? {} : { role_id: flags.role }),
        ...(flags.name === undefined ? {} : { name: flags.name }),
        ...(flags.title === undefined ? {} : { title: flags.title }),
        ...(flags.bio === undefined ? {} : { bio: flags.bio }),
        ...(avatar === undefined ? {} : { avatar: avatar || null }),
        ...(profile === undefined
          ? {}
          : { launch_profile_ref: profile || null }),
      };
      let result: Result<EmployeeEffect>;
      switch (command) {
        case "add":
          result = createEmployee(
            employees,
            actor,
            {
              ...patch,
              name: flags.name as string,
              title: flags.title as string,
              role_id: flags.role as string,
            },
            ports,
          );
          break;
        case "update": {
          const owner = activeOwner(tx.members.list());
          result = updateEmployee(
            employees,
            owner ? { ...actor, member_id: owner.id } : actor,
            id,
            patch,
            ports,
          );
          break;
        }
        case "activate":
          result = activateEmployee(employees, actor, id, ports);
          break;
        default:
          result = deactivateEmployee(employees, actor, id, ports);
      }
      if (!result.ok)
        throw new CliError(
          formatCommandError(
            command === "add"
              ? "创建员工"
              : command === "update"
                ? "更新员工"
                : command === "activate"
                  ? "恢复员工"
                  : "停用员工",
            command === "add" ? (flags.name as string) : id,
            result.error,
          ),
          EXIT.usage,
        );
      persistEmployeeEffect(tx, result.value);
      return result.value.data;
    });
    printEmployee(
      io,
      employee,
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

function printEmployee(io: CliIo, employee: Employee, action: string): void {
  io.stdout(
    `${action}员工 ${employee.id}：${employee.name}（${employee.title}）；角色：${employee.role_id}`,
  );
}
