# Workbench UI

此目录基于 shadcn/ui new-york 的 Radix 组件（MIT），固定依赖并维护组件源码。`components.json` 与 Vite/TypeScript 的 `@` 别名可供后续 shadcn 生成使用；新增生成代码必须先替换其默认尺寸与颜色，不能直接覆盖此目录。

业务使用 `Button` / `IconButton`、`Input` / `SearchInput`、`SelectControl`、`Menu`（旧兼容入口）、`ViewSwitch`、`TableHead` 和布局组件。需要模态/抽屉时使用 `Dialog` / `Sheet`；浮层需要 Portal、标题/描述和关闭焦点行为。不能在页面直接 import Radix。

默认高度 `--ui-control`（28px），只有 `size="regular"` / `icon-regular` 使用 32px。圆角仅 `--ui-radius`（4px）和 `--ui-panel-radius`（6px）。所有尺寸与色值在 `theme.css`，CSS `@apply` 与 Tailwind theme 使用同一变量。禁止页面用 className 或 style 增加尺寸/颜色变体；先增加组件的语义属性。

SelectControl 使用 `value` + `onValueChange(string)`；已有 `<option>` 仅作数据声明，不渲染可见原生下拉。空字符串、中文显示、禁用项原样保留；命名表单字段通过隐藏原生 select 提交原始业务值，组件内部编码不会泄漏到 FormData。不要构造假的 ChangeEvent。

表头排序使用 `TableHead sort="ascending|descending|none" onSort={...}`，整个文字和箭头可键盘激活；不要传排序按钮 CSS。静态表头直接放文字。

旧样式集中放在 `legacy` cascade layer，关闭 Tailwind preflight；全站生产入口加载 `theme.css`，旧截图夹具若仍直接加载 styles.css，只用于历史证据。阶段二迁移页面时，删除对应 `test-support/ui-legacy.json` 的精确存量豁免，不能新增。`pnpm lint` 同时检查原生控件、直接 Radix 导入、页面内联尺寸、额外 CSS 和任意值 utility。
