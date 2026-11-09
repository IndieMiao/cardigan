# C-4 · CLI 与 server 启动警告修复

- 工作项：W-10；范围与验收以 C-4 为准。
- 沿用 M1.7 的 CLI / server 入口，不改业务逻辑、退出码或错误输出格式。
- 在 `host` 提供无业务依赖的警告过滤子路径，两个入口先安装过滤，再动态加载业务模块，避免静态导入提前加载 `node:sqlite`。
- 仅过滤类型为 `ExperimentalWarning` 且消息完整等于 `SQLite is an experimental feature and might change at any time` 的警告；其余调用原样传给 Node。
- 用子进程运行构建后的 CLI 和 server，验证 SQLite 警告消失、其他警告保留、帮助和失败退出行为不变；覆盖警告 API 的字符串、options 和 Error 形式。
- 同步开发方案 §13.1、§20.2 正文，不修改顶部版本与变更记录。
- 只运行 CLI 及 server 新增或相关测试、`pnpm lint`、`pnpm check:deps`；构建对应 TypeScript 项目。全量和 e2e 留给主机合并前验证。
- 在当前分支本地提交，以 commit SHA 调用 `submit_delivery`，请求 W-11 审核；不开 PR、不 push。
