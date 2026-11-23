import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  activateRole,
  copyRole,
  createRole,
  type DomainError,
  deactivateRole,
  previewRoleUpgrade,
  type Result,
  type RoleDefinition,
  type RoleEffect,
  type RolePatch,
  type RoleUpgradeEffect,
  rollbackRole,
  type ToolName,
  toolNames,
  updateRole,
  upgradeRole,
} from "@cardigan/domain";
import {
  applyRoleDocument,
  composeOverlaySource,
  deploymentRolePolicyHash,
  deriveOverlayRules,
  overlayEditedByHand,
  overlaySummary,
  previewRoleDocument,
  RoleDocumentError,
} from "@cardigan/host";
import {
  convertLegacyRole,
  DEFAULT_ROLE_LAUNCH,
  defaultRoleDefinition,
  exportRoleMarkdown,
  isDefaultRoleId,
  isHarness,
  RoleMarkdownError,
} from "@cardigan/roles";
import {
  getRoleVersion,
  listRoleVersions,
  persistRoleEffect,
  Store,
} from "@cardigan/store";
import { validLaunchConfig, validProfileNames } from "./config.js";
import { CliError, EXIT, formatCommandError } from "./errors.js";
import {
  announceDataDir,
  resolveActor,
  resolveProject,
  systemClock,
} from "./host.js";
import type { CliIo } from "./io.js";
import { cliLaunchPaths } from "./paths.js";
import { readRoleFile } from "./role-file.js";

const USAGE = [
  "用法：cardigan role <命令> [--project <项目>] [--data-dir <目录>]",
  "  list [--all]",
  "  show <角色> [--version <n>] [--history]",
  "  apply <file.md> [--yes]（默认只预览）",
  "  export <角色> > file.md",
  "  add|update --file <role.yaml>",
  "  copy <源角色> <新角色> [--from-project <项目> | --from-default --harness <CLI> --launch-profile <配置>] [--version <n>] [--name <显示名>]",
  "    ui_ux_designer、design_director、frontend_engineer 从默认角色包复制时可省略 --harness 和 --launch-profile；设计师默认 codex/codex-astra，设计总监和前端工程师默认 claude-code/claude-opus。",
  "  update <角色> --convert-legacy",
  "  upgrade <角色> --from-default [--dry-run]",
  "    带项目附加规则的角色按“当前默认包 + 附加规则”升级，附加规则保留。",
  "  overlay <角色> [--base <默认角色>] [--keep-instructions] [--append-file <file>] [--add-tools a,b] [--remove-tools a,b] [--dry-run]",
  "    把角色登记为“默认包 + 项目附加规则”（追加说明、额外工具、显式移除的工具），之后随默认包自动升级；打印迁移前后对比。",
  "    已登记的规则原样保留；未登记时从当前版本读出，说明和权限不变（缺少的默认包工具登记为显式移除）。",
  "    --append-file 替换追加说明；--add-tools/--remove-tools 在现有规则上增减；--keep-instructions 用于非默认角色，保留本角色说明，只跟随底角色的工具。",
  "    为已有默认角色（pm、coder、frontend_engineer、reviewer、designer、ui_ux_designer、design_director、tester、host_ops）追加新版本：instructions、allowed_tools、",
  "    capabilities、required_capabilities、kind、worktree 取当前默认角色包；harness、launch_profile_ref、display_name、abilities、",
  "    required_machine_tags 保留项目自己的。先打印变化和放宽项；内容相同时不追加。--dry-run 只打印不写入。",
  "  deactivate|activate <角色>",
  "  rollback <角色> --version <n>",
  "兼容：role add <项目> <角色> [--version <下一个版本>] [--allowed-tools a,b] [--capabilities x,y]",
].join("\n");

