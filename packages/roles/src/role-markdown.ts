import { HARNESSES, type Role, toolNames } from "@cardigan/domain";
import { parse, stringify } from "yaml";
import { z } from "zod";

const id = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/u);
const list = z.array(z.string().refine((s) => s.trim().length > 0));
const tools = z.array(z.enum(toolNames));
const workItem = z.strictObject({
  key: z.string(),
  title: z.string(),
  required: z.boolean(),
  kind: z.enum(["produce", "verify"]),
  target_work_item_key: z.string().optional(),
  completion_criteria: list.optional(),
  requirements: z
    .strictObject({
      os: z.string().optional(),
      arch: z.string().optional(),
      tags: list.optional(),
      capabilities: list.optional(),
    })
    .optional(),
});
const header = z.strictObject({
  role_id: id,
  display_name: z.string().optional(),
  kind: z.enum(["produce", "verify", "standing", "work"]).optional(),
  based_on: z
    .string()
    .regex(/^(?:default:)?[a-z0-9][a-z0-9._-]*$/u)
    .optional(),
  launch_profile: z.string().min(1).optional(),
  harness: z.enum(HARNESSES).optional(),
  worktree: z.enum(["none", "readonly", "write"]).optional(),
  tools: z
    .union([
      z.strictObject({ set: tools }),
      z.strictObject({ add: tools.optional(), remove: tools.optional() }),
    ])
    .optional(),
  capabilities: list.optional(),
  abilities: list.optional(),
  required_capabilities: list.optional(),
  required_machine_tags: list.optional(),
  core_prompt: z.string().optional(),
  prompt_format: z.literal("legacy").optional(),
  template: z
    .strictObject({
      id,
      from: id.optional(),
      replace_role: id.optional(),
      add_work_item: workItem.optional(),
    })
    .refine(
      (t) => !!t.replace_role !== !!t.add_work_item,
      "请指定 replace_role 或 add_work_item，二选一",
    )
    .optional(),
  employees: z
    .array(
      z.strictObject({
        name: z.string(),
        title: z.string(),
        avatar: z.string().optional(),
        bio: z.string().optional(),
        launch_profile: z.string().min(1).optional(),
      }),
    )
    .optional(),
});
export class RoleMarkdownError extends Error {}
export function parseRoleMarkdown(markdown: string) {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(
    markdown,
  );
  if (!match?.[1]) throw new RoleMarkdownError("需要以 --- 包围的 YAML 文件头");
  let data: unknown;
  try {
    data = parse(match[1], { maxAliasCount: 0, prettyErrors: false });
  } catch {
    throw new RoleMarkdownError("文件头不是有效的 YAML，不能使用别名或重复键");
  }
  const result = header.safeParse(data);
  if (!result.success)
    throw new RoleMarkdownError(
      `角色文件字段不合法：${result.error.issues.map((i) => i.path.join(".") || i.message).join("、")}`,
    );
  if (result.data.prompt_format && result.data.core_prompt !== undefined)
    throw new RoleMarkdownError("旧格式的 core_prompt 只写在正文中");
  return {
    ...result.data,
    body: markdown.slice(match[0].length).replace(/\r?\n$/u, ""),
  };
}
export type RoleMarkdown = ReturnType<typeof parseRoleMarkdown>;

export function exportRoleMarkdown(role: Role): string {
  const {
    role_id,
    display_name,
    kind,
    harness,
    worktree,
    abilities,
    capabilities,
    required_machine_tags,
    required_capabilities,
  } = role;
  const meta = {
    role_id,
    display_name,
    kind,
    harness,
    launch_profile: role.launch_profile_ref,
    worktree,
    tools: { set: role.allowed_tools },
    abilities,
    capabilities,
    required_machine_tags,
    required_capabilities,
    ...(role.instructions === undefined
      ? { prompt_format: "legacy" }
      : { core_prompt: role.core_prompt }),
  };
  return `---\n${stringify(meta, { lineWidth: 0 })}---\n${role.instructions ?? role.core_prompt}\n`;
}
