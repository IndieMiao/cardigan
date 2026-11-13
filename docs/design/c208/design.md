# C-208 暗色中性灰阶与 C-204 编号标签设计 v2

晴雯 · W-633 · 2026-11-13 · 设计候选，交 W-634 审核。

本方案以三档纯灰取代原来的墨绿底色，正文从 #edf2ee 降到 #cccccc。彩色保留在状态、强调和小面积编号标签。覆盖 Needs You、卡片详情、看板、执行视图、项目动态；不改变布局、组件结构、字重或业务流程。

依据：C-208 验收标准、C-208#6 的联合配色要求、C-208#8 的“增加可读性、弱化样式装饰”方向，C-208#9 转贴的 C-204 审核 V-662，C-208#10 提供的亮色 v2 色族、C-208#29 新增的长段正文亮度要求，以及设计审核 V-672 的三条必须修改意见。C-204 的亮色由对应工作项继续处理，本交付只提供暗色。

## 1. 灰阶与现有变量

三个主要背景层级分别为 #181818（页面）、#222222（侧栏/卡片/输入框）、#2c2c2c（次级/选中/时间线）。均为 R=G=B；层次用明度和既有间距区分，不增加框中框。以下表逐一对应 apps/web/src/styles.css 的暗色变量，保留项同样列出，便于整体替换。

| 变量 | 当前值 | 设计值 | 用途 / 处理 |
|---|---|---|---|
| `--priority-low` | `#6daef5` | `#6daef5` | 保留现有语义色 |
| `--priority-medium` | `#eac74a` | `#eac74a` | 保留现有语义色 |
| `--priority-high` | `#f9a15d` | `#f9a15d` | 保留现有语义色 |
| `--priority-urgent` | `#ff7b80` | `#ff7b80` | 保留现有语义色 |
| `--bg` | `#171e1b` | `#181818` | 页面底色 / 状态图标镂空底 |
| `--surface` | `#202a25` | `#222222` | 侧栏、卡片、面板、输入框 |
| `--surface-muted` | `#29352e` | `#2c2c2c` | 选中项、次级区块、行内代码 |
| `--timeline-card` | `#29352e` | `#2c2c2c` | 时间线内容卡 |
| `--border` | `#435148` | `#484848` | 装饰分隔线、面板及编号边框 |
| `--text` | `#edf2ee` | `#cccccc` | 正文、标题；降低亮度 |
| `--text-muted` | `#b0beb5` | `#a4a4a4` | 次要文字、字段名 |
| `--accent` | `#8dcac3` | `#8dcac3` | 链接、主按钮、选中项文字、焦点 |
| `--accent-contrast` | `#172621` | `#181818` | 主按钮文字 |
| `--danger` | `#ff9c91` | `#ff9c91` | 保留现有语义色 |
| `--overlay` | `rgba(0, 0, 0, 0.75)` | `rgba(0, 0, 0, 0.75)` | 保留现有语义色 |
| `--overlay-text` | `#f5f5f5` | `#f5f5f5` | 保留现有语义色 |
| `--tooltip-bg` | `#1d2522` | `#222222` | Tooltip 背景 |
| `--tooltip-text` | `#f5f7f6` | `#f5f5f5` | Tooltip 文字 |
| `--tooltip-border` | `#72877a` | `#777777` | Tooltip 边界 |
| `--status-wait` | `#edb96d` | `#edb96d` | 保留现有语义色 |
| `--status-progress` | `#65d3e0` | `#65d3e0` | 保留现有语义色 |
| `--status-review` | `#c5b0f1` | `#c5b0f1` | 保留现有语义色 |
| `--status-done` | `#91cda5` | `#91cda5` | 保留现有语义色 |
| `--status-muted` | `#abb5b0` | `#a4a4a4` | 中性状态/系统身份 |
| `--status-backlog` | `#acb8b1` | `#a4a4a4` | 待整理状态 |
| `--status-pending` | `#94bde9` | `#94bde9` | 保留现有语义色 |
| `--status-dispatched` | `#b6b0ff` | `#b6b0ff` | 保留现有语义色 |
| `--status-merge` | `#6dd9b7` | `#6dd9b7` | 保留现有语义色 |
| `--status-cancelled` | `#d1b4a6` | `#d1b4a6` | 保留现有语义色 |
| `--status-idle` | `#95a39b` | `#a4a4a4` | 空闲状态 |
| `--status-unknown` | `#f6b486` | `#f6b486` | 保留现有语义色 |
| `--status-cutout` | `#171e1b` | `#181818` | 实心状态图标的镂空笔画 |
| `--control-border` | `无（新增）` | `#777777` | 新增：输入框、选择框、文本框、按钮的共享边界 |

