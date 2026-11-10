import { readFile } from "node:fs/promises";
import { type Role, type ToolName, toolNames } from "@cardigan/domain";
import type { Harness } from "@cardigan/roles";
import { parse as parseYaml } from "yaml";
import { CliError, EXIT } from "./errors.js";

/**
 * `role.yaml` (M2.2): the full Role definition from §10.1.
 *
 * `role add --file` and `role update --file` read this file; `version` is not
 * part of it because the domain decides the next version (versions are
 * append-only). Optional lists default to empty.
 */
export interface RoleFile {
  readonly role_id: string;
  readonly display_name: string;
  readonly kind: Role["kind"];
  readonly core_prompt: string;
  readonly instructions?: string;
  readonly harness: Harness;
  readonly launch_profile_ref: string;
  readonly allowed_tools: readonly ToolName[];
  readonly capabilities: readonly string[];
  readonly abilities: readonly string[];
  readonly worktree: "none" | "write" | "readonly";
  readonly required_machine_tags: readonly string[];
}

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/;
const HARNESSES: readonly Harness[] = ["claude-code", "codex", "pi"];

function fail(message: string, details: string[] = []): never {
  throw new CliError(message, EXIT.usage, details);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`role.yaml 缺少 ${field}`);
  }
  return value;
}

function list(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(`role.yaml 的 ${field} 必须是字符串数组`);
  }
  return value as string[];
}

function tools(value: unknown): ToolName[] {
  const names = list(value, "allowed_tools");
  const known = new Set<string>(toolNames);
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    fail(`role.yaml 里有不认识的工具：${unknown.join(", ")}`, [
      `可用工具：${toolNames.join(", ")}`,
    ]);
  }
  return names as ToolName[];
}

function oneOf<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(`role.yaml 的 ${field} 必须是 ${allowed.join(" / ")}`);
  }
  return value as T;
}

/** Parse and validate one role definition file (pure apart from the file read). */
export function parseRoleFile(source: string, path: string): RoleFile {
  let decoded: unknown;
  try {
    decoded = parseYaml(source);
  } catch (error) {
    fail(`${path} 不是合法的 YAML`, [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    fail(`${path} 不是一个角色定义对象`);
  }
  const record = decoded as Record<string, unknown>;

  const roleId = text(record.role_id, "role_id");
  if (!IDENTIFIER.test(roleId)) {
    fail(`role_id 不合法：${roleId}；只允许小写字母、数字和 . _ -`);
  }
  if (record.version !== undefined) {
    fail("role.yaml 不要写 version：版本号由 store 决定（追加式）");
  }
  if (
    record.instructions !== undefined &&
    typeof record.instructions !== "string"
  ) {
    fail("role.yaml 的 instructions 必须是字符串");
  }

  return {
    role_id: roleId,
    display_name: text(record.display_name, "display_name"),
    kind: oneOf(record.kind, "kind", [
      "standing",
      "produce",
      "verify",
      "work",
    ] as const),
    core_prompt:
      record.core_prompt === undefined && record.instructions !== undefined
        ? ""
        : text(record.core_prompt, "core_prompt"),
    ...(record.instructions === undefined
      ? {}
      : { instructions: record.instructions as string }),
    harness: oneOf(record.harness, "harness", HARNESSES),
    launch_profile_ref: text(record.launch_profile_ref, "launch_profile_ref"),
    allowed_tools: tools(record.allowed_tools),
    capabilities: list(record.capabilities, "capabilities"),
    abilities: list(record.abilities, "abilities"),
    worktree: oneOf(record.worktree, "worktree", [
      "none",
      "write",
      "readonly",
    ] as const),
    required_machine_tags: list(
      record.required_machine_tags,
      "required_machine_tags",
    ),
  };
}

/** Read a role file and return a domain `Role` with the version filled in later. */
export async function readRoleFile(path: string): Promise<RoleFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    fail(`读不到角色文件：${path}`);
  }
  return parseRoleFile(text, path);
}

/** Legacy helper for callers that already hold a domain-assigned version. */
export function roleFromFile(file: RoleFile, version: number): Role {
  return { ...file, version };
}
