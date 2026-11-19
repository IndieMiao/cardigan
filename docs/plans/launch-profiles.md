# 启动配置分层（LP-1 至 LP-3）

依据 C-452 的方案附件。员工和角色仍只选 profile；不需要为每个模型、线路或推理强度建立新的角色或机器能力。机器能力仍是 `harness.codex`、`harness.claude-code`、`harness.pi`，版本来自机器登记。

- **LP-1（本卡）**：provider 管端点和凭据引用，model 管具体模型 ID 和元数据，profile 管 harness、模型别名及运行参数。CLI 和 server 读取配置时展开别名；编译器、线路诊断及 Run 快照看到同一套具体值。只改 `models.<别名>.id` 后重新加载配置，所有引用一起切换。
- **LP-2（C-453）**：配置热加载、校验、备份及受控换模型；本卡仍需重启 server，已有会话不变。
- **LP-3（C-454）**：收敛 harness 枚举和适配器；本卡不新增 harness，不接入 OpenCode、ACP 或新的模型路由器，不修改默认角色包。

## 迁移示例（仅示意，不含真实接入点或密钥）

旧文件不必改。没有 `models` 时不读取目录缓存、不联网；旧的 Codex `provider` 仍表示外部 `--profile`，旧 `config` 的顺序和 `args` 保持不变。例如原来每份 profile 都需要写：

```yaml
providers:
  relay: {harness: codex, secret_env: {RELAY_TOKEN: RELAY_SECRET}}
profiles:
  codex-astra:
    harness: codex
    provider: relay
    model: example-astra
    config:
      model_provider: relay
      model_providers.relay.name: Relay
      model_providers.relay.base_url: https://relay.example.invalid/v1
      model_providers.relay.wire_api: responses
      model_providers.relay.env_key: RELAY_TOKEN
      model_reasoning_effort: xhigh
      model_context_window: 872000
    args: [--yolo, --no-alt-screen]
```

改为：

```yaml
providers:
  relay:
    harness: codex
    api: openai-responses
    base_url: https://relay.example.invalid/v1
    secret_env: {RELAY_TOKEN: RELAY_SECRET}
    codex: {name: Relay, profile: relay, env_key: RELAY_TOKEN}
models:
  astra: {id: example-astra, provider: relay, context_window: 872000}
profiles:
  codex-astra: {harness: codex, model: astra, effort: xhigh, args: [--yolo, --no-alt-screen]}
```

- `model` 命中别名时，取该模型的具体 `id` 和接入点。未命中仍按旧格式解释为字面 ID，因此可逐份迁移；不要用现有字面 ID 为别的模型命名。重复写 `profile.provider` 时必须与模型的 provider 一致。
- Codex 的内联端点展开为 `model_provider`、`model_providers.<名字>.*`。只有原来需要 `--profile` 时才填写 `codex.profile`；内联端点不依赖外部命名配置。`codex.env_key` 是环境变量名，不是值（只有一个 `secret_env` 且不走 `requires_openai_auth` 时可省略）。模型窗口和 profile 的 `effort` 生成对应的 `-c` 参数；旧的显式 `config`、最后的 `args` 仍可覆盖，迁移时移走重复的覆盖项。
- Claude Code 用 `base_url` 生成 settings 的 `ANTHROPIC_BASE_URL`，`effort` 生成 `--effort`。Pi 用 `provider_flag`（引用别名时默认用 provider 名）和 `--model`；`effort` 对应 `--thinking`。Pi 的自定义端点须在其私有 models.json 中引用 `base_url_env` 指定的变量，本卡不改写 Pi 配置。声明 `api` 后可以省略 provider 的 `harness`，让兼容同一协议的 profile 复用端点和凭据映射。没有新协议或新机器能力。
- `secret_env` 仍然只是**环境变量名 → secrets.env 的键名**。只有启动时读取私有 `secrets.env`，原有权限检查不变。不要将生产的 YAML、settings 或密钥放进仓库。

## 模型目录和离线启动

有别名的配置按 `(catalog_provider 或 provider, id)` 精确匹配 `models.dev/api.json`；本地 provider 名不同于目录中的厂商名时，在模型上填 `catalog_provider`。不跨线路猜测同名模型的窗口。`limit.context`、`limit.output` 和 `reasoning_options` 中明确列出的 effort 值分别映射为 `context_window`、`max_output_tokens`、`reasoning_efforts`。三项均可本地逐字段覆盖；元数据不全时不从名字或推理开关猜数值或强度。

CLI 与 server 共用数据目录下的 `models-dev.json`，只保存获取时间和公开元数据，不保存原始响应、私有配置、主机端点或凭据。缓存新鲜时不发请求，过期后只向固定的公开地址刷新；不可达、超时、无效响应均退回已有缓存。缓存缺失或损坏时仍可用本地显式值。别名最终没有窗口（尤其是目录中没有的中转模型）时，校验报告缺少 `models.<别名>.context_window`，不会带着猜测的默认值启动。同步只读命令只用缓存和本地值，不联网。

`model_catalog.max_age_ms` 默认 86400000（一天），`timeout_ms` 默认 5000（五秒），`max_bytes` 默认 33554432（解压后 32 MiB，超限按刷新失败处理），均可在同一 YAML 的 `model_catalog` 下覆盖。部署后由维护者在私有主机对照五个既有 profile；本卡的测试使用脱敏配置、临时数据目录与内存中的目录响应，不访问生产文件或模型服务。