function fail(message: string): never {
  throw new CliError(message, EXIT.usage, [USAGE]);
}
function parse(args: readonly string[]) {
  const [command, ...rest] = args;
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
      "upgrade",
      "apply",
      "export",
      "overlay",
    ].includes(command ?? "")
  )
    fail("请指定有效的角色命令");
  const perCommand: Record<string, string[]> = {
    apply: ["yes"],
    export: [],
    list: ["all"],
    show: ["version", "history"],
    add: ["file", "version", "allowed-tools", "capabilities"],
    update: ["file", "convert-legacy"],
    copy: [
      "from-project",
      "from-default",
      "harness",
      "launch-profile",
      "version",
      "name",
    ],
    rollback: ["version"],
    upgrade: ["from-default", "dry-run"],
    overlay: [
      "base",
      "append-file",
      "add-tools",
      "remove-tools",
      "keep-instructions",
      "dry-run",
    ],
    deactivate: [],
    activate: [],
  };
  const allowed = [
    "data-dir",
    "project",
    ...(perCommand[command as string] ?? []),
  ];
  const boolean = [
    "all",
    "history",
    "from-default",
    "convert-legacy",
    "dry-run",
    "keep-instructions",
    "yes",
  ];
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index] as string;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    if (!allowed.includes(key)) fail(`不认识的选项：${token}`);
    if (Object.hasOwn(flags, key)) fail(`选项 ${token} 不能重复`);
    if (boolean.includes(key)) {
      flags[key] = "true";
      continue;
    }
    const value = rest[++index];
    if (value === undefined || value.startsWith("--") || value.trim() === "")
      fail(`${token} 需要一个值`);
    flags[key] = value;
  }
  const expected =
    command === "list" || flags.file
      ? 0
      : command === "copy" || command === "add"
        ? 2
        : 1;
  if (positionals.length !== expected) fail("角色命令的位置参数不正确");
  if (
    command !== "apply" &&
    positionals.some((id) => !/^[a-z0-9][a-z0-9._-]*$/u.test(id))
  )
    fail("角色或项目编号不合法");
  if (command === "update" && !flags.file && !flags["convert-legacy"])
    fail("role update 需要 --file <role.yaml> 或 --convert-legacy");
  if (command === "rollback" && !flags.version) fail("回退需要 --version");
  if (command === "upgrade" && !flags["from-default"])
    fail("role upgrade 目前只支持 --from-default（按默认角色包升级）");
  if (flags["from-project"] && flags["from-default"])
    fail("只能选择一个复制来源");
  if (flags.history && flags.version)
    fail("--history 和 --version 不能同时使用");
  if (
    flags.file &&
    (flags["convert-legacy"] ||
      flags.version ||
      flags["allowed-tools"] ||
      flags.capabilities)
  )
    fail("--file 不能与其他写入选项混用");
  if (
    (flags.harness || flags["launch-profile"]) &&
    (!flags["from-default"] || command !== "copy")
  )
    fail("启动配置选项只用于从默认角色包复制");
  let version: number | undefined;
  if (flags.version !== undefined) {
    version = Number(flags.version);
    if (!Number.isSafeInteger(version) || version < 1)
      fail("--version 必须是正整数");
  }
  return { command, flags, positionals, version };
}

function commaList(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}
function toolList(value: string | undefined): ToolName[] {
  const names = commaList(value);
  const unknown = names.filter((name) => !toolNames.includes(name as ToolName));
  if (unknown.length)
    fail(
      `不认识的工具：${unknown.join(", ")}；可用工具：${toolNames.join(", ")}`,
    );
  return names as ToolName[];
}