`--danger-surface: var(--surface)`、`--status-todo: var(--status-pending)`、`--status-in_progress: var(--status-progress)`、`--status-awaiting_merge: var(--status-merge)` 继承原有别名，无需改映射。非颜色变量不变。

**边界分工**：`--border` 为 #484848，仅承担装饰分隔，避免所有行线都过亮。新增 `--control-border: #777777` 用在公共 input/select/textarea/button/.filter 的 `border-color`，最浅内容底上仍为 3.12:1；沿用现有边框宽度，不给原本无边框的按钮新增边框。现有浅色 :root 定义 `--control-border: var(--border)`，暗色覆盖为 #777777，保持浅色外观。产品落地需要这一共享控件颜色绑定，不在各页面散写颜色。选中筛选按钮保留强调底色与文字，外边界统一使用控件线；后续实现按此说明检查控件 hover/active/focus。

当前交付记录的背景原为 `color-mix(in srgb, var(--accent) 6%, transparent)`，仍会留下青绿的整行底色；暗色将 `.record-delivery-current` 的背景绑定为 `var(--surface-muted)`，保留既有 3px 品牌色左线。这里复用现有变量，不增加色值或改变布局。

**强调与交互**：导航选中只使用中性次级底和品牌色文字；主按钮保留品牌色小块。链接/焦点轮廓继续使用 #8dcac3，焦点为既有 2px outline、2px offset。hover 使用既有次级灰底或下划线，不新增绿色背景。Tooltip 用纯灰底与浅灰文字。禁用控件沿用原有禁用态，不把禁用色计为正文 AA 的证据。

## 2. 正文亮度与对比度

长段正文采用 `--text: #cccccc`，即三个 sRGB 通道均为 204/255（80%），不是“WCAG 相对亮度 80%”。审核问题、评论、交付说明和时间线正文共用这一灰度；标题继续继承同一文字色，只用已有字号和字重建立层级。次要文字 `#a4a4a4` 的三个通道约为 64.3%。选择 #a4 而非 #a3，是因为 #a3 在 12% 混合底仅为 4.49:1，#a4 达到 4.54:1。相较前一交付 D-696 的 #dedede，正文进一步降低亮度，并下调 A/R/D/V 标签文字，确保所有编号的 CIELAB L* 不高于正文；中性状态色同步调整以维持类型色差。

长评论与审核问题取真实 CardDetailPage 时间线组件，填入四段连续评论及四条多段审核问题（包含严重程度、必须修复和建议标记）；展开完整内容后，1440px 和 390px 分别附审核问题、长评论的改前改后对照图。浏览器另核对该段实际计算文字色为 rgb(204, 204, 204)，次要时间信息为 rgb(164, 164, 164)，不以只修改色值表代替页面证据。

### 状态与强调

通过/完成保留绿，失败/阻塞保留珊瑚红，运行中保留青，暂缓/等待保留琥珀。继续显示原有图标形状和中文状态名称，不仅依赖颜色。审核/待开始/已派发等状态映射不变。状态文字/图标在三档灰底及时间线 12% 混合底上均通过正文 4.5:1；图标因而也超过 3:1。中性/待整理/空闲的灰色统一调到 #a4a4a4，防止混合底上低于 4.5:1。

- 次要文字在三档实际内容底最低 5.60:1（12% 混合底为 4.54:1），正文最低 8.70:1。
- 状态色在三档灰底最低 5.60:1，连同 12% 混合底最低 4.54:1。
- 主按钮文字 9.61:1，Tooltip 文字 14.59:1，实心状态图标的镂空笔画最低 8.81:1。
- 优先级四种彩色保持现值；正文级验证包含更保守的 12% 混合底，最低 4.60:1。

完整数值在附录 A；这是指定颜色组合的校验，不代表整个产品已完成无障碍验收。

## 3. C-204 暗色表（替换旧候选）

