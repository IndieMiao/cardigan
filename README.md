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

## 计划中的仓库结构

见开发方案 §20。
