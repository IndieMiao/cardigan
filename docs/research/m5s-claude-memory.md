# M5.S S15：Claude Code 自动记忆验证

2026-11-07，使用本机已安装的 **Claude Code 2.1.318**，在独立临时 worktree、Assignment 配置目录和 PTY 中验证。没有调用真实模型，使用本机 HTTP 桩和虚构凭据；原有用户配置没有改动。每个 CLI 子进程都由创建它的测试按 PID 结束。

## 配置键的确认

在已完成引导的全新 `CLAUDE_CONFIG_DIR` 中打开 `/memory`，初始界面显示 `Auto-memory true`。上移选中该开关并按空格后，界面变为 false；检查 Claude 自己写入的 `settings.json`，新增内容为：

```json
{ "autoMemoryEnabled": false }
```

没有通过猜测或仅检查生成字符串确认这个键。

## 生成脚本的效果

执行 Cardigan 编译器生成的完整 `launch.sh`，保留首条位置参数、MCP 配置与 `--settings` 接线。HTTP 桩记录首条请求的 system 内容，随后在真实 CLI 中打开 `/memory`：

| 场景 | `/memory` | 发给模型的自动记忆指令 |
|---|---|---|
| 对照：临时启动 settings 改为 true | Auto-memory true | 包含写入 MEMORY.md 索引的指令 |
| Cardigan 生成 settings=false，既有私有 settings=true | Auto-memory false | 不包含该记忆指令 |
| 全新私有目录，由 launch.sh 预置 | Auto-memory false | 不包含该记忆指令 |

三种场景的首条消息均到达桩 API。第二种场景中，既有私有 settings 的 true 值原样保留，生效的是当前启动的 `--settings` 覆盖项；不清空记忆目录或 Session。新目录预置的 settings 本身也为 false。

## 回归范围

自动测试分别覆盖有 Provider 凭据和无凭据的 Assignment，确保生成的 `--settings` 都包含 false，且不泄露凭据；复用已有配置和 Session 的测试继续通过。通用的人工 `cardigan launch` 编译没有增加这项策略。

本次确认的是 2.1.318 的配置加载、界面状态与发给模型的上下文，不声称验证真实模型的长期行为；升级 CLI 后应复核。
