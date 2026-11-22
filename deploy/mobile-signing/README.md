# 本地移动签名（C-500）

Q-963 只批准开发与隔离测试。不开开关、不配置专用账号、不逐件核准，就不能签。这里没有安装钩子、上传命令或发布身份。**不要在 Run 中执行以下管理操作。** 此目录只交付程序，不存放任何机器配置、材料或材料位置。

## 开通前的隔离检查

- 控制主机必须使用 `agent-ssh`。仅由人给指定产出角色加 `request_mobile_signature` 工具，在控制主机开启 `CARDIGAN_MOBILE_SIGNING=1`。默认角色不增加工具；旧令牌、无当前启动凭证的历史/复用 Run 不能签。
- 每条签名策略使用专用非管理员 UID，与所有项目的 Run、登录用户、发布账号隔离。禁止共享可写目录、钥匙串、进程调试权限、SSH 代理、上传凭据或通用 shell。控制主机、签名主机上的程序、解释器、工具及其父目录均由管理员安装，Run 不可写。签名账号不要安装项目插件；用系统策略禁止出站网络与交互授权弹窗。不能保证时保持关闭。
- 控制主机的 `$CONTROL` 固定为其数据目录下的 `mobile-signing`，与签名机上的 `$SIGNER` 分离。两个目录和它们的私有子目录是各自账号所有的 `0700` 实目录；文件 `0600`、无额外 ACL，父目录不能由 Run 替换。签名服务拒绝 root 和当前 Run 的实际 UID。先用**合成**身份从普通 Run 做跨 UID 验证，不要用生产密钥做读取/导出测试。
- `routes.json` 是控制账号私有的数组，每条包含 `project, machine, platform, app, version, peer`。`version` 是不含秘密的、不重复使用的凭据版本引用。`peer` 是本机 `ssh.conf` 中的专用别名，固定目标、签名用户、专用身份文件和独立 known-hosts；不开代理或回退身份。目标机仅允许来自控制主机的专用公钥，使用 `restrict` 加强制命令 `/usr/bin/python3 -IB <受管程序>/worker.py <签名私有目录>`；不开放端口、终端、SFTP、环境设置或此账号的其它登录方式。主机的 SSH 身份不是移动签名密钥。
- 每个签名端的 `identity.json` 对应唯一 `project, machine, platform, app, version` 和预先核准的叶证书小写 `cert_sha256`。Android 另固定 `aapt2, keytool, apksigner` 绝对路径、`keystore, alias, store_password_file, key_password_file`。签名之前用 `keytool -exportcert` 读取相同 keystore 文件和别名的公开证书并比对指纹，签后仍独立验签。轮换必须按版本原子更换文件，不能原位覆写。iOS 固定 `keychain, team, profile, profile_sha256, entitlements, frameworks`（框架目录名到 bundle ID 的字典）。文件路径均为签名机的受管绝对路径，与控制主机和 Run 无关。证书/描述文件有效性、来源、撤销情况由人在登记/换版时线下验证；不联网补证。iOS 凭据在专用钥匙串中，限制私钥导出和使用程序；人按需解锁，任务结束时服务锁回；锁回失败不出件。不得将上传账号导入此钥匙串。

## 人如何确认一份候选

