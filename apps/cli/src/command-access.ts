import type { Actor, ToolName } from "@cardigan/domain";
import { CliError, EXIT } from "./errors.js";
import type { CliIo } from "./io.js";

/** Complete CLI → MCP permission map. null means human-only, including reads.
 * Compound operations check each domain command as well (e.g. comment + file).
 * Unknown commands fail closed; help alone is not a control-plane operation.
 */
export const CLI_TOOLS = {
  init: null,
  "project create": null,
  "project set-repo": null,
  "role list": null,
  "role show": null,
  "role add": null,
  "role copy": null,
  "role update": null,
  "role deactivate": null,
  "role activate": null,
  "role rollback": null,
  "role upgrade": null,
  "member add": null,
  "member list": null,
  "member update": null,
  "member deactivate": null,
  "member activate": null,
  "employee add": null,
  "employee list": null,
  "employee update": null,
  "employee deactivate": null,
  "employee activate": null,
  "avatar list": null,
  "pm create": null,
  "pm start": null,
  "pm rotate": null,
  "host-ops create": null,
  "host-ops start": null,
  "preference get": null,
  "preference set": null,
  "template list": null,
  "template show": null,
  "template add": null,
  "template copy": null,
  "template update": null,
  "template deactivate": null,
  "template activate": null,
  "template rollback": null,
  "card create": "create_card",
  "card update": "update_card",
  "card update --superseded-by": null,
  "card done": null,
  "card sensitive": null,
  "comment add": "post_comment",
  "attachment add": "upload_attachment",
  // C-81#10 exception: domain assign only; no token issuance or terminal start.
  assign: "assign",
  "assign --start": null,
  "token issue": null,
  "human-action done": null,
  "needs-you": "list_needs_you",
  "needs-you read": null,
  // C-81#10 exception: only notifications addressed to this exact Assignment.
  inbox: "get_updates",
  attention: null,
  "assignment start": null,
  "assignment stop": null,
  "assignment release": "release_assignment",
  "assignment attach": null,
  "merge status": null,
  "merge confirm": null,
  "merge hold": null,
  "merge request": null,
  "merge request-changes": null,
  "merge recheck": null,
  "worktree diff": null,
  "worktree clean": null,
  "worktree keep": null,
  "web set-password": null,
  launch: null,
} as const satisfies Record<string, ToolName | null>;

export function cliCommand(argv: readonly string[]): string {
  const [command = "", sub] = argv;
  if (
    command === "card" &&
    sub === "update" &&
    argv.some(
      (a) => a === "--superseded-by" || a.startsWith("--superseded-by="),
    )
  )
    return "card update --superseded-by";
  if (
    command === "assign" &&
    argv.some((a) => a === "--start" || a.startsWith("--start="))
  )
    return "assign --start";
  if (command === "needs-you")
    return sub === "read" ? "needs-you read" : command;
  if (["init", "assign", "inbox", "attention", "launch"].includes(command))
    return command;
  return `${command} ${sub ?? ""}`;
}

export function cliTool(command: string): ToolName | null {
  return Object.hasOwn(CLI_TOOLS, command)
    ? CLI_TOOLS[command as keyof typeof CLI_TOOLS]
    : null;
}

export function requireCliTool(actor: Actor, command: string): void {
  if (actor.kind === "human") return;
  const tool = cliTool(command);
  if (tool === null)
    throw new CliError("此命令仅限人类操作，Token 模式不可用。", EXIT.usage);
  if (actor.kind !== "assignment" || !actor.allowed_tools.includes(tool))
    throw new CliError(`Token 无权调用工具 ${tool}。`, EXIT.usage);
}

/** Remove only the global option; a launch child's arguments after -- are opaque. */
export function tokenFileOption(
  argv: readonly string[],
  io: CliIo,
): { argv: string[]; io: CliIo } {
  const rest: string[] = [];
  let tokenFile = io.tokenFile;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    if (arg !== "--token-file" && !arg.startsWith("--token-file=")) {
      rest.push(arg);
      continue;
    }
    if (tokenFile !== undefined)
      throw new CliError("--token-file 只能指定一次。", EXIT.usage);
    tokenFile =
      arg === "--token-file" ? argv[++i] : arg.slice("--token-file=".length);
    if (!tokenFile || tokenFile.startsWith("--"))
      throw new CliError("--token-file 需要一个文件路径。", EXIT.usage);
  }
  if (tokenFile !== undefined && io.env.CARDIGAN_TOKEN !== undefined)
    throw new CliError(
      "CARDIGAN_TOKEN 与 --token-file 不能同时提供。",
      EXIT.usage,
    );
  return {
    argv: rest,
    io: tokenFile === undefined ? io : { ...io, tokenFile },
  };
}
