# 机器能力检查

能力由控制主机检查，以项目和机器分别保存；不使用人工标签作为验证证据。
后台启动立即检查，之后每 30 分钟巡检一次。`worker add/resume/check` 和
`machine check` 立即刷新；`machine show` 只读最近结果。检查不安装工具、不登录账号、
不修改机器管理状态，也不启用远程派发。

```sh
cardigan machine check <机器> --project <项目>
cardigan machine show <机器> --project <项目>
```

输出的 `capabilities` 包含能力键、版本、验证时间、证据引用和 `available`。
证据引用指向同次持久化的机器检查记录，并以能力键区分；不引用原始命令日志。
验证失败撤销上一轮能力；成功记录超过 24 小时后 `available=false`，未来时间也无效。
`health` 保存最近一次检查的结果、时间、阻断原因和启动开关；健康与能力分别显示。
健康检查失败或过期时不可视为可用，人工设置的 `status` 保持不变。
后台和 CLI 重叠检查时只有最新发起的一轮可以写回，检查中的旧能力立即失效。

内置能力有 Blender、Godot、NVIDIA/Apple GPU、Android SDK/模拟器、Xcode、
iOS 模拟器、Docker、Node、Python 和 Chromium。工具须在 worker 配置的 PATH 中；
Chromium 也支持常见 Chrome 与 Playwright 缓存位置。GPU/Xcode/iOS 按适用系统检查。
Docker 检查服务端可达；版本只保存数字版本段，原始横幅、账号信息和检查输出不落库。

自定义项写在控制主机配置目录的 `machine-capabilities.yaml` 中，目录与
`runtime-workers.yaml` 相同。目录须由主机账号持有，文件权限为 `0600`，不得为
符号链接或硬链接；不存在时使用内置目录，配置错误不会回退为成功。文件示例：

```yaml
version: 1
capabilities:
  lark-cli:
    os: [linux, darwin]              # 可省略，默认这两个系统
    check: [lark-cli, auth, status]
    version: [lark-cli, --version]  # 可省略，版本显示 null
```

键不可覆盖内置项，最多 64 个自定义项。命令是参数数组，不自动经 shell 展开。
检查命令退出码为 0 才通过；配置了版本命令时，该命令也须成功且输出可解析的数字版本。
命令由受信主机配置指定，不接受卡片、Token 或项目文件中的命令。
每个命令最多运行 10 秒、返回 16 KiB，超限视为失败；控制端另设 SSH 超时。
命令以项目 worker 账号经固定主机密钥的 SSH 执行，本机也沿已配置的执行账号运行；
传统 local 模式使用实际运行账号。只保留 PATH、账号 HOME 与固定语言环境，不传递主机 Token。
需要登录的 CLI 由人先在对应 worker 账号完成配置，检查不会创建凭据。

本阶段不改变选机、工作项需求、并发上限或界面。总体方案见
[机器能力标签与自动选机方案](plans/machine-capabilities.md)。
