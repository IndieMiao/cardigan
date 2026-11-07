# M2.S：Harness 首次启动信任验证

对应修复任务 `fix/codex-trust-worktree`。2026-11-07 在 Linux PTY 中验证 Codex **0.161.0** 和 Claude Code **2.1.318**；Claude 使用本机已安装的精确版本，不使用默认的 2.1.319。所有目录、Git 仓库和配置均为独立临时夹具，不修改用户配置，不调用 sudo，也不启动 hc。

## 方法

1. 用真实 Git 创建基础仓库 `repos/sample`、提交和 linked worktree `worktrees/sample/A-1`；另外建非仓库的常驻 PM 运行目录。
2. 用全新 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` 启动交互 CLI，复现拦截；在临时夹具中完成引导，查看 CLI 实际写入的文件。
3. 用独立的新目录验证最小预置配置，再用本次编译器生成的完整 `launch.sh` 验证。包装器实际读取 token、first.md、start 哨兵并 exec CLI，首条消息是唯一的测试标记。
4. 用 Python pexpect 提供 PTY，只回复终端能力查询，不发送确认、回车或任务输入。模型地址指向临时的本机 HTTP 桩，凭据为虚构值；桩捕获 `/v1/responses` 或 `/v1/messages` 的请求正文并返回固定文本，断言首条标记确实进入请求。Card MCP 也使用本地初始化／空工具表桩。
5. 每次关闭 PTY 子进程，最后关闭 HTTP 桩；没有使用真实模型或项目数据。

## Codex 0.161.0

无预置信任时显示 `Trust this folder?`，并明确提示信任将作用于基础仓库根。`git rev-parse --path-format=absolute --git-common-dir` 返回 `repos/sample/.git`。手动确认后 Codex 写入：

```toml
[projects."<fixture>/repos/sample"]
trust_level = "trusted"
```

生成器登记且仅登记 `worktrees/sample/A-1` 和 `repos/sample` 两个精确路径；没有 worktree 时只登记 cwd。生成的 `launch.sh` 在新 `CODEX_HOME` 下启动后不出现信任屏，首条位置参数标记进入 `/v1/responses`，无需按键。

## Claude Code 2.1.318

全新目录依次复现主题、Security notes、Quick safety check、Bypass Permissions mode 四屏。选择后查看实际文件，确认状态分布在两个文件，不能只猜测 `.claude.json` 的键：

```json
{
  "hasCompletedOnboarding": true,
  "lastOnboardingVersion": "2.1.318",
  "projects": {
    "<assignment cwd>": { "hasTrustDialogAccepted": true }
  }
}
```

`settings.json`：

```json
{
  "theme": "dark",
  "skipDangerousModePermissionPrompt": true
}
```

手动点击 worktree 的信任屏时 Claude 会记录基础仓库根；单独实测确认只登记精确 cwd 也能跳过该屏，因此生成器不扩大 Claude 的信任范围。

使用 `--permission-mode bypassPermissions` 分别验证 worktree 和非仓库 PM 目录。由生成的 `launch.sh` 首次写入以上内容后，两种情况均没有四屏引导，位置参数的首条消息进入 `/v1/messages`，并显示桩返回的 `PROBE_OK`；没有人工确认或重新输入消息。

完整脚本验证还发现：仅预置引导状态仍会空闲，因为 `--allowedTools <tools...>` 会消费末尾的首条消息。反向实测不加分隔符时 35 秒内没有带标记的 API 请求；在消息前加 `--` 后，两种 cwd 的首条消息都自动提交。修复只在 Claude 的启动参数末尾增加分隔符，Codex 和 Pi 的参数不变。

## 自动回归与边界

- roles 测试逐项检查 Codex 的两个信任路径、无 worktree 的单路径、去重与 TOML 引号转义；保留三个 Harness 首条消息逐字传递测试。
- CLI 测试通过真实 Git 创建托管 worktree，核对生成的 Codex 仓库根确为 common dir 所属仓库；生产主机不进入 Agent 目录执行 Git。
- host 测试执行生成的包装器，覆盖 local / agent-ssh 接线、目录 0700 和文件 0600、运行 UID、预置内容及首条参数；`resume_or_replace` 保留已有 `.claude.json`、用户改过的 settings 和 sessions。
- 反向注入：临时移除 Codex 信任表、禁用 Claude 首次预置、移除消息前的 `--`，重新编译后上述 6 条针对性用例全部按预期失败；验证后恢复源码并重新编译。
- 实测只验证上述 CLI 版本。将来升级 Harness 应重复检查；已有 `.claude.json` 原样保留，未完成引导的旧配置不自动改写。
- 自动化 agent-ssh 夹具在测试 UID 下模拟 Agent 入口；本次未执行跨 UID 的真实 SSH 冒烟。模型和 MCP 是桩，验证的是交互启动与首条消息提交，不是模型完成真实工作的能力。