1. 在无密钥环境生成未签 APK 或设备归档 ZIP。控制主机的受信收集方根据打包卡的构建记录，把确切字节和清单放入 `$CONTROL/incoming/`（不从 Agent 工作目录直接打开路径）。清单字段为：`project, machine, worker_uid, card, assignment, run, platform, id, version, app, build, commit, sha256, expires`。其中 UID/任务身份取自主机启动记录，`id` 为随机 32 位小写十六进制，`commit` 为完整 Git SHA，`sha256` 为逐字节输入摘要，`expires` 为 Unix 秒时间戳。以下 `$HOST` 代表已审核版本的 `host.py`。命令中的名称为私有暂存区的单个文件名。
2. `python3 -IB "$HOST" "$CONTROL" register manifest.json candidate.bin` 核摘要，将构建记录和私有输入副本冻结入账。此时仍不能签。人用 `show <id>` 对照实际打包记录、版本、应用、平台、目标机、摘要、有效期；只有人确认**完整清单**后才执行 `approve manifest.json`。命令前缀同 `register`。每个 Run 每个平台仅一份候选；改变候选需新 Run、新请求号和新批准。批准之前或之后可 `revoke <id>`；已经开始的私钥运算不能撤回，但撤销后不能重新用或导出。
3. Agent 工具只收 `platform: android | ios`。主机重新核验令牌、活跃产出、Run、启动代次、机器和 UID，选择相符的私有授权。worker 校验清单和输入副本后，主机再次核验及记账才发出一次签名许可。响应只含请求号、平台、阶段或结果摘要与只读下载句柄，不含工具输出、路径或钥匙串信息。
   - **受理后轮询，不重送**（C-598）：首次调用最多等约 2 秒就返回 `status: pending`、请求号和阶段（`queued` 未入账、`transferring` 传输输入或联系签名端、`signing` 已派发、等待签名和回传）。Agent 保持当前 Run，用同一平台再次调用，大约每 `poll_after_seconds` 一次；同一 Run 的在途请求只有一个，再次调用只返回进度，不会重新传输或签名。签名完成后返回 `status: signed` 的回执和下载句柄。直接作为 Card MCP 工具调用，不要经 shell、`curl` 或 `$CARDIGAN_RUN_COMMAND` 私用进程包装。轮询返回“签名未放行”时停止并报告，不重送；若服务端重启或进程中断，同一 Run 再次调用只按账本现有 lookup 取回同一请求号的结果。
   - **时限按大小计算**：主机程序按输入大小自定时限：`base_seconds + ceil(2 × 输入字节 ÷ bytes_per_second)`，默认 600 秒加每个方向 512 KiB/s（334 MB 的 APK 约 31 分钟）。已落盘产物的本地复核只用基础时限。如果链路更慢，可在 `$CONTROL/limits.json`（控制账号私有 `0600`）写 `{"base_seconds": 60–86400, "bytes_per_second": 16384–1073741824}`，任意一项可省略，越界或格式错误时不签。控制服务在主机报告的时限外再留 60 秒，然后先发 SIGTERM，30 秒后才强杀。主机自定时限到期记 `timed_out`，被终止记 `interrupted`，其它失败仍记 `not_released`；三者都是本次调用的终态事件，不代表远端签名结果，需要时先 `reconcile <id>` 核对。
4. 每个请求有控制端 `audit.sqlite`（`grants`, `events`）和签名端独立的 `receipts`。主机校验回执和最终字节，落盘、持久提交成功后才允许 `export <id>` 输出字节到管理员指定的**本地**文件。`show <id>` 可查 `registered / approved / pending / peer_signed / failed / signed`、是否撤销及结果摘要；`pending` 不是成功。断连、`timed_out` 或 `interrupted` 后，相同 Run 的再次请求只检索相同请求号，不能重签；`peer_signed` 时这次检索会把签名端的产物取回本地并复核摘要；若服务端也没有成功回执，保留未知并人工核对，不能删账本后重试。批准过期、策略被撤或凭据换版时不核发新签名。备份账本与输出时保持同等私有权限。异常终止的残余暂存只在签名账号内由人检查清理。

5. 打包 Run 可以使用回执中的 `download.query` 在**同一个已配置的 MCP 端点**以 GET 取回字节，使用当前会话的 Bearer 身份。先写入新建的本地临时文件，复算 SHA-256 比对回执后才交付。句柄本身不授予权限；服务端复核当前 Run、已批准并落账的产物、有效期及未撤销状态，发送前核对已打开的同一文件。失效句柄不出件；下载不提供签名、管理或上传功能。
6. 如果主机未记下成功、授权已过期或撤销，控制主机操作员可执行 `reconcile <id>`。它只能到**初次派发时固定的 peer** 按原号与完整清单查询回执状态和摘要，不读密钥、不发起签名、不退回产物字节，不要求原 Run 仍在场。请保留对应 peer 的可信 SSH 身份及旧回执。`peer_signed` 表示仅确认远端有签名回执，不是本地放行；`show` 的 `worker_receipt` 与主机复算后的 `output` 分开显示。过期、已撤销或策略已移除时，仍不能下载或导出。

## 首轮包格式和验收

