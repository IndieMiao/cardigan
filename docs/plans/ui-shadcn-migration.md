# Workbench shadcn/ui 迁移

## 目标与边界

用户已决定整个 Workbench 统一为 shadcn/ui + Radix + Tailwind v4。分三阶段交付，每阶段可以单独验收。本阶段以真实卡片页为样板，不新增数据接口，不改变筛选、分页、列折叠、轮询、SSE、容量口径、路由或抽屉业务。继续遵守 C-408 的详情与抽屉布局。C-392 的紧凑页头、控件统一、编号无框无下划线、排序表头、优先级对齐和 C-407 无说明小字要求合并进本计划。

## Token 合同

CSS 变量是唯一数值来源，Tailwind theme 引用变量。默认紧凑高度 28px，常规 32px；控件圆角 4px，面板/卡片 6px。正文 14/20px、控件与次要文字 13/20px、元数据 12/18px、区块标题 16/24px、页标题 20/28px。间距 4/8/12/16/24px；控件横向内边距 8px，图标 16px，细箭头 12px。页面、面板和次级面板是无色相灰；亮暗色同时提供。主色只用于选中与主要操作；状态、优先级和编号类型色保留语义。选中、悬停和未选中圆角相同；焦点使用独立中性色轮廓。编号不加边框、下划线或 hover 描边；键盘焦点轮廓保留。

## 组件边界

`components/ui`：Button/IconButton、Select、DropdownMenu（含 CheckboxItem）、Toggle/ToggleGroup、Input/SearchInput、Tabs、Table/TableHead（可排序）、IdBadge、Badge、Tooltip、Dialog、Sheet、Popover、Checkbox、Switch。组件源自 shadcn/ui new-york Radix registry（MIT），尺寸与颜色统一改用 token；不采用 Base UI 变体。

`components/layout`：AppShell（侧栏/内容）、PageHeader（标题/计数/容量/操作）、FilterBar（筛选区域）。业务代码通过这些组件使用控件。旧 API 的 Menu、ViewSwitch、Drawer、Tooltip、IdTag、Foundation 保留兼容入口，但实现接到统一组件。19 处原生 select 一次替换为 Radix Select；支持空值、中文 label、禁用项、键盘、表单值、受控更新，不使用假 ChangeEvent 伪装 DOM。

## 第一阶段：基础和卡片页

1. 固定依赖、Tailwind Vite 插件和 shadcn 配置；关闭全局 preflight，legacy CSS 放在独立 cascade layer，统一组件层在其后。字体与状态语义沿用原来资源。
2. 提供所有基础/布局组件；全站 select 迁移，基础组件共用 token。
3. 卡片页完整使用新页头、筛选、搜索、显示多选、分段切换、看板操作、表格、分页、抽屉入口；删掉说明小字，必要信息通过 tooltip/帮助保留。
4. 防回退检查加入 `pnpm lint`：页面和业务组件不得新增原生 select、裸 button/input、内联尺寸与额外 CSS，不得直接引用 Radix。未迁移代码按精确节点摘要登记存量，修改或新增节点必须迁移，已迁移的卡片与基础文件不允许豁免。后续每阶段减少清单，不扩大清单。
5. 验收：build、lint、相关 web 测试通过（4 workers），原有断言保留；1440/390、亮暗、看板/列表/抽屉截图无页面横溢，控件对齐、菜单可达、Tab/Escape/焦点返回正常；GitHub 跑完整 test/e2e；提交 gzip 实测、bundle、报告。

## 第二阶段：按页面迁移

- 执行视图：复用表头与筛选布局，统一首行对齐与上下文数字，保留运维动作/排序/容量。（独立卡）
- Needs You：页签、分组、操作，清理解释小字；保留错误/风险确认。（独立卡，可与执行视图并行）
- 卡片详情与时间线：基于 C-408 现有布局统一表单、动作、附件/预览、记录和评论。（独立卡，与前两项并行，公共组件变更先单独交付）
- 项目动态/拍板记录/项目快照：统一 Table、搜索、筛选、分页。（独立卡，可并行）
- 设置：角色/模板、员工/容量/偏好分组迁移；表单语义、校验与权限原样保留。（两张卡，避免同时编辑 SettingsPage 入口）
- 登录与帮助：AppShell、表单、导航与文档例子收尾。（独立卡）

