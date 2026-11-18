# Workbench UI

此目录基于 shadcn/ui new-york 的 Radix 组件（MIT），固定依赖并维护组件源码。`components.json` 与 Vite/TypeScript 的 `@` 别名可供后续 shadcn 生成使用；新增生成代码必须先替换其默认尺寸与颜色，不能直接覆盖此目录。

业务使用 `Button` / `IconButton`、`Input` / `SearchInput`、`SelectControl`、`Menu`（旧兼容入口）、`ViewSwitch`、`TableHead` 和布局组件。需要模态/抽屉时使用 `Dialog` / `Sheet`；浮层需要 Portal、标题/描述和关闭焦点行为。不能在页面直接 import Radix。

默认高度 `--ui-control`（28px），只有 `size="regular"` / `icon-regular` 使用 32px。控件与面板圆角分别为 `--ui-radius`（4px）和 `--ui-panel-radius`（6px）；编号胶囊和圆形头像溢出使用 `--ui-pill-radius`。所有尺寸与色值在 `theme.css`，CSS `@apply` 与 Tailwind theme 使用同一变量。禁止页面用 className 或 style 增加尺寸/颜色变体；先增加组件的语义属性。

SelectControl 使用 `value` + `onValueChange(string)`；已有 `<option>` 仅作数据声明，不渲染可见原生下拉。空字符串、中文显示、禁用项原样保留；命名表单字段通过隐藏原生 select 提交原始业务值，组件内部编码不会泄漏到 FormData。不要构造假的 ChangeEvent。

表头排序使用 `TableHead sort="ascending|descending|none" onSort={...}`，整个文字和箭头可键盘激活；不要传排序按钮 CSS。静态表头直接放文字。

旧样式集中放在 `legacy` cascade layer，关闭 Tailwind preflight；全站生产入口加载 `theme.css`，旧截图夹具若仍直接加载 styles.css，只用于历史证据。阶段二迁移页面时，删除对应 `test-support/ui-legacy.json` 的精确存量豁免，不能新增。`pnpm lint` 同时检查原生控件、直接 Radix 导入、页面内联尺寸、额外 CSS 和任意值 utility。


预审修订后，原有 `Dialog.Content/Overlay/Title/Description` 和 Sheet 同名导出是无视觉兼容入口；新的标准面板必须显式使用 `DialogContent` / `SheetContent`。它们不能反过来覆盖旧灯箱、导航或 C-408 抽屉的几何与层级。

`PageHeader` 通过 `count` 承载决策计数，没有 description 行。必填 SelectControl 的空值提交会显示关联错误并将焦点送回控件；测试应检查显示文案或 aria 状态，不读取触发按钮 value。

Tailwind 扫描所有 views/components/App。页面组合布局组件；页面专属布局在 layout 中以 `FooLayout.tsx` 和 `FooLayout.module.css` 配对隔离，CSS 尺寸引用 token。theme.css 不接受页面选择器，旧 styles.css 只减不增。新增 utility 扫描能力不豁免页面控件样式检查。

编号统一消费IdBadge（IdTag/帮助图例复用，Markdown编号使用相同data-ui及类型类）；浅底、类型色文字，全部交互状态无下划线及hover边框。所有语义颜色只在theme定义，强调和成功用中性灰，不保留绿色/青绿类型色。Button的avatar尺寸用于圆形溢出计数，继承头像尺寸token，不改变常规控件28px合同。布局CSS module若使用cascade layer，须先声明完整layer顺序，避免动态导入顺序反转legacy与components。

设置页用 `layout/SettingsLayout`（导航、面板、分组、设置行、数值框、悬停说明）组合，布尔设置用 `Switch`，多字段设置用 `DialogContent`；保存方式和危险区规则见 `docs/design/ui-guidelines.md` 的“设置页模式”。
