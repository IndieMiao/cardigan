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
   - **发布链自动登记**（C-612）：内部 Android 测试包可以不走第 2 步的人工 `register`/`approve`。打包卡上有已批准的发布链拍板（见 [C-612](../../docs/plans/C-612.md)），且本卡有摘要等于链绑定摘要的未签名包时，控制服务在本 Run 首次请求签名时执行 `host.py "$CONTROL" chain`：标准输入两行（Run 的签名范围；`commit`、`build`、`sha256`、`size`），候选字节走 fd 3。主机按大小和摘要逐字节复核，用该项目、机器、平台**唯一**的路由决定 `app` 和凭据版本，生成随机请求号和 7 天有效期，在同一事务里登记并批准，账本记 `chain_registered`、`chain_approved`。本 Run 已有授权时只报告，不替换。签名端的检查不变。签名完成后，控制服务把签后包直接入库为本卡制品并绑定到链，打包 Run 不需要下载再上传。
3. Agent 工具只收 `platform: android | ios`。主机重新核验令牌、活跃产出、Run、启动代次、机器和 UID，选择相符的私有授权。worker 校验清单和输入副本后，主机再次核验及记账才发出一次签名许可。响应只含请求号、平台、阶段或结果摘要与只读下载句柄，不含工具输出、路径或钥匙串信息。
   - **受理后轮询，不重送**（C-598）：直接作为 Card MCP 工具调用，不要经 shell、`curl` 或 `$CARDIGAN_RUN_COMMAND` 私用进程包装。每次需要启动主机程序的调用最多等约 2 秒，然后按状态返回。`queued`：主机还没有持久认领授权，没有请求号，稍后再调。`pending`：已认领，返回请求号和阶段（`transferring` 表示传输输入或联系签名端，`signing` 表示已派发、等待签名和回传）。`unconfirmed`：已认领，但这次尝试没拿到结果就结束了，例如助手超时、被中断或服务端重启；下次调用按同一请求号继续（见下面“派发前中断可续传”），不会重复签名。`signed`：回执和下载句柄，返回前已按当前账本复核授权仍有效、未撤销、未过期。Agent 保持当前 Run，用同一平台大约每 `poll_after_seconds` 调用一次。同一 Run 同一时间只有一个在途请求，轮询不会另起传输或签名。只有认领前就被拒绝（没有授权、已撤销、已过期、已失败等）时才报“签名未放行”，此时停止并报告，不要重送。
   - **派发前中断可续传**（C-601）：“派发”指签名端收到主机的 `commit`。签名端回执多一个状态 `received`：收件中或已回 `ready` 但未收到 `commit`，这时从未用过密钥。签名端收到 `commit` 后、用密钥之前，先把回执持久改成 `pending`，之后同一请求号只能 lookup。主机对已认领（`pending`）的请求，先报出请求号，再到初次派发时固定的 peer 只读查询回执；查询失败或答复无法识别时不重送，本次结束为 `unconfirmed`，下次轮询再查：没有回执或为 `received` 时，账本记 `resume`，按同一请求号重新传输输入并继续签名；其它情况仍走原 lookup（已派发、已签名后重启都按 lookup 取回）。签名端在串行锁内再核对一次，只接受同一份清单、仍为 `received` 的重送，所以每个请求号最多签一次；上一个连接还占着签名端时重送被拒，下次轮询再试。旧版签名端写下的 `pending` 无法区分是否已派发，一律按已派发处理；旧版签名端也不认识这次查询，续传要等签名端按下文换版后才生效，之前与 C-598 行为相同。
   - **服务端停止或部署**（C-601）：服务端收到 SIGTERM 后不再启动任何新的助手（送签、回执复核或下载）；调用返回 `queued` 或 `unconfirmed`，下载暂时失败，换到新服务端后再取。正在运行的助手先有 `CARDIGAN_SHUTDOWN_GRACE_MS`（缺省 10 秒）减 3 秒的时间自行完成，到时收到 SIGTERM，记 `interrupted` 并关掉签名端连接，2 秒后仍在则强杀；整个过程在服务端的退出期限内。助手发现自己的服务端进程已经不在（例如服务端被强杀），也会在约 1 秒内自行按 `interrupted` 结束，不会留下等不到 `commit` 的孤儿进程占着签名端。派发前被中断的请求由新服务端在同一 Run 的下次调用中续传；传输从头开始，慢链路上耗时与首次相同。想让部署多等在途的送签，调大 `CARDIGAN_SHUTDOWN_GRACE_MS`，同时让监督器的 `stop_timeout_ms` 不小于它加 2 秒。
   - **时限按大小计算**：主机程序按输入大小自定时限：`base_seconds + ceil(2 × 输入字节 ÷ bytes_per_second)`，默认 600 秒加每个方向 512 KiB/s（334 MB 的 APK 约 31 分钟）。已落盘产物的本地复核只用基础时限。lookup 不读取本地输入副本；副本不在时按单包上限 512 MiB 估算。如果链路更慢，可在 `$CONTROL/limits.json`（控制账号私有 `0600`）写 `{"base_seconds": 60–86400, "bytes_per_second": 16384–1073741824}`，任意一项可省略，越界或格式错误时不签。控制服务在主机报告的时限外再留 60 秒，然后先发 SIGTERM，30 秒后才强杀。主机自定时限到期记 `timed_out`，被终止或发现服务端已退出记 `interrupted`，其它失败仍记 `not_released`；三者都是本次调用的终态事件，不代表远端签名结果，需要时先 `reconcile <id>` 核对。续传按输入大小重新计时。
