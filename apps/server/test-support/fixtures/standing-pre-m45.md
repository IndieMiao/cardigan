# 常驻 PM 旧数据夹具

来源：M4.5 合并前的 `0531f0f^`，仅通过该版本的公开 CLI 创建项目、pm 角色、Office、Ops，并为 Ops 换发一次 Token。两条 Assignment 均没有 standing_mode；数据库只含随机 Token 的哈希，不含明文、仓库位置或个人路径。

在临时目录 `git archive 0531f0f^`，安装锁定依赖并 `pnpm exec tsc -b` 后，用 Node 运行本目录的 `generate-standing-legacy.mjs <旧版构建目录> <输出文件>` 可重新生成。脚本不读取实现、不执行 SQL、不直接写仓储。测试只解压这份真实旧库，再通过当前 Store/server 的公开入口升级。

夹具以 gzip 存放，避免提交大的二进制 SQLite 页；读写测试均使用临时副本。没有为凑旧状态而删除新字段或改业务行。