收到 V-662 后，12 类均重新分配或归并。与亮色 v2 对齐：C=蓝，W=紫，Q=洋红，A=中性灰，R=青，D=橄榄，V=棕金，H=灰玫瑰，E/M/MB/未知=低饱和灰紫。D 与 V 均移出原来的蓝紫近邻，A 与 E 的明度和色相分开。V-672 要求编号明度不超过正文：A #e2e2e2→#cccccc，R #bef4f4→#63ada8；同时将 D #d6d65c→#cece54、V #ebd6ad→#d6c59f，避免这两类在正文变暗后超出同一上限。全部 12 类文字 L* ≤ 正文 82.05。编号类型不借用状态变量；前景/底色集中为 `--id-<type>-fg/bg`（若 C-204 已定变量名，只做键名对齐，数值以本表为准）。

最近邻集合为 C/W/Q/A/R/D/V/H/E 九类；九类全部 36 对文字 ΔE2000 ≥ 10.67、底色 ≥ 6.79。E/M/MB/未知按审核意见共用低饱和灰紫族，这四者用前缀及类型说明区分。编号与状态色的最近文字 ΔE2000 ≥ 10.75，包括审核、待开始、已派发、待整理等提醒项。所有编号保留前缀与标签外形，状态保留专用图标及中文；色差不替代这些语义线索。

| 类型 / 示例 | 旧文字 / 底色 | 新文字 / 底色 | 文字对标签底 | 新三档底最低 | 最近邻文字 ΔE00 | 文字 L* |
|---|---|---|---|---|---|---|
| card / C-208 | #adc9ff / #21334e | #7997d2 / #202c43 | 4.77:1 | 4.77:1 | employee / 17.39 | 62.38 |
| work-item / W-633 | #d4b8ff / #362b49 | #b982df / #3c224c | 4.80:1 | 4.87:1 | decision / 11.32 | 63.02 |
| decision / Q-279 | #eab8da / #412d3b | #db70bd / #43233a | 4.59:1 | 4.70:1 | work-item / 11.32 | 61.93 |
| assignment / A-583 | #b7ccdd / #2b3742 | #cccccc / #303030 | 8.22:1 | 8.70:1 | review / 14.45 | 82.05 |
| run / R-3106 | #96d4e6 / #203c45 | #63ada8 / #203c3c | 4.55:1 | 5.37:1 | assignment / 23.06 | 66.03 |
| delivery / D-687 | #b0d3f2 / #29394a | #cece54 / #3d3d20 | 6.67:1 | 8.37:1 | review / 15.46 | 80.69 |
| review / V-662 | #c5bffc / #302e4b | #d6c59f / #413824 | 6.80:1 | 8.21:1 | assignment / 14.45 | 80.03 |
| human-action / H-12 | #dbc6ba / #3c332e | #aa8f8f / #302525 | 4.96:1 | 4.68:1 | employee / 10.67 | 61.80 |
| employee / E-8 | #c4c8ed / #31354b | #a69bb0 / #34303f | 4.84:1 | 5.28:1 | human-action / 10.67 | 65.50 |
| member / M-1 | #d5c2e1 / #3a3042 | #a69bb0 / #34303f | 4.84:1 | 5.28:1 | employee / 0.00 | 65.50 |
| merge-batch / MB-12 | #bbcde3 / #2d3847 | #a69bb0 / #34303f | 4.84:1 | 5.28:1 | employee / 0.00 | 65.50 |
| unknown / X-12 | #b0beb5 / #29352e | #a69bb0 / #34303f | 4.84:1 | 5.28:1 | employee / 0.00 | 65.50 |

标签对自身底色最低 4.55:1；无底文本回退在三档内容底最低 4.68:1。底色只承担类型提示，不能用整行大面积铺色。编号 hover/键盘 focus 保留现有下划线/焦点规则；焦点色在标签底上最低 6.03:1。C-204 的类型解析与点击目标属于该卡实现，不由本原型的 DOM 演示映射替代。

## 4. 原型、截图与验收边界

基线为 `80dbfa11c0807864a3c9f06fdf69a302fb53c2c1`。原型位于 `apps/web/test-support/c208/`，直接复用本分支 App 和五页组件，使用隔离的 fakeClient 和示例数据。`before` 为基线原有暗色（没有 C-204 类型配色）；`after` 为相同 DOM 上应用本方案并展示 C-204 候选标签。所有截图均为本地设计模拟，不是产品代码已实现的证据。

启动：`pnpm --filter @cardigan/web dev --host localhost --port 5183 --strictPort`。