4. 每个请求有控制端 `audit.sqlite`（`grants`, `events`）和签名端独立的 `receipts`。主机校验回执和最终字节，落盘、持久提交成功后才允许 `export <id>` 输出字节到管理员指定的**本地**文件。`show <id>` 可查 `registered / approved / pending / peer_signed / failed / signed`、是否撤销及结果摘要；`pending` 不是成功。断连、`timed_out` 或 `interrupted` 后，相同 Run 的再次请求只继续相同请求号：签名端未收到 `commit` 时重送输入，否则只检索，不能重签；`peer_signed` 时这次检索会把签名端的产物取回本地并复核摘要；若服务端也没有成功回执，保留未知并人工核对，不能删账本后重试。批准过期、策略被撤或凭据换版时不核发新签名。备份账本与输出时保持同等私有权限。异常终止的残余暂存只在签名账号内由人检查清理。

5. 打包 Run 可以使用回执中的 `download.query` 在**同一个已配置的 MCP 端点**以 GET 取回字节，使用当前会话的 Bearer 身份。先写入新建的本地临时文件，复算 SHA-256 比对回执后才交付。句柄本身不授予权限；服务端复核当前 Run、已批准并落账的产物、有效期及未撤销状态，发送前核对已打开的同一文件。失效句柄不出件；下载不提供签名、管理或上传功能。
5a. **同机就地交接**（C-612）：签名端和打包 worker 在同一台机器时，管理员在控制端 `routes.json` 的这条路由上加 `"handoff": true`，并在签名端 `identity.json` 加 `handoff_dir`（绝对路径，管理员创建，签名账号所有，权限 `0711` 或 `0751`：别的账号可以进入，但不能列目录或写入）。签名端签完或 lookup 到已签产物后，把同一份签后 APK 写成 `<handoff_dir>/<请求号>.apk`（`0644`，先写临时文件再硬链接，不覆盖已有文件），回执带 `local_handoff: {path, sha256}`。worker 直接读这个文件并复算 SHA-256，不必经控制主机下载。未配置、权限不对或签名端是旧版时只是不交接，签名和下载照旧。交接需要按下文升级签名端后才生效；文件随请求号保留，由管理员按需清理。只用于测试签名身份。
6. 如果主机未记下成功、授权已过期或撤销，控制主机操作员可执行 `reconcile <id>`。它只能到**初次派发时固定的 peer** 按原号与完整清单查询回执状态和摘要，不读密钥、不发起签名、不退回产物字节，不要求原 Run 仍在场。请保留对应 peer 的可信 SSH 身份及旧回执。`peer_signed` 表示仅确认远端有签名回执，不是本地放行；`show` 的 `worker_receipt` 与主机复算后的 `output` 分开显示。过期、已撤销或策略已移除时，仍不能下载或导出。

## 首轮包格式和验收

- Android：只收有 AndroidManifest 且包名匹配的未签 APK；固定别名签名，必须通过 `apksigner verify --print-certs`、唯一证书指纹和输出包名核对。不收 AAB。
- iOS：ZIP 内唯一 `.xcarchive`，`Products/Applications` 下一个设备 `.app`，只接受未签 arm64 iOS 主程序与清单列出的普通 framework；允许归档外层 dSYM，不支持扩展、模拟器、通用切片、链接、已有签名/描述文件或未知可执行体。授权项必须与锁定的描述文件精确相容，不猜测通配符。由内到外逐项签名，核对团队、证书、Bundle ID 与授权项，再整体严格验签。交付摘要针对最终的 `.xcarchive.zip` 字节，不是目录摘要。两端都限制单包及展开总量 512 MiB、成员数 16000；不接受 ZIP64、归档注释、路径别名和非常规文件，超限留人工离线处理。APK 内只差大小写的成员名（如 AAPT2 缩短后的 `res/9n.9.png` 与 `res/9N.9.png`）是合法的：签名端把 APK 作为单个文件写入私有临时目录，检查时不解压成员，`aapt2`/`apksigner` 也直接读写整包，所以大小写不敏感的文件系统不会发生覆盖；完全相同的重复成员名仍拒绝。iOS 归档要解压到目录后签名，仍拒绝只差大小写的路径。以后若任何 Android 步骤需要把成员解压到文件系统，必须保留大小写别名检查（`inspect_zip` 传入解压目录时会自动执行），或改在大小写敏感的位置处理。
- 自动化夹具检查拒绝、重放、账本中断和签名调用/验签顺序，不能证明真实钥匙串、厂商工具链或现场账号隔离。合并后按 H-156 用测试身份核对普通 Run 无法读取、导出或绕过服务签名；最后与打包卡各自核准一个实际候选，记录输入/输出摘要、请求号、卡/Run 和独立验签结论。生产签名须另行逐件许可；商店、TestFlight 与下载站还需**单独**由人确认发布件摘要、版本、目标与渠道。

## 升级已有签名端程序（管理员）

C-548/C-551 只更新项目 worker 的三个 helper，**不更新独立签名端**。归档检查在签名端的 `archives.py` 中执行：C-582（APK 内点开头的路径段，如 Godot 的 `assets/.godot/`）、C-590（APK 内“-”开头的路径段，如 AAPT2 缩短后的 `res/-8.xml`）与 C-593（APK 内只差大小写的成员，如 `res/9n.9.png` 与 `res/9N.9.png`）都要按本节换版后才生效；C-601 的派发前续传需要签名端 `worker.py` 的 `received` 状态，同样要换版；C-612 的同机就地交接同样需要新版 `worker.py`（发布链自动登记只改控制主机的 `host.py`，不需要换签名端）；只换其中一个文件不算升级，五个文件必须来自同一发行版并整体核对摘要。先确认含修复的控制主机发行版已部署成功。从该次部署记录定位不可变发行目录，不从 Git 工作树、Run 或待签附件取程序。在其 `deploy/mobile-signing` 目录执行：

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
