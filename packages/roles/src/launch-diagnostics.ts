import type { LaunchConfig, LaunchProfileDefinition } from "./schema.js";

export interface LaunchWarning {
  readonly profile: string;
  readonly code: "codex_approval" | "codex_context_window" | "codex_screen";
  readonly message: string;
}

/** Only allowlisted settings are inspected; values, env and credentials never leave here. */
function codexSettings(profile: LaunchProfileDefinition) {
  const values: Record<string, unknown> = {
    approval_policy: profile.config?.approval_policy,
    model_context_window: profile.config?.model_context_window,
  };
  let approval: string | undefined;
  let bypass = false;
  let unresolved = false;
  let inline = false;
  const args = profile.args ?? [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") break;
    if (
      arg === "--yolo" ||
      arg === "--dangerously-bypass-approvals-and-sandbox"
    )
      bypass = true;
    else if (arg === "--no-alt-screen") inline = true;
    else if (["--full-auto", "--approve-for-me", "--remote"].includes(arg))
      unresolved = true;
    else if (arg === "-a" || arg === "--ask-for-approval") approval = args[++i];
    else if (arg.startsWith("--ask-for-approval="))
      approval = arg.slice(arg.indexOf("=") + 1);
    else if (arg.startsWith("-a") && arg.length > 2) approval = arg.slice(2);
    else {
      const override =
        arg === "-c" || arg === "--config"
          ? args[++i]
          : arg.startsWith("--config=")
            ? arg.slice(9)
            : arg.startsWith("-c") && arg.length > 2
              ? arg.slice(2)
              : undefined;
      if (override !== undefined) {
        const split = override.indexOf("=");
        const key = override.slice(0, split).trim();
        if (split > 0 && Object.hasOwn(values, key)) {
          const raw = override.slice(split + 1).trim();
          // Codex parses TOML, falling back to a string. These two settings
          // need only string/integer scalars; other syntax remains unknown.
          if (/^'[^']*'$/u.test(raw)) values[key] = raw.slice(1, -1);
          else if (raw.startsWith('"')) {
            try {
              values[key] = JSON.parse(raw);
            } catch {
              values[key] = undefined;
            }
          } else if (/^[+]?(?:0|[1-9][0-9]*(?:_[0-9]+)*)$/u.test(raw))
            values[key] = Number(raw.replaceAll("_", ""));
          else values[key] = raw;
        }
      }
    }
  }
  // Explicit CLI flags override -c / profile settings, regardless of argv order.
  const policy = approval ?? values.approval_policy;
  return {
    unattended:
      !unresolved && (bypass ? approval === undefined : policy === "never"),
    context:
      typeof values.model_context_window === "number"
        ? Number(values.model_context_window)
        : Number.NaN,
    inline,
  };
}

/** Compatibility advisories, deliberately separate from schema rejection. */
export function launchWarnings(config: LaunchConfig): LaunchWarning[] {
  return Object.entries(config.profiles).flatMap(([profile, definition]) => {
    if (definition.harness !== "codex") return [];
    const settings = codexSettings(definition);
    const warnings: LaunchWarning[] = [];
    if (!settings.unattended)
      warnings.push({
        profile,
        code: "codex_approval",
        message: "审批策略可能等待交互确认；请由主机管理员核对生效配置。",
      });
    if (!Number.isSafeInteger(settings.context) || settings.context <= 0)
      warnings.push({
        profile,
        code: "codex_context_window",
        message: "未明确配置有效的上下文窗口；请核对配置与模型默认容量。",
      });
    if (!settings.inline)
      warnings.push({
        profile,
        code: "codex_screen",
        message: "未关闭备用屏幕；终端滚动历史可能不可见。",
      });
    return warnings;
  });
}

export function reportLaunchWarnings(
  config: LaunchConfig,
  report: (message: string) => void,
) {
  for (const warning of launchWarnings(config))
    report(`启动配置告警 [${warning.profile}]：${warning.message}`);
}