export async function runRoleCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  const { command, flags, positionals, version } = parse(args);
  const file =
    flags.file === undefined ? undefined : await readRoleFile(flags.file);
  const store = Store.open({ dataDir: announceDataDir(io, flags["data-dir"]) });
  try {
    const legacyAdd = command === "add" && file === undefined;
    const project = resolveProject(
      store,
      io,
      legacyAdd ? positionals[0] : flags.project,
    );
    const id = (legacyAdd ? positionals[1] : positionals[0]) as string;
    if (command === "export") {
      const role = store.uow.read((tx) => getRoleVersion(tx, project, id));
      if (!role) fail(`角色 ${id} 不存在`);
      io.stdout(exportRoleMarkdown(role).slice(0, -1)); // stdout adds the framing newline
      return EXIT.ok;
    }
    if (command === "apply") {
      const markdown = await readFile(resolve(io.cwd, id), "utf8");
      const context = {
        store,
        project_id: project,
        actor: resolveActor(io, project, store),
        clock: systemClock,
        launchConfig: () =>
          validLaunchConfig(cliLaunchPaths(io, flags["data-dir"])),
        authorize: () => {},
      }; // CLI human-only policy; no web session
      try {
        const preview = previewRoleDocument(context, markdown);
        io.stdout(JSON.stringify(preview, null, 2));
        if (flags.yes) {
          applyRoleDocument(context, markdown, preview.snapshot, randomUUID());
          io.stdout("已应用");
        }
      } catch (e) {
        if (e instanceof RoleDocumentError || e instanceof RoleMarkdownError)
          fail(e.message);
        throw e;
      }
      return EXIT.ok;
    }
    if (command === "list" || command === "show") {
      const roles = store.uow.read((tx) => listRoleVersions(tx, project));
      if (command === "list") {
        const latest = [
          ...new Map(roles.map((role) => [role.role_id, role])).values(),
        ].filter((role) => flags.all || role.status !== "inactive");
        io.stdout(
          latest
            .map(
              (role) =>
                `${role.role_id}  ${role.display_name}  ${role.kind}  v${role.version}  ${role.status === "inactive" ? "已停用" : "启用"}`,
            )
            .join("\n") || "没有符合条件的角色",
        );
      } else {
        const matches = roles.filter(
          (role) =>
            role.role_id === id &&
            (version === undefined || role.version === version),
        );
        if (!matches.length) fail(`角色 ${id} 的指定版本不存在`);
        io.stdout(
          JSON.stringify(flags.history ? matches : matches.at(-1), null, 2),
        );
      }
      return EXIT.ok;
    }
    const checkProfile = (role: RoleDefinition) => {
      const config = validProfileNames(cliLaunchPaths(io, flags["data-dir"]));
      if (!config.has(role.launch_profile_ref))
        fail(
          `角色 ${role.role_id} 引用的启动配置 ${role.launch_profile_ref} 不存在于 launch.yaml；请添加配置或选用已有配置`,
        );
    };
    if (command === "overlay")
      return await registerOverlay(store, io, project, id, flags);
    if (command === "upgrade")
      return upgradeFromDefault(
        store,
        io,
        project,
        id,
        !!flags["dry-run"],
        checkProfile,
      );
    const actor = resolveActor(io, project, store);
    const role = store.uow.run((tx) => {
      const state = {
        project_id: project,
        roles: listRoleVersions(tx, project),
      };
      const ports = { clock: systemClock, ids: tx.ids };
      let result: Result<RoleEffect>;
      switch (command) {
        case "add": {
          let definition: RoleDefinition;
          if (file) definition = file;
          else {
            const tools = toolList(flags["allowed-tools"]);
            definition = isDefaultRoleId(id)
              ? {
                  ...defaultRoleDefinition(
                    id,
                    DEFAULT_ROLE_LAUNCH[id] ?? {
                      harness: "codex",
                      launch_profile_ref: "codex-agent",
                    },
                  ),
                  allowed_tools: tools,
                  capabilities: commaList(flags.capabilities),
                }
              : {
                  role_id: id,
                  display_name: id,
                  kind: tools.includes("submit_review") ? "verify" : "produce",
                  instructions: `角色：${id}`,
                  harness: "codex",
                  launch_profile_ref: "codex-agent",
                  worktree: tools.includes("submit_review")
                    ? "readonly"
                    : "write",
                  allowed_tools: tools,
                  capabilities: commaList(flags.capabilities),
                  abilities: [],
                  required_machine_tags: [],
                };
          }
          const previous = getRoleVersion(tx, project, definition.role_id);
          if (version !== undefined && version !== (previous?.version ?? 0) + 1)
            throw new CliError(
              formatCommandError("创建角色", definition.role_id, {
                code: "validation_failed",
                message: "--version 必须是下一个版本，不能覆盖或跳过版本",
              }),
              EXIT.usage,
              [USAGE],
            );
          const { role_id: roleId, ...patch } = definition;
          result =
            legacyAdd && previous && version !== undefined
              ? updateRole(state, actor, roleId, patch, ports)
              : createRole(state, actor, definition, ports);
          break;
        }
        case "update": {
          let patch: RolePatch;
          let roleId: string;
          if (file) {
            const { role_id, ...fields } = file;
            roleId = role_id;
            patch = fields;
          } else {
            roleId = id;
            const old = getRoleVersion(tx, project, id);
            if (!old) fail(`角色 ${id} 不存在`);
            const converted = convertLegacyRole(old);
            for (const warning of converted.warnings) io.stderr(warning);
            patch = { instructions: converted.instructions };
          }
          result = updateRole(state, actor, roleId, patch, ports);
          break;
        }
        case "copy": {
          let source: RoleDefinition;
          if (flags["from-default"]) {
            if (!isDefaultRoleId(id)) fail(`默认角色包没有 ${id}`);
            if (version !== undefined) fail("默认角色包不接受 --version");
            const recommended = DEFAULT_ROLE_LAUNCH[id];
            if (
              recommended &&
              flags.harness === undefined &&
              flags["launch-profile"] === undefined
            )
              source = defaultRoleDefinition(id, recommended);
            else {
              if (!isHarness(flags.harness) || !flags["launch-profile"])
                fail("从默认角色包复制需要 --harness 和 --launch-profile");
              source = defaultRoleDefinition(id, {
                harness: flags.harness,
                launch_profile_ref: flags["launch-profile"],
              });
            }
          } else {
            const sourceProject = flags["from-project"] ?? project;
            if (!store.getProject(sourceProject))
              fail(`来源项目 ${sourceProject} 不存在`);
            const found = getRoleVersion(tx, sourceProject, id, version);
            if (!found) fail(`来源角色 ${id} 的指定版本不存在`);
            source = found;
          }
          result = copyRole(
            state,
            actor,
            {
              source,
              role_id: positionals[1] as string,
              ...(flags.name === undefined ? {} : { display_name: flags.name }),
            },
            ports,
          );
          break;
        }
        case "activate":
          result = activateRole(state, actor, id, ports);
          break;
        case "deactivate":
          result = deactivateRole(state, actor, id, ports);
          break;
        default:
          result = rollbackRole(state, actor, id, version as number, ports);
      }
      if (!result.ok)
        throw new CliError(
          formatCommandError(
            {
              add: "创建角色",
              update: "更新角色",
              copy: "复制角色",
              activate: "恢复角色",
              deactivate: "停用角色",
              rollback: "回退角色",
            }[
              command as
                | "add"
                | "update"
                | "copy"
                | "activate"
                | "deactivate"
                | "rollback"
            ],
            file?.role_id ??
              (command === "copy" ? (positionals[1] as string) : id),
            result.error,
          ),
          EXIT.usage,
        );
      if (command !== "deactivate") checkProfile(result.value.data);
      persistRoleEffect(tx, project, result.value);
      return result.value.data;
    });
    const action = legacyAdd
      ? "已写入"
      : command === "add"
        ? "已创建"
        : command === "update"
          ? "已更新"
          : command === "copy"
            ? "已复制"
            : command === "activate"
              ? "已恢复"
              : command === "deactivate"
                ? "已停用"
                : "已回退";
    io.stdout(
      `${action}角色 ${role.role_id} v${role.version}（项目 ${project}）`,
    );
    return EXIT.ok;
  } finally {
    store.close();
  }
}