打开 `/test-support/c208/index.html?palette=before#/p/p-1/activity`，将 `before` 改为 `after` 比较。路由可替换为 `needs-you`、`cards/C-1`、`cards?view=board`、`execution?view=all`。另有 `/test-support/c208/palette.html` 展示三档背景上全部 12 类编号与状态。使用暗色系统偏好；浅色样式不受原型覆盖影响。

截图每页均为 1440×1000 和 390×1000 视口，按内容完整截取，保持 1 CSS px = 1 图像 px。对照图左边改前、右边改后，没有缩放页面或替换文字。文件名为 `<page>-<width>-comparison.png`；十张对照图覆盖全部五页、两种宽度。联合色板另有两张图；`long-comment-<width>-comparison.png` 与 `review-issues-<width>-comparison.png` 共四张专门展示长段评论、审核问题及次要信息。移动端执行表格/看板仍在自身容器横向滚动，不修改原有布局。

验证命令：

- `node apps/web/test-support/c208/audit.mjs`：48 组对比度通过，完整结果附录 A。
- `python3 apps/web/test-support/c208/color-distance.py`：九类 36 对色差通过，3 组标准参考对校准通过，完整结果附录 B。
- `PLAYWRIGHT_MODULE=<已安装 Playwright 的模块入口> CHROMIUM_PATH=<本地 Chromium> node apps/web/test-support/c208/capture.mjs <证据输出目录> http://localhost:5183`：只采集上述五页、色板、审核问题与长评论；十个场景改前改后元素几何一致，页面无横向溢出，无业务 API 请求，无运行时异常；浅色底色保持 #f2f4f3。

本环境的 Playwright MCP 在启动时遇到 crashpad 错误；最终截图使用已安装的 Playwright 模块另起本地 Chromium，配临时 XDG 目录，没有新增依赖或登录账号。截图前复位到页首，完整截图保持固定导航位置；审核问题和长评论按文档坐标截取，不滚动到固定导航下面；交付以最后一次成功运行的 browser-checks.json 为证。

原型只演示配色和既有交互；C-204 完整前缀解析、五页真实数据、全状态交互回归及产品最终截图由开发 W-630 和后续验证完成。卡片的“截图核对”仍由 PM Office 或人记录。本轮只申请 W-634 设计复审；开发卡的完成申请由主产出 W-630 负责人提交。两卡谁后合并，谁依据本表对齐最终暗色变量；不可用旧候选覆盖本表。

## 5. V-672 修改对照

| 审核问题 | 本版处理 | 验证依据 |
|---|---|---|
| 正文与次要文字过亮 | #cccccc / #a4a4a4；标题沿用正文色 | §1–2、附录 A、两种宽度的长评论图 |
| 缺长段阅读截图 | 四条完整审核问题、四段 407 字评论 | review-issues / long-comment 各两张对照图；browser-checks.json |
| A/R 标签比正文更亮 | 同时下调 A/R/D/V，全部标签 L* ≤82.05 | §3、附录 B；36 对色差与标签 AA 均通过 |

本版色值完整取代 D-696 及 C-208#38、C-208#40 的准备值。设计说明与 16 张截图随新交付上传，附件编号和 SHA-256 记录在 attachments.json。更新开发方案 §8.1 的暗色设计说明；未改顶部版本号和变更记录。

## 附录 A：完整对比度


按 WCAG sRGB 相对亮度计算，未四舍五入的比值用于判定。状态/强调/优先级列依次为页面 #181818、面板 #222222、次级/时间线 #2c2c2c、12% 当前色与时间线混合底。编号标签列依次为标签底、页面、面板、次级底。