每卡独立验收：该页面存量豁免清零、亮暗/宽窄截图、定向功能与键盘测试、页面说明小字清单、build/lint，公共控件不得私改尺寸。只在 ui 层增加已有 token 语义，不增加页面专用高度或圆角。

## 第三阶段：删除存量并锁定体系

全站迁移后删掉 legacy 控件与布局规则、清空豁免表、收敛所有旧兼容入口。验证所有编号类型、hover/focus、浮层嵌套、移动导航、表单错误、读屏名称及全量测试/e2e；补正式组件使用文档与截图基准。验收要求：业务零原生 select/button/input，零直接 Radix 导入，零页面 CSS/内联尺寸，所有尺寸均来自 token，体积和首次加载无不明回退。

## 防回退的维护规则

新增控件先在 ui 层定义语义 variant，再由页面消费；禁止用 className 覆盖高度/圆角/颜色或 style 绕过组件。布局数值只能来自已登记 token。存量豁免不是模板；移除的豁免不得重新加入。错误消息、必需校验、权限提示和容量事实不是说明小字，应保留。任何增加一档控件尺寸/圆角必须修改本合同并附全主题/尺寸证据。

## 预审后的边界补充

- Tailwind 显式扫描 `src/components`、`src/views`、`src/App.tsx`，新增第二阶段页面不必修改扫描配置。扫描并不授权控件 utility：业务端尺寸/颜色/间距 utility 仍被检查禁止。页面通过布局组件的语义属性组合。
- `ui/theme.css` 仅放 token 和 `.ui-*` 基础组件规则，不能加入 `.cards-page` 等页面选择器。共用布局在 `components/layout/layout.css`；各页面独立布局由配对 `FooLayout.tsx` + `FooLayout.module.css` 拥有，TSX 必须导入自身 CSS module，尺寸只引用 token。并行页面卡分别拥有模块，不共同改 theme.css；新增共用 primitive 应先单独交付。
- 原 `styles.css`、CardLegend.css、TemplateMarker.css 在第一阶段基线固定，检查只允许删行、禁止新增/改写，并限制行数不超过基线。第二阶段某页面换用新布局的同一张卡就删除其独占旧规则；多页共用规则在最后一个消费者迁移时删除，不留到“以后统一清理”。
- 存量豁免以固定已审提交 `19977ef6` 的 JSON 作为上界，当前 JSON 只允许其子集、总数 ≤176。不能添加新哈希或把某条 count 增大。检查覆盖 `.ts` / `.tsx`、再导出/动态 import、native 控件别名/createElement、textarea、variant utility、内联 style 和控件 props 展开。所有存量 textarea 已切换到 ui/Textarea，因此不增加豁免。
- Dialog/Sheet 的旧兼容 Content/Overlay 导出不加视觉类；只有显式 DialogContent/SheetContent 接受新面板外观。C-408 抽屉宽度、灯箱层级、手机导航方角、Needs You 模态尺寸继续由旧规则提供，后续页面卡有截图证据才能调整。
- PageTitle 移除 description 属性；Needs You 待处理数量通过 PageHeader count 显示。必填 Select 在校验失败时显示可见错误、aria-invalid 和描述关联，保留表单无效阻止提交行为。

## 导入基线整合

导入时合入已审核基线 `99587a67c29facfa4f9cb5e990e26a533b0f0ff9`。旧样式删除检查固定到该提交，保留此前已合入的执行诊断与会话维护样式；节点豁免仍固定在 `19977ef6`，不扩大清单。基线新增诊断组件的两个按钮接入统一 Button，原有请求、禁用与打开详情逻辑不变。