const DEFAULT_ROLE_IDS = [
  "pm",
  "coder",
  "frontend_engineer",
  "reviewer",
  "designer",
  "ui_ux_designer",
  "design_director",
  "tester",
  "independent_reviewer",
  "host_ops",
];

function printUpgrade(
  io: CliIo,
  result: Pick<RoleUpgradeEffect, "previous" | "diff">,
): void {
  const { previous, diff } = result;
  const list = (values: readonly string[]) =>
    values.length ? values.join(", ") : "无";
  io.stdout(
    [
      `角色 ${previous.role_id} 当前 v${previous.version}，对照默认角色包的变化：`,
      `  新增工具：${list(diff.added_tools)}`,
      `  移除工具：${list(diff.removed_tools)}`,
      `  新增能力：${list(diff.added_capabilities)}`,
      `  移除能力：${list(diff.removed_capabilities)}`,
      ...diff.fields.map(
        (change) => `  ${change.field}：${change.from} → ${change.to}`,
      ),
      ...(diff.relaxations.length
        ? [
            "【注意：以下变化会放宽权限】",
            ...diff.relaxations.map((line) => `  ！${line}`),
          ]
        : ["没有放宽权限的变化"]),
    ].join("\n"),
  );
}

/** `role upgrade <id> --from-default`: one more version, never a rewrite. */
function upgradeFromDefault(
  store: Store,
  io: CliIo,
  project: string,
  id: string,
  dryRun: boolean,
  checkProfile: (role: RoleDefinition) => void,
): number {
  const notDefault = () =>
    fail(
      `${id} 不是默认角色包里的角色，不能按默认包升级；默认角色有：${DEFAULT_ROLE_IDS.filter(isDefaultRoleId).join("、")}`,
    );
  const overlaid = store.uow.read(
    (tx) => !!getRoleVersion(tx, project, id)?.default_overlay,
  );
  if (!overlaid && !isDefaultRoleId(id)) notDefault();
  const human = resolveActor(io, project, store);
  const source = (tx: Parameters<typeof listRoleVersions>[0]) => {
    const latest = getRoleVersion(tx, project, id);
    if (!latest)
      fail(`项目 ${project} 还没有角色 ${id}，先用 cardigan role add 创建`);
    // C-613: the project's rules survive an upgrade instead of being overwritten.
    const pack = latest.default_overlay
      ? composeOverlaySource(latest, latest.default_overlay)
      : isDefaultRoleId(id)
        ? defaultRoleDefinition(id, {
            harness: latest.harness,
            launch_profile_ref: latest.launch_profile_ref,
          })
        : undefined;
    if (!pack) return notDefault();
    if (latest.default_overlay)
      io.stdout(
        `角色 ${id} 带项目附加规则，按“当前默认包 + 附加规则”升级：${JSON.stringify(overlaySummary(latest.default_overlay))}${overlayEditedByHand(latest) ? "\n！当前版本在附加规则之外另有改动，升级会覆盖；需要保留时先用 role overlay 重新登记" : ""}`,
      );
    return {
      latest,
      state: { project_id: project, roles: listRoleVersions(tx, project) },
      pack,
    };
  };
  const rejected = (error: DomainError) =>
    new CliError(formatCommandError("升级角色", id, error), EXIT.usage);
  const same = (version: number) =>
    io.stdout(
      `角色 ${id} v${version} 已是默认包内容，没有追加新版本（项目 ${project}）`,
    );
  if (dryRun)
    // A read-only transaction: no version, event or id counter is written.
    return store.uow.read((tx) => {
      const { latest, state, pack } = source(tx);
      const preview = previewRoleUpgrade(state, human, id, pack);
      if (!preview.ok) throw rejected(preview.error);
      if (preview.value.unchanged) same(latest.version);
      else {
        printUpgrade(io, preview.value);
        io.stdout("--dry-run：只打印变化，没有写入");
      }
      return EXIT.ok;
    });
  return store.uow.run((tx) => {
    const { latest, state, pack } = source(tx);
    const result = upgradeRole(state, human, id, pack, {
      clock: systemClock,
      ids: tx.ids,
    });
    if (!result.ok) throw rejected(result.error);
    if (result.value.unchanged) {
      same(latest.version);
      return EXIT.ok;
    }
    printUpgrade(io, result.value);
    checkProfile(result.value.effect.data);
    persistRoleEffect(tx, project, result.value.effect);
    io.stdout(
      `已按默认角色包升级 ${id} 到 v${result.value.effect.data.version}（项目 ${project}）`,
    );
    return EXIT.ok;
  });
}