| 用途/变量 | 前景 | 各背景对比度 | 最低 | 门槛 |
|---|---|---|---|---|
| --priority-low | #6daef5 | 7.63 / 6.84 / 6.00 / 4.83 | 4.83:1 | 4.5:1 |
| --priority-medium | #eac74a | 10.79 / 9.67 / 8.49 / 6.44 | 6.44:1 | 4.5:1 |
| --priority-high | #f9a15d | 8.70 / 7.79 / 6.84 / 5.41 | 5.41:1 | 4.5:1 |
| --priority-urgent | #ff7b80 | 7.10 / 6.36 / 5.58 / 4.60 | 4.60:1 | 4.5:1 |
| --text | #cccccc | 11.06 / 9.91 / 8.70 / 6.54 | 6.54:1 | 4.5:1 |
| --text-muted | #a4a4a4 | 7.12 / 6.38 / 5.60 / 4.54 | 4.54:1 | 4.5:1 |
| --accent | #8dcac3 | 9.61 / 8.61 / 7.56 / 5.84 | 5.84:1 | 4.5:1 |
| --danger | #ff9c91 | 8.81 / 7.89 / 6.93 / 5.46 | 5.46:1 | 4.5:1 |
| --status-wait | #edb96d | 9.94 / 8.91 / 7.82 / 6.02 | 6.02:1 | 4.5:1 |
| --status-progress | #65d3e0 | 10.10 / 9.05 / 7.95 / 6.12 | 6.12:1 | 4.5:1 |
| --status-review | #c5b0f1 | 9.18 / 8.22 / 7.22 / 5.62 | 5.62:1 | 4.5:1 |
| --status-done | #91cda5 | 9.71 / 8.70 / 7.63 / 5.89 | 5.89:1 | 4.5:1 |
| --status-muted | #a4a4a4 | 7.12 / 6.38 / 5.60 / 4.54 | 4.54:1 | 4.5:1 |
| --status-backlog | #a4a4a4 | 7.12 / 6.38 / 5.60 / 4.54 | 4.54:1 | 4.5:1 |
| --status-pending | #94bde9 | 9.06 / 8.12 / 7.13 / 5.56 | 5.56:1 | 4.5:1 |
| --status-dispatched | #b6b0ff | 9.00 / 8.06 / 7.08 / 5.53 | 5.53:1 | 4.5:1 |
| --status-merge | #6dd9b7 | 10.37 / 9.29 / 8.15 / 6.25 | 6.25:1 | 4.5:1 |
| --status-cancelled | #d1b4a6 | 9.12 / 8.17 / 7.18 / 5.58 | 5.58:1 | 4.5:1 |
| --status-idle | #a4a4a4 | 7.12 / 6.38 / 5.60 / 4.54 | 4.54:1 | 4.5:1 |
| --status-unknown | #f6b486 | 9.97 / 8.93 / 7.84 / 6.03 | 6.03:1 | 4.5:1 |
| input boundary | #777777 | 3.97 / 3.55 / 3.12 | 3.12:1 | 3:1 |
| button text | #181818 | 9.61 | 9.61:1 | 4.5:1 |
| tooltip text | #f5f5f5 | 14.59 | 14.59:1 | 4.5:1 |
| success / error cutout | #181818 | 9.71 / 8.81 | 8.81:1 | 3:1 |
| id card | #7997d2 | 4.77 / 6.06 / 5.43 / 4.77 | 4.77:1 | 4.5:1 |
| id focus card | #8dcac3 | 7.57 | 7.57:1 | 3:1 |
| id work-item | #b982df | 4.80 / 6.19 / 5.55 / 4.87 | 4.80:1 | 4.5:1 |
| id focus work-item | #8dcac3 | 7.45 | 7.45:1 | 3:1 |
| id decision | #db70bd | 4.59 / 5.97 / 5.35 / 4.70 | 4.59:1 | 4.5:1 |
| id focus decision | #8dcac3 | 7.38 | 7.38:1 | 3:1 |
| id assignment | #cccccc | 8.22 / 11.06 / 9.91 / 8.70 | 8.22:1 | 4.5:1 |
| id focus assignment | #8dcac3 | 7.15 | 7.15:1 | 3:1 |
| id run | #63ada8 | 4.55 / 6.83 / 6.12 / 5.37 | 4.55:1 | 4.5:1 |
| id focus run | #8dcac3 | 6.41 | 6.41:1 | 3:1 |
| id delivery | #cece54 | 6.67 / 10.64 / 9.53 / 8.37 | 6.67:1 | 4.5:1 |
| id focus delivery | #8dcac3 | 6.03 | 6.03:1 | 3:1 |
| id review | #d6c59f | 6.80 / 10.44 / 9.35 / 8.21 | 6.80:1 | 4.5:1 |
| id focus review | #8dcac3 | 6.26 | 6.26:1 | 3:1 |
| id human-action | #aa8f8f | 4.96 / 5.95 / 5.33 / 4.68 | 4.68:1 | 4.5:1 |
| id focus human-action | #8dcac3 | 8.02 | 8.02:1 | 3:1 |
| id employee | #a69bb0 | 4.84 / 6.71 / 6.01 / 5.28 | 4.84:1 | 4.5:1 |
| id focus employee | #8dcac3 | 6.93 | 6.93:1 | 3:1 |
| id member | #a69bb0 | 4.84 / 6.71 / 6.01 / 5.28 | 4.84:1 | 4.5:1 |
| id focus member | #8dcac3 | 6.93 | 6.93:1 | 3:1 |
| id merge-batch | #a69bb0 | 4.84 / 6.71 / 6.01 / 5.28 | 4.84:1 | 4.5:1 |
| id focus merge-batch | #8dcac3 | 6.93 | 6.93:1 | 3:1 |
| id unknown | #a69bb0 | 4.84 / 6.71 / 6.01 / 5.28 | 4.84:1 | 4.5:1 |
| id focus unknown | #8dcac3 | 6.93 | 6.93:1 | 3:1 |