- Android：只收有 AndroidManifest 且包名匹配的未签 APK；固定别名签名，必须通过 `apksigner verify --print-certs`、唯一证书指纹和输出包名核对。不收 AAB。
- iOS：ZIP 内唯一 `.xcarchive`，`Products/Applications` 下一个设备 `.app`，只接受未签 arm64 iOS 主程序与清单列出的普通 framework；允许归档外层 dSYM，不支持扩展、模拟器、通用切片、链接、已有签名/描述文件或未知可执行体。授权项必须与锁定的描述文件精确相容，不猜测通配符。由内到外逐项签名，核对团队、证书、Bundle ID 与授权项，再整体严格验签。交付摘要针对最终的 `.xcarchive.zip` 字节，不是目录摘要。两端都限制单包及展开总量 512 MiB、成员数 16000；不接受 ZIP64、归档注释、路径别名和非常规文件，超限留人工离线处理。APK 内只差大小写的成员名（如 AAPT2 缩短后的 `res/9n.9.png` 与 `res/9N.9.png`）是合法的：签名端把 APK 作为单个文件写入私有临时目录，检查时不解压成员，`aapt2`/`apksigner` 也直接读写整包，所以大小写不敏感的文件系统不会发生覆盖；完全相同的重复成员名仍拒绝。iOS 归档要解压到目录后签名，仍拒绝只差大小写的路径。以后若任何 Android 步骤需要把成员解压到文件系统，必须保留大小写别名检查（`inspect_zip` 传入解压目录时会自动执行），或改在大小写敏感的位置处理。
- 自动化夹具检查拒绝、重放、账本中断和签名调用/验签顺序，不能证明真实钥匙串、厂商工具链或现场账号隔离。合并后按 H-156 用测试身份核对普通 Run 无法读取、导出或绕过服务签名；最后与打包卡各自核准一个实际候选，记录输入/输出摘要、请求号、卡/Run 和独立验签结论。生产签名须另行逐件许可；商店、TestFlight 与下载站还需**单独**由人确认发布件摘要、版本、目标与渠道。

## 升级已有签名端程序（管理员）

C-548/C-551 只更新项目 worker 的三个 helper，**不更新独立签名端**。归档检查在签名端的 `archives.py` 中执行：C-582（APK 内点开头的路径段，如 Godot 的 `assets/.godot/`）、C-590（APK 内“-”开头的路径段，如 AAPT2 缩短后的 `res/-8.xml`）与 C-593（APK 内只差大小写的成员，如 `res/9n.9.png` 与 `res/9N.9.png`）都要按本节换版后才生效；只换其中一个文件不算升级，五个文件必须来自同一发行版并整体核对摘要。先确认含修复的控制主机发行版已部署成功。从该次部署记录定位不可变发行目录，不从 Git 工作树、Run 或待签附件取程序。在其 `deploy/mobile-signing` 目录执行：

```sh
/usr/bin/shasum -a 256 archives.py common.py host.py platforms.py worker.py | /usr/bin/shasum -a 256
```

通过受信管理通道把这五个文件放到签名机管理员专用暂存目录（`$STAGE`），另从控制主机记录取得上面输出的 64 位摘要（`$EXPECTED`，不要在签名机从待装文件计算期望值）。暂缓新签名并等在途请求结束。确认 `/opt/cardigan/deploy` 及祖先由管理员控制、无 Run/签名账号写权限或可写 ACL，目标是真实的**纯程序目录**，策略、密钥和审计账本均另存。管理员在签名机执行这一条命令；它只安装固定五份文件，核验新副本后才移开旧版：

```sh
sudo /bin/sh -eu -c '
  PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH
  cd /opt/cardigan/deploy
  test -d mobile-signing && test ! -L mobile-signing || exit 1
  work=$(mktemp -d .signer-upgrade.XXXXXX)
  mkdir -m 0755 "$work/new"
  for f in archives.py common.py host.py platforms.py worker.py; do
    install -o root -g wheel -m 0644 "$1/$f" "$work/new/$f"
  done
  actual=$(cd "$work/new" && shasum -a 256 archives.py common.py host.py platforms.py worker.py | shasum -a 256)
  test "${actual%% *}" = "$2"
  mv mobile-signing "$work/previous"
  mv "$work/new" mobile-signing || { mv "$work/previous" mobile-signing; exit 1; }
  printf "已安装；旧版保留在 %s/previous\n" "$work"
' sh "${STAGE:?需提供管理员暂存目录绝对路径}" "${EXPECTED:?需提供控制主机发行版摘要}"
```

若切换中断，保持停签，检查 `.signer-upgrade.*/previous`；确认本次备份后可恢复到原程序目录。不要改授权、删除账本或从工作树补文件。forced command 每次新建 Python 进程，下次连接即用新版。先验安装目录摘要与控制主机一致再恢复请求。新主机的 `show <id>` 在 `worker_receipt.failure_category` 显示签名端记录的固定失败类别；其中 `archive_member_name` 表示路径名或路径别名被拒（升级后对真实候选仍报此类别时，先核对安装目录摘要是否已是新版），`archive_too_large` 表示数量或大小超限，`package_mismatch` 表示包名不符，`apksigner_failed` 表示签名或验签失败。断连先 `reconcile <id>` 再 `show`。旧版失败回执没有该字段，不能据此推断原因。重送要在新 Run 中用新请求号重新登记并核准原候选摘要；不要沿用失败的批准。
