import { errorCodes, runtimeErrorCodes } from "@cardigan/domain";
import { ERROR_CODES, ToolError } from "@cardigan/mcp-server";
import { describe, expect, test } from "vitest";
import { formatCommandError, formatLaunchError } from "./errors.js";

const cases = [
  ["not_found", "对象在当前项目中不存在"],
  ["illegal_transition", "当前状态不允许执行此操作"],
  ["invariant_violation", "操作不符合业务约束"],
  ["validation_failed", "参数未通过校验，请检查输入"],
  ["unauthorized", "当前身份无权执行此操作"],
  ["forbidden_tool", "当前角色不允许使用此工具"],
  ["idempotency_conflict", "同一幂等键已用于不同的请求，请使用新的幂等键"],
  ["stale_target", "目标版本已过期，请读取最新版本后重试"],
  ["runtime_not_found", "运行终端不存在或已结束"],
  ["runtime_unavailable", "运行时不可用，请检查运行服务"],
  ["version_mismatch", "运行时版本不兼容，请检查安装的版本"],
  ["runtime_timeout", "运行时响应超时，请稍后重试"],
  ["runtime_conflict", "运行时存在冲突，请检查已有终端"],
  ["invalid_launch", "启动配置不合法，请检查配置"],
] as const;

describe("Chinese CLI errors", () => {
  test("covers every domain, MCP and runtime error code", () => {
    expect(cases.map(([code]) => code).sort()).toEqual(
      [
        ...new Set([...errorCodes, ...ERROR_CODES, ...runtimeErrorCodes]),
      ].sort(),
    );
  });

  test.each(cases)(
    "formats %s with operation, object and code",
    (code, reason) => {
      expect(
        formatCommandError("指派工作项", "W-7", {
          code,
          message: "Rejected by service",
        }),
      ).toBe(`无法指派工作项 W-7：${reason}（${code}）`);
    },
  );

  test.each(["future_error", "toString", "__proto__"])(
    "keeps the original message for unknown code %s",
    (code) => {
      expect(
        formatCommandError("更新卡片", "C-3", {
          code,
          message: "New upstream failure",
        }),
      ).toBe(`无法更新卡片 C-3：操作被拒绝：New upstream failure（${code}）`);
    },
  );

  test("handles an empty unknown message", () => {
    expect(
      formatCommandError("更新卡片", "C-3", { code: "unknown", message: "" }),
    ).toBe("无法更新卡片 C-3：操作被拒绝（unknown）");
  });

  test("preserves existing Chinese recovery guidance", () => {
    expect(
      formatCommandError("签发 Token", "A-1", {
        code: "illegal_transition",
        message: "Assignment 已暂停，请先恢复",
      }),
    ).toBe(
      "无法签发 Token A-1：Assignment 已暂停，请先恢复（illegal_transition）",
    );
  });

  test("accepts MCP ToolError directly", () => {
    expect(
      formatCommandError(
        "上传附件",
        "C-1",
        ToolError.notFound("Attachment basis was not found"),
      ),
    ).toBe("无法上传附件 C-1：附件依据的拍板在当前项目中不存在（not_found）");
  });

  test.each([
    [
      "validation_failed",
      "original_filename must be at most 200 characters",
      "附件文件名不能超过 200 字符",
    ],
    [
      "validation_failed",
      "note must be at most 200 characters",
      "附件说明不能超过 200 字符",
    ],
    [
      "validation_failed",
      "original_filename must not contain control characters",
      "附件文件名不能包含控制字符",
    ],
    [
      "validation_failed",
      "note must not contain control characters",
      "附件说明不能包含控制字符",
    ],
    ["validation_failed", "title is required", "标题不能为空"],
    ["validation_failed", "goal is required", "目标不能为空"],
    [
      "validation_failed",
      "Acceptance criteria are required",
      "至少需要一条非空的验收标准",
    ],
    [
      "validation_failed",
      "Invalid priority",
      "优先级必须是无、低、中、高或紧急",
    ],
    ["not_found", "cards:C-99 was not found", "卡片 C-99 在当前项目中不存在"],
    [
      "invariant_violation",
      "A work item has one persistent assignment",
      "这个工作项已经有负责的 Assignment，不能再指派新的",
    ],
    [
      "illegal_transition",
      "Cannot apply cancel to card:done",
      "已完成卡片不能取消；请建新卡（例如回滚卡），再用 --superseded-by <C-m> 标记旧卡",
    ],
    [
      "illegal_transition",
      "Cannot apply set_todo to card:review",
      "不允许从 review 转为 todo",
    ],
    [
      "illegal_transition",
      "Only done or cancelled cards can be superseded",
      "只有已完成或已取消的卡片才能标记为被取代",
    ],
    [
      "validation_failed",
      "A card cannot supersede itself",
      "卡片不能被自身取代",
    ],
    [
      "validation_failed",
      "A standing Assignment cannot change its mode",
      "常驻 Assignment 不能更改模式",
    ],
    ["validation_failed", "Attachment exceeds 10 MiB", "附件超过 10 MiB"],
    [
      "validation_failed",
      "File must be canonical padded base64",
      "附件编码不合法",
    ],
    [
      "validation_failed",
      "Attachment sha256 does not match content",
      "附件 SHA-256 校验失败",
    ],
    [
      "validation_failed",
      "Attachment storage failed",
      "附件存储失败，请检查数据目录权限和已存文件的完整性",
    ],
    [
      "validation_failed",
      "Artifacts require a decision basis",
      "artifact 附件必须提供 --basis 拍板编号",
    ],
    [
      "validation_failed",
      "Attachment target belongs to another card",
      "附件挂载条目属于另一张卡片",
    ],
    [
      "not_found",
      "Attachment target was not found",
      "附件挂载条目在当前项目中不存在",
    ],
  ])("explains recognizable %s: %s", (code, message, reason) => {
    expect(formatCommandError("处理", "目标", { code, message })).toBe(
      `无法处理 目标：${reason}（${code}）`,
    );
  });

  test.each([
    [
      "illegal_transition: Cannot apply dispatch to run:completed",
      "当前状态不允许执行此操作（illegal_transition）",
    ],
    [
      "provision failed: runtime_unavailable lost connection",
      "运行时不可用，请检查运行服务（runtime_unavailable）",
    ],
    [
      "future_error: New launch failure",
      "操作被拒绝：New launch failure（future_error）",
    ],
  ])("translates wrapped host errors: %s", (message, reason) => {
    expect(formatLaunchError("A-1", message)).toBe(
      `无法启动 Assignment A-1：${reason}`,
    );
  });

  test("uses a structured launch cause before its wrapper text", () => {
    const error = new Error("Agent 命令失败：runtime_timeout timed out", {
      cause: { code: "runtime_timeout", message: "timed out" },
    });
    expect(formatLaunchError("A-1", error)).toBe(
      "无法启动 Assignment A-1：运行时响应超时，请稍后重试（runtime_timeout）",
    );
  });

  test("leaves uncoded launch failures to the existing reporter", () => {
    expect(
      formatLaunchError("A-1", "Cannot write launch directory"),
    ).toBeUndefined();
  });
});