/**
 * `role overlay <id>` (C-613): store a role as a default-pack role plus the
 * project's rules, printing the before/after comparison. Always a new version.
 */
async function registerOverlay(
  store: Store,
  io: CliIo,
  project: string,
  id: string,
  flags: Readonly<Record<string, string>>,
): Promise<number> {
  const append =
    flags["append-file"] === undefined
      ? undefined
      : await readFile(resolve(io.cwd, flags["append-file"]), "utf8");
  const add =
    flags["add-tools"] === undefined ? undefined : toolList(flags["add-tools"]);
  const remove =
    flags["remove-tools"] === undefined
      ? undefined
      : toolList(flags["remove-tools"]);
  if (flags.base !== undefined && !isDefaultRoleId(flags.base))
    fail(`${flags.base} 不是默认角色包里的角色`);
  const human = resolveActor(io, project, store);
  const plan = (tx: Parameters<typeof listRoleVersions>[0]) => {
    const latest = getRoleVersion(tx, project, id);
    if (!latest)
      fail(`项目 ${project} 还没有角色 ${id}，先用 cardigan role add 创建`);
    const prior = latest.default_overlay;
    const base = flags.base ?? prior?.base_role_id ?? id;
    const mode = flags["keep-instructions"]
      ? "replace"
      : (prior?.instructions_mode ?? "append");
    const derived = deriveOverlayRules(latest, base, mode);
    if (!derived)
      fail(`角色 ${id} 不在默认角色包里，请用 --base 指定作为底的默认角色`);
    // Registering never changes the role's kind, worktree or capabilities.
    if (derived.mismatched.length)
      fail(
        `角色 ${id} 的 ${derived.mismatched.join("、")} 与默认角色 ${base} 不同，附加规则不能表达；请选 kind、worktree、能力都一致的默认角色作为 --base`,
      );
    // Registered rules stay as they are unless the version was edited outside
    // them; otherwise read them from the current version, which keeps its
    // text and permissions (a lacking default tool stays removed).
    const start =
      prior &&
      !overlayEditedByHand(latest) &&
      prior.base_role_id === base &&
      (prior.instructions_mode ?? "append") === mode
        ? prior
        : derived.rules;
    const packTools =
      composeOverlaySource(latest, {
        base_role_id: base,
        append_instructions: "",
        extra_tools: [],
        removed_tools: [],
      })?.allowed_tools ?? [];
    const extra = new Set(start.extra_tools);
    const removed = new Set(start.removed_tools);
    for (const tool of add ?? []) {
      removed.delete(tool);
      if (!packTools.includes(tool)) extra.add(tool);
    }
    // An explicit removal is kept even for a tool the pack lacks today, so a
    // later pack that adds it does not grant it.
    for (const tool of remove ?? []) {
      extra.delete(tool);
      removed.add(tool);
    }
    const rules = {
      base_role_id: base,
      append_instructions: append ?? start.append_instructions,
      ...(mode === "replace" && { instructions_mode: "replace" as const }),
      extra_tools: [...extra],
      removed_tools: [...removed],
    };
    const source = composeOverlaySource(latest, rules);
    if (!source) fail(`默认角色包没有 ${base}`);
    const list = (values: readonly string[]) =>
      values.length ? values.join(", ") : "无";
    const appended = source.default_overlay.append_instructions;
    const stillRemoved = derived.missing_tools.filter((t) => removed.has(t));
    io.stdout(
      [
        `角色 ${id} v${latest.version} → 默认角色 ${base} + 项目附加规则${mode === "replace" ? "（保留本角色自己的说明，只跟随默认包的工具和策略字段）" : ""}：`,
        `  ${mode === "replace" ? "本角色说明" : "追加说明"}：${overlaySummary(rules).appended_paragraphs} 段`,
        ...(appended
          ? appended.split("\n").map((line) => `    | ${line}`)
          : []),
        `  额外工具：${list(rules.extra_tools)}`,
        `  移除工具：${list(rules.removed_tools)}`,
        ...(stillRemoved.length
          ? [
              `  当前版本没有默认包工具 ${list(stillRemoved)}，登记为显式移除；要补上请加 --add-tools`,
            ]
          : []),
        ...(mode !== "replace" && derived.missing.length
          ? [
              `  当前版本缺少默认包的 ${derived.missing.length} 段说明，登记后会补上：`,
              ...derived.missing.map(
                (p) => `    + ${p.replace(/\s+/gu, " ").slice(0, 80)}`,
              ),
            ]
          : []),
        ...(start === derived.rules && derived.moved
          ? ["  追加说明会移到默认说明之后"]
          : []),
        `  迁移前策略指纹：${deploymentRolePolicyHash(latest)}`,
        `  迁移后策略指纹：${source.default_overlay.composed_hash}`,
      ].join("\n"),
    );
    return {
      latest,
      source,
      state: { project_id: project, roles: listRoleVersions(tx, project) },
    };
  };
  const rejected = (error: DomainError) =>
    new CliError(formatCommandError("登记附加规则", id, error), EXIT.usage);
  if (flags["dry-run"])
    return store.uow.read((tx) => {
      const { state, source } = plan(tx);
      const preview = previewRoleUpgrade(state, human, id, source);
      if (!preview.ok) throw rejected(preview.error);
      if (!preview.value.unchanged) printUpgrade(io, preview.value);
      io.stdout("--dry-run：只打印变化，没有写入");
      return EXIT.ok;
    });
  return store.uow.run((tx) => {
    const { latest, state, source } = plan(tx);
    const result = upgradeRole(state, human, id, source, {
      clock: systemClock,
      ids: tx.ids,
    });
    if (!result.ok) throw rejected(result.error);
    if (result.value.unchanged) {
      io.stdout(
        `角色 ${id} v${latest.version} 已按同样的附加规则登记，没有追加新版本`,
      );
      return EXIT.ok;
    }
    printUpgrade(io, result.value);
    persistRoleEffect(tx, project, result.value.effect);
    io.stdout(
      `已登记 ${id} v${result.value.effect.data.version} 为默认包 + 项目附加规则（项目 ${project}）`,
    );
    return EXIT.ok;
  });
}
