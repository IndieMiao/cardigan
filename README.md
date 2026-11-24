# Cardigan

> Your agent office — 以卡片为中心的多 Agent 协作开发系统。

你和 PM Agent 讨论需求、查看进展、拍板；PM 分配任务、跟进进度；产品、设计、开发、测试等岗位 Agent 负责执行。所有协作都围绕"卡片 + 时间线"展开。

## 架构一句话

自研控制面（唯一事实来源，含看板） + [Herdr](https://github.com/herdrdev/herdr)（Agent 运行时和人工接管层） + 可插拔的 Agent CLI（Claude Code / Codex / OpenCode / Pi 等）。

- Agent 通过 Card MCP 读写事实。
- Herdr 只负责"按门铃"唤醒 Agent。
- 所有 Git 网络操作由主机发起，Agent 不持有任何 Git 凭据。

## 状态

Phase 0（预研与零代码验证）。技术栈已确定：TypeScript + pnpm workspace + SQLite + React（见开发方案 §15 D2）。

## 文档

- [开发方案](docs/development-plan.md)：选型、架构、领域模型、协议、部署、路线图、待定决策
- [AGENTS.md](AGENTS.md)：参与开发的 Agent 必须遵守的规则
- [接入一台 Linux worker](docs/linux-worker.md)：人专属接入命令、私有配置与逐步检查

## 本地开发

使用 pnpm 11.7.0。项目通过 `devEngines.runtime` 自动下载并使用 Node 24，
不需要修改系统 Node；运行工具时使用 `pnpm run` 或 `pnpm exec`。

```bash
pnpm install
pnpm exec node -v
pnpm build
pnpm test
pnpm lint
pnpm check:deps
```

`pnpm --filter @cardigan/web dev` 启动标题页。当前仅有 Phase 0 的包骨架，
尚未实现服务端、数据库、领域模型或看板功能。

根 `tsconfig.json` 用 project references 构建所有包。包间暂时没有依赖；
后续增加依赖时，在调用方声明 `workspace:*` 和对应的 TypeScript reference。
`pnpm check:deps` 检查生产源码，只允许引用更低层的内部包，并禁止领域包
引入外部包或 Node IO 模块。测试文件不受生产源码的依赖规则约束。

## 本地启动（M1 控制面）

单机跑通一条卡片流程需要三个进程：数据库、控制面 server、Agent。数据库和 Token
都在主机侧（你自己的终端）管理，Agent 只拿到 Token。

```bash
pnpm build

# 1. 数据库、项目、角色（角色定义 allowed_tools 和 capabilities）
pnpm --filter @cardigan/cli exec cardigan init
pnpm --filter @cardigan/cli exec cardigan project create p-demo --code DEM
pnpm --filter @cardigan/cli exec cardigan role add p-demo pm \
  --allowed-tools create_card,update_card,create_work_item,update_work_item,assign,submit_review,record_decision,post_comment,request_decision,request_human_action,project_snapshot,list_needs_you,get_card,get_updates,ack_events,whoami,heartbeat,finish_run \
  --capabilities manage
pnpm --filter @cardigan/cli exec cardigan role add p-demo coder \
  --allowed-tools submit_delivery,post_comment,request_decision,report_blocker,get_card,get_updates,ack_events,whoami,heartbeat,finish_run \
  --capabilities code
pnpm --filter @cardigan/cli exec cardigan role add p-demo reviewer \
  --allowed-tools submit_review,post_comment,get_card,get_updates,ack_events,whoami,heartbeat,finish_run \
  --capabilities review

# 2. 常驻 PM（--office 可记录拍板；--ops 的 Token 不含 record_decision）
pnpm --filter @cardigan/cli exec cardigan pm create --office   # 打印 Token，只显示一次

# 3. 建卡、指派、签发 Token（Token 只在终端打印一次，数据库只存哈希）
#    人默认只能开需求卡（story），先放开 dev 模板才能直接开开发卡
pnpm --filter @cardigan/cli exec cardigan preference set human-card-templates dev on
pnpm --filter @cardigan/cli exec cardigan card create --template dev \
  --title "示例卡" --goal "跑通一条流程" --acceptance "测试通过" --repo example/repo
pnpm --filter @cardigan/cli exec cardigan assign W-1 --role coder
pnpm --filter @cardigan/cli exec cardigan token issue A-1   # 已有 Token 会先作废

# 4. 启动 MCP 端点（只监听 127.0.0.1，默认 3004）
pnpm --filter @cardigan/server exec cardigan-server
# 或者：CARDIGAN_DATA_DIR=.data CARDIGAN_MCP_PORT=3004 node apps/server/dist/bin.js
```

Agent 侧把 MCP 端点指到 `http://127.0.0.1:3004/mcp`，用 `Authorization: Bearer <Token>`
认证；`whoami` 可以确认身份与允许的工具。`cardigan human-action done h(n) --text "结果"`
用来代替 M5 之前的 Needs You 界面。

`--project` 省略时取 `CARDIGAN_PROJECT`，再取数据库里唯一的项目；`--data-dir` 省略时取
`CARDIGAN_DATA_DIR`，再取 `.data`。Token 不写文件、不进日志、不进幂等缓存，只在签发时
打印一次，丢了就用 `cardigan token issue <A-n>` 重新签发（旧 Token 立即作废）。

## 启动配置与 `cardigan launch`（替代 shell 别名）

人和 Agent 用同一套配置启动 Agent CLI：接入点（Provider）描述 Harness 和地址，
启动配置（Launch Profile）描述具体用哪个接入点、模型和参数。配置不进仓库，
也不进数据库（开发方案 §10.2、§14）。

| 文件 | 内容 | 权限 |
|---|---|---|
| `~/.config/cardigan/launch.yaml` | 接入点和启动配置，不含密钥 | 0600 |
| `~/.config/cardigan/secrets.env` | 每行一个 `KEY=VALUE`，权限必须是 600 | 0600 |

用 `CARDIGAN_CONFIG_DIR` 可以换配置目录（做实验时用临时目录，别动真实配置）。
`launch.yaml` 的字段：

```yaml
providers:
  of:
    harness: claude-code          # claude-code | codex | pi
    env:                          # 明文环境变量
      ANTHROPIC_BASE_URL: https://example.invalid
    secret_env:                   # 变量名 → secrets.env 里的键（只写名字）
      ANTHROPIC_AUTH_TOKEN: OF_AUTH_TOKEN
profiles:
  claude-of:
    harness: claude-code
    provider: of
    model: opus
    permission_mode: bypassPermissions   # 仅 claude-code
    auto_update: false                   # 仅 claude-code；false 时设 DISABLE_AUTOUPDATER=1
    args: ["--effort", "low"]           # 追加在 Cardigan 生成的参数之后
  codex-yolo:
    harness: codex
    provider: cx
    model: gpt-6-astra
    config:                              # 仅 codex：展开成 -c key=value
      model_reasoning_effort: low
    args: ["--yolo", "--no-alt-screen"]
  pi-deepseek:
    harness: pi
    provider_flag: deepseek              # 仅 pi：展开成 --provider
    model: deepseek-flash
    agent_dir: /srv/cardigan/pi-home     # 仅 pi：设 PI_CODING_AGENT_DIR
```

字段放错 Harness（例如给 codex 写 `permission_mode`）会被拒绝，避免静默失效。
`auto_update` 只在 claude-code 上有作用：写 `false` 会设 `DISABLE_AUTOUPDATER=1`，
不写则不动 CLI 自己的更新设置；M2 接 Agent 时用的配置应显式写 `false`。

### 命令

```bash
pnpm --filter @cardigan/cli build          # 先构建，生成 apps/cli/dist/bin.js
cardigan launch --list                     # 列出启动配置
cardigan launch claude-of --print          # 只打印实际命令、环境变量和临时文件（密钥显示 ***）
cardigan launch check claude-of            # 检查 CLI 是否安装、版本、密钥是否齐全、密钥文件权限
cardigan launch claude-of                  # 在当前终端启动，标准输入输出和退出码原样传递
cardigan launch claude-of --cwd ~/projects/x -- --resume
cardigan launch import-claude-settings ~/.claude/settings.json --provider of
```

`cardigan` 目前只实现了 `launch`；`init`、`project`、`role`、`card`、`assign`
等命令在 M1 的后续任务里加入。想从源码目录直接跑：

```bash
export CARDIGAN_CONFIG_DIR="$HOME/.config/cardigan"
alias cardigan="node /path/to/cardigan/apps/cli/dist/bin.js"
```

### 各 Harness 生成什么

| Harness | 生成方式 |
|---|---|
| Claude Code | 在 `$XDG_RUNTIME_DIR/cardigan/`（没有就用 `~/.cache/cardigan/run/`）生成 `cardigan-<pid>-<随机8位>.<启动配置>.claude-settings.json`，权限 600，用 `--settings` 传入，CLI 退出后删除。接入点的 `env` 和解析后的密钥写进该文件的 `env`，不放进进程环境 |
| Codex | 只拼参数：`--profile <接入点>`、`-c key=value`（来自 `config`）、`-m <模型>`、`args`、`--` 之后的参数；不改 `~/.codex` |
| Pi | 拼 `--provider`、`--model`、`args`；需要时设 `PI_CODING_AGENT_DIR`；不改 `~/.pi` |

`cardigan launch` 从不写 `~/.claude`、`~/.codex`、`~/.pi`，也不改 shell 配置、
不写数据库、不注入 MCP 配置（后者在 M2）。

### 信号、并发与残留文件

- 文件名带 pid 和随机后缀，同一个启动配置并发启动多次不会互相覆盖，也不会删掉对方正在用的文件。
- CLI 运行期间父进程忽略 `SIGINT`/`SIGQUIT`（Ctrl+C、Ctrl+\ 由终端同时发给 CLI 自己），收到
  `SIGTERM`/`SIGHUP` 时转发给 CLI；CLI 退出后父进程才删除临时文件，并原样返回 CLI 的退出码。
  所以 Ctrl+C 只打断 CLI，不会让 shell 提前拿回提示符。
- 每次 `launch` 开始前会清理运行目录里属主进程已经不存在的临时文件（例如上次被 `SIGKILL`）；
  `cardigan launch check <启动配置>` 会报告残留文件数量。

### 从现有的 shell 别名迁移

迁移由你自己执行，Agent 不碰你的真实配置：

1. 用 `cardigan launch import-claude-settings <原来的 settings.json> --provider <名字>`
   把现有 Claude Code 网关配置转成接入点。名字里含 `TOKEN`、`KEY`、`SECRET` 的变量
   进 `secrets.env`，其余进 `launch.yaml`；命令只打印变量名，不打印值。
2. 按原来的别名补 `profiles` 条目（模型、权限模式、额外参数）。
3. 用 `cardigan launch <启动配置> --print` 核对命令与参数，再 `cardigan launch check`
   确认 CLI 版本和密钥齐全。
4. 确认无误后，从 shell 配置里删掉对应别名，改用 `cardigan launch <启动配置>`。
5. `secrets.env` 若是从旧文件复制来的，执行 `chmod 600 ~/.config/cardigan/secrets.env`。

`launch.yaml` 和 `secrets.env` 都放在 `~/.config/cardigan/`（或用私有的
`cardigan-deploy` 管理），永远不要提交进仓库。

## 仓库结构

见开发方案 §20。
