# 飞书：把待处理事项发给本人

群自定义机器人 `lark` 仍只推送提醒。以下步骤只用于**另行获准启用**的企业自建应用 `lark_app`。首版只用私聊；无需公网回调地址。不把账号、凭据、群或租户信息写入项目仓库、工单、聊天或 Agent 配置。

1. 在飞书开放平台的开发者后台创建「企业自建应用」，添加「机器人」能力。把应用的可用范围限制在需要操作的成员，勿开启对外共享。
2. 在「权限管理」添加应用身份权限：获取用户发给机器人的单聊消息（`im:message.p2p_msg:readonly`）、以应用的身份发消息（`im:message:send_as_bot`）。以应用身份发消息的权限也可更新本应用发送的卡片，无须额外申请更新权限。不需要群历史、通讯录或用户身份令牌。
3. 管理员在「凭证与基础信息」查看 App ID、App Secret，从本企业管理后台的企业信息核对租户标识（tenant key）。在**运行后台服务的主机私有配置目录**创建 `ext-message.yaml` 和同目录的 `feishu-app.secrets`：文件属主为运行服务的用户、权限恰为 `0600`、不是符号链接。秘密文件为 JSON 对象，键名为 `app_id`、`app_secret`、`tenant_key`。不在 shell 命令行传值。实际配置只在私有部署中管理。
4. 在原有 `ext-message.yaml` 中保留 `workbench_url`（手机可访问的 Workbench 入口）、`channels.lark` 和免打扰设置；设置总开关 `enabled: true`，在 `channels` 下增加 `lark_app: {enabled: true, credential_file: feishu-app.secrets}`。重启后台服务，运行 `cardigan ext-message status`。`lark_app.state` 从 `connecting` 变为 `connected` 才表示已连接；`reconnecting` 表示 SDK 正在重连，`offline` 表示心跳过期，并非在线。`bound` 表示当前应用绑定状态。
5. 在「事件与回调」中分别设置：**事件配置**选择长连接并添加「接收消息」`im.message.receive_v1`；**回调配置**也选择长连接并添加新版「卡片回传交互」`card.action.trigger`。不要选旧版回调，也不要填 HTTP 回调地址。提交版本，交由企业管理员审核和发布。
6. 用本人账号登录 Workbench，打开「设置 → 飞书绑定」，选择「绑定飞书」。在应用机器人的**单聊**发送页面显示的绑定码；不用加前缀，不在群里发。返回设置页等待「已绑定」。码 5 分钟后失效，重新生成会立即废止前一个码。
7. 由获准人员用无敏感内容的测试事项核对拍板、填写结果、合并暂缓和原卡回执。理由和结果会写入 Cardigan 的业务记录，**不要填凭据或其它秘密**。24 小时前的按钮、版本已变或已处理的事项回 Workbench 处理。未分类、无法核实归属、敏感、发布和删除类事项始终只有链接；免打扰汇总没有操作按钮。
8. 验证临时断网后状态变为重连、恢复网络后回到在线；在设置页解除绑定，再点旧卡应不生效。要停用双向交互，只关闭 `channels.lark_app.enabled` 并重启后台；这不会关闭原群机器人。更换应用或租户后须重新绑定。

平台文档：飞书开放平台「步骤三：接收回调」「处理卡片回调」「发送消息」「更新应用发送的消息卡片」。选择新版 `card.action.trigger`，不要照旧版群机器人 webhook 配置。

参考：[使用长连接接收回调](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/callback-subscription/configure-callback-request-address)、[处理卡片回调](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/handle-card-callbacks)、[更新已发送的消息卡片](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/patch)。

可在 `channels.lark_app` 中设置 `binding_ttl_ms`（绑定码，默认 300000）和 `action_ttl_ms`（操作按钮，默认 86400000）；仅接受正整数毫秒，变更须重启。已发送按钮的期限不会被延长。
绑定尝试按应用每分钟默认最多 30 次（`binding_attempts_per_minute`）；最多同时受理 32 次点击（`pending_limit`）。超限不会执行操作。

首次启用渠道或重新绑定后，只提醒当前仍需处理的拍板、待办和未读知会，不补发已处理或已读的历史。暂未到展示条件的事项等条件满足再提醒。积压时每个项目、每个渠道每轮最多新建 32 条待发记录，后续轮次继续；已有记录不重复创建。免打扰期间仍按汇总发送，已排队但在送达前办结的事项跳过。