## 附录 B：完整色差


sRGB、D65、CIEDE2000，kL=kC=kH=1。以 C/W/Q/A/R/D/V/H/E 九类为最近邻集合；M/MB/unknown 允许共用 E 的中性族。三组 Sharma 标准参考对误差小于 0.0001。

| 类型 | 最近文字邻色 / ΔE00 | 最近底色邻色 / ΔE00 | 最近状态色 / ΔE00 | 文字 L* |
|---|---|---|---|---|
| card | employee / 17.39 | employee / 7.59 | --status-pending / 10.92 | 62.38 |
| work-item | decision / 11.32 | decision / 7.55 | --status-review / 12.32 | 63.02 |
| decision | work-item / 11.32 | work-item / 7.55 | --status-review / 19.25 | 61.93 |
| assignment | review / 14.45 | human-action / 7.30 | --status-muted / 10.75 | 82.05 |
| run | assignment / 23.06 | assignment / 12.09 | --status-progress / 12.02 | 66.03 |
| delivery | review / 15.46 | review / 6.79 | --status-wait / 17.28 | 80.69 |
| review | assignment / 14.45 | delivery / 6.79 | --status-wait / 11.40 | 80.03 |
| human-action | employee / 10.67 | assignment / 7.30 | --status-muted / 12.45 | 61.80 |
| employee | human-action / 10.67 | card / 7.59 | --status-muted / 11.48 | 65.50 |
| member | employee / 0.00 | employee / 0.00 | --status-muted / 11.48 | 65.50 |
| merge-batch | employee / 0.00 | employee / 0.00 | --status-muted / 11.48 | 65.50 |
| unknown | employee / 0.00 | employee / 0.00 | --status-muted / 11.48 | 65.50 |

九类全部 36 对：

| 类型对 | 文字 ΔE00 | 底色 ΔE00 |
|---|---|---|
| card / work-item | 18.76 | 13.97 |
| card / decision | 29.70 | 17.57 |
| card / assignment | 24.35 | 12.08 |
| card / run | 24.55 | 16.83 |
| card / delivery | 56.65 | 28.47 |
| card / review | 38.21 | 23.82 |
| card / human-action | 24.29 | 14.54 |
| card / employee | 17.39 | 7.59 |
| work-item / decision | 11.32 | 7.55 |
| work-item / assignment | 28.84 | 20.22 |
| work-item / run | 33.50 | 25.77 |
| work-item / delivery | 66.90 | 37.82 |
| work-item / review | 45.20 | 31.19 |
| work-item / human-action | 23.63 | 17.53 |
| work-item / employee | 17.04 | 12.06 |
| decision / assignment | 29.69 | 17.72 |
| decision / run | 38.56 | 29.68 |
| decision / delivery | 66.34 | 33.37 |
| decision / review | 43.99 | 26.28 |
| decision / human-action | 21.12 | 13.14 |
| decision / employee | 19.08 | 11.39 |
| assignment / run | 23.06 | 12.09 |
| assignment / delivery | 25.78 | 14.02 |
| assignment / review | 14.45 | 11.02 |
| assignment / human-action | 19.18 | 7.30 |
| assignment / employee | 16.72 | 9.48 |
| run / delivery | 32.58 | 16.60 |
| run / review | 27.45 | 18.09 |
| run / human-action | 35.69 | 21.18 |
| run / employee | 30.99 | 19.19 |
| delivery / review | 15.46 | 6.79 |
| delivery / human-action | 35.58 | 19.19 |
| delivery / employee | 42.69 | 25.71 |
| review / human-action | 23.26 | 13.18 |
| review / employee | 28.25 | 20.20 |
| human-action / employee | 10.67 | 9.28 |
