# 本地移动签名（C-500）

Q-963 只批准开发与隔离测试。不开开关、不配置专用账号、不逐件核准，就不能签。这里没有安装钩子、上传命令或发布身份。**不要在 Run 中执行以下管理操作。** 此目录只交付程序，不存放任何机器配置、材料或材料位置。

## 开通前的隔离检查

- 控制主机必须使用 `agent-ssh`。仅由人给指定产出角色加 `request_mobile_signature` 工具，在控制主机开启 `CARDIGAN_MOBILE_SIGNING=1`。默认角色不增加工具；旧令牌、无当前启动凭证的历史/复用 Run 不能签。
- 每条签名策略使用专用非管理员 UID，与所有项目的 Run、登录用户、发布账号隔离。禁止共享可写目录、钥匙串、进程调试权限、SSH 代理、上传凭据或通用 shell。控制主机、签名主机上的程序、解释器、工具及其父目录均由管理员安装，Run 不可写。签名账号不要安装项目插件；用系统策略禁止出站网络与交互授权弹窗。不能保证时保持关闭。
- 控制主机的 `$CONTROL` 固定为其数据目录下的 `mobile-signing`，与签名机上的 `$SIGNER` 分离。两个目录和它们的私有子目录是各自账号所有的 `0700` 实目录；文件 `0600`、无额外 ACL，父目录不能由 Run 替换。签名服务拒绝 root 和当前 Run 的实际 UID。先用**合成**身份从普通 Run 做跨 UID 验证，不要用生产密钥做读取/导出测试。
- `routes.json` 是控制账号私有的数组，每条包含 `project, machine, platform, app, version, peer`。`version` 是不含秘密的、不重复使用的凭据版本引用。`peer` 是本机 `ssh.conf` 中的专用别名，固定目标、签名用户、专用身份文件和独立 known-hosts；不开代理或回退身份。目标机仅允许来自控制主机的专用公钥，使用 `restrict` 加强制命令 `/usr/bin/python3 -IB <受管程序>/worker.py <签名私有目录>`；不开放端口、终端、SFTP、环境设置或此账号的其它登录方式。主机的 SSH 身份不是移动签名密钥。
- 每个签名端的 `identity.json` 对应唯一 `project, machine, platform, app, version` 和预先核准的叶证书小写 `cert_sha256`。Android 另固定 `aapt2, apksigner` 绝对路径、`keystore, alias, store_password_file, key_password_file`。iOS 固定 `keychain, team, profile, profile_sha256, entitlements, frameworks`（框架目录名到 bundle ID 的字典）。文件路径均为签名机的受管绝对路径，与控制主机和 Run 无关。证书/描述文件有效性、来源、撤销情况由人在登记/换版时线下验证；不联网补证。iOS 凭据在专用钥匙串中，限制私钥导出和使用程序；人按需解锁，任务结束时服务锁回；锁回失败不出件。不得将上传账号导入此钥匙串。

## 人如何确认一份候选

1. 在无密钥环境生成未签 APK 或设备归档 ZIP。控制主机的受信收集方根据打包卡的构建记录，把确切字节和清单放入 `$CONTROL/incoming/`（不从 Agent 工作目录直接打开路径）。清单字段为：`project, machine, worker_uid, card, assignment, run, platform, id, version, app, build, commit, sha256, expires`。其中 UID/任务身份取自主机启动记录，`id` 为随机 32 位小写十六进制，`commit` 为完整 Git SHA，`sha256` 为逐字节输入摘要，`expires` 为 Unix 秒时间戳。以下 `$HOST` 代表已审核版本的 `host.py`。命令中的名称为私有暂存区的单个文件名。
2. `python3 -IB "$HOST" "$CONTROL" register manifest.json candidate.bin` 核摘要，将构建记录和私有输入副本冻结入账。此时仍不能签。人用 `show <id>` 对照实际打包记录、版本、应用、平台、目标机、摘要、有效期；只有人确认**完整清单**后才执行 `approve manifest.json`。命令前缀同 `register`。每个 Run 每个平台仅一份候选；改变候选需新 Run、新请求号和新批准。批准之前或之后可 `revoke <id>`；已经开始的私钥运算不能撤回，但撤销后不能重新用或导出。
3. Agent 工具只收 `platform: android | ios`。主机重新核验令牌、活跃产出、Run、启动代次、机器和 UID，选择相符的私有授权。worker 校验清单和输入副本后，主机再次核验及记账才发出一次签名许可。响应只含请求号、平台和结果摘要，不含工具输出、路径或钥匙串信息。
4. 每个请求有控制端 `audit.sqlite`（`grants`, `events`）和签名端独立的 `receipts`。主机校验回执和最终字节，落盘、持久提交成功后才允许 `export <id>` 输出字节到管理员指定的**本地**文件。`show <id>` 可查 `registered / approved / pending / failed / signed`、是否撤销及结果摘要；`pending` 不是成功。断连后相同 Run 的再次请求只检索相同请求号，不能重签；若服务端也没有成功回执，保留未知并人工核对，不能删账本后重试。批准过期、策略被撤或凭据换版时不核发新签名。备份账本与输出时保持同等私有权限。异常终止的残余暂存只在签名账号内由人检查清理。

## 首轮包格式和验收

- Android：只收有 AndroidManifest 且包名匹配的未签 APK；固定别名签名，必须通过 `apksigner verify --print-certs`、唯一证书指纹和输出包名核对。不收 AAB。
- iOS：ZIP 内唯一 `.xcarchive`，`Products/Applications` 下一个设备 `.app`，只接受未签 arm64 iOS 主程序与清单列出的普通 framework；允许归档外层 dSYM，不支持扩展、模拟器、通用切片、链接、已有签名/描述文件或未知可执行体。授权项必须与锁定的描述文件精确相容，不猜测通配符。由内到外逐项签名，核对团队、证书、Bundle ID 与授权项，再整体严格验签。交付摘要针对最终的 `.xcarchive.zip` 字节，不是目录摘要。两端都限制单包及展开总量 512 MiB、成员数 16000；不接受 ZIP64、归档注释、路径别名和非常规文件，超限留人工离线处理。
- 自动化夹具检查拒绝、重放、账本中断和签名调用/验签顺序，不能证明真实钥匙串、厂商工具链或现场账号隔离。合并后按 H-156 用测试身份核对普通 Run 无法读取、导出或绕过服务签名；最后与打包卡各自核准一个实际候选，记录输入/输出摘要、请求号、卡/Run 和独立验签结论。生产签名须另行逐件许可；商店、TestFlight 与下载站还需**单独**由人确认发布件摘要、版本、目标与渠道。
