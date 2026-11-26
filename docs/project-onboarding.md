# 接入一个新项目

在控制主机上用运行 server 的账号操作（不要 sudo）。下文 `<p>` 是新项目编号，`<src>` 是作为模板的现有项目。每做完几步跑一次：

```sh
cardigan project doctor --project <p>
```

它只读数据库和主机私有配置，不读凭据、不联网、不连 worker，按下表逐项列出 `✓` 已完成、`✗` 缺失（附怎么做）、`!` 提醒、`?` 需人工核对、`-` 不适用；有缺失时退出码为 1。

**要重启 server 的只有三处**：第 3 步改基线分支、第 7 步 `merge-gate.yaml`、第 19 步 `run-capacity.yaml`。三处都改完再一起重启一次。`merge-gate.yaml` 里的项目必须在 server 启动前已经建好，否则启动时判“项目未登记”。

## 步骤

| 步骤 | 做什么 | 怎么做 | 要重启 |
|---|---|---|---|
| 1 | 仓库克隆到主机 | `git clone` 并检出基线分支 | 否 |
| 2 | 建项目、登记代号 | `cardigan project create <p> --code <代号> --from <src>`（`--from` 同时完成第 4、6 步） | 否 |
| 3 | 登记仓库和基线 | `cardigan project set-repo --path <仓库> --base-branch <基线> --project <p>` | 改基线要（合并闸门在启动时读） |
| 4 | 角色 | 第 2 步带了 `--from` 就已完成；否则 `cardigan project copy-setup --from <src> --project <p>`。角色引用的启动配置必须在 `launch.yaml` 里 | 否 |
| 5 | 员工 | 员工是全局的：给现有员工加上本项目 `cardigan employee update <E-n> --projects <原项目>,<p>`（整表替换），或 `employee add`。常驻 PM 和主机运维各至少一名 | 否 |
| 6 | 项目偏好 | 同第 4 步一起复制；再把写着源仓库路径的偏好按新仓库改掉：`preference set high-risk-paths`、`auto-security-paths`、`role-rule-paths`、`system-merge-shadow-policy`（流程版本 ≥4 时先设它） | 否 |
| 7 | `merge-gate.yaml` 项目段和执行器 | 手改。用 GitHub 检查时照 [`templates/merge-gate-github-executor.yaml`](templates/merge-gate-github-executor.yaml) 加项目段、推送路线和**本项目专用**的执行器（一个执行器只服务一个项目） | **要** |
| 8 | GitHub App、部署密钥 | 所有者在 GitHub 上把 App 装到仓库、加可写的部署密钥 | 否 |
| 9 | 每条基线加检查工作流 | 复制 [`templates/cardigan-check.yml`](templates/cardigan-check.yml) 到每条基线的 `.github/workflows/cardigan-check.yml`，只换六步的命令；第 7 步的 `step_contract` 要与它一致 | 否（合同在第 7 步） |
| 10 | 常驻 PM Office、PM Ops、主机运维 | `cardigan pm create --office`、`pm create --ops`、`host-ops create`、`pm start`、`host-ops start`（都带 `--project <p>`） | 否 |
| 11 | 给常驻 PM 发开工指令 | 先建一张需求卡，在卡上评论点名 PM | 否 |
| 12–15 | 每台远程机器：配对向导、建账号、装 helper、开启远程派发、上线 | 按 [Linux](linux-worker.md)、[macOS](macos-worker.md) 手册；设备上建账号和装 helper 要 sudo。向导最后一步开启远程派发，再 `cardigan machine update <机器> --project <p> --status online` | 否 |
| 16 | `runtime-workers.yaml` 的 path、env | Workbench 向导开启远程派发时已写入；CLI 接入才手改。改动会换绑定指纹，第 17 步要重新登记 | 否 |
| 17 | `worktree-preparation.yaml` 准备证据 | 第 16 步定稿后，用 `--machine <机器>` 跑通一张小卡，按该 Run 的目标指纹登记 `<p>/<机器>`（键为 `target_fingerprint`、`os`、`arch`、`verified_at`、`expires_at`、`evidence_ref`）。没有它自动选机不会选这台 | 否 |
| 18 | helper 自动升级登记 | `sh deploy/enroll-helper-controller.sh prepare <p> <机器> --project-config`，再以 `activate` 运行一次，设备上 `sudo sh deploy/enroll-helper-worker.sh --project <p>` | 否 |
| 19 | `run-capacity.yaml` 项目上限、资源名额 | 可选，手改 `machines.<机器>.projects.<p>`；写错一处会让所有机器停止自动派发 | **要** |

只用本机（`local`）的项目跳过 12–18。

## 仍需手工的部分

- 主机：第 1 步克隆；第 7、19 步改 YAML 并重启；第 17 步登记证据（每台远程机器一条）。
- 所有者：第 8 步 GitHub 设置。
- 目标仓库：第 9 步提交工作流。工作流增删、改名或调整步骤时，同时改第 7 步执行器的 `step_contract`。
- 设备：第 12–15、18 步里要 sudo 的部分。
