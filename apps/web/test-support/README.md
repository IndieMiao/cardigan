# Workbench 布局回归

C-203 加载测量：`node apps/web/test-support/load-performance.mjs --local --json /tmp/load.json`（从仓库根目录运行，先 `pnpm exec tsc -b apps/server`、`pnpm --filter @cardigan/web build`）。独立临时 SQLite、210 张卡、577 个 Assignment、4200 条事件/时间线；不启动 Dispatcher，不读取正式数据库。复用本地 Chromium，无新增依赖。详细口径、远程一条命令、冷暖缓存和修前修后数据见 [加载测量记录](../../../docs/research/workbench-load-c203.md)。

C-133 拍板影响范围人工截图：运行 `pnpm --filter @cardigan/web dev --host localhost`，打开 Vite 地址下的 `/test-support/decision-impact.html`。这是本地夹具，不连接业务服务或正式数据库，也不进入产品构建。分别在 1440px、390px 下模拟 `prefers-color-scheme: light/dark`，截取 Needs You 和点击 C-1 后的卡片详情（含合并处理、侧栏拍板和请求／解决时间线）。Q-1 和失败合并确认 Q-2 显示 C-2、C-3、C-4 的链接、缩略标题与状态；Q-3 为空列表、Q-4 仅含所属卡片，均不显示影响行。检查无水平溢出、状态文字不截断、长标题悬停可读，点击 C-2 可打开详情，影响行仍只排除拍板所属的 C-1。

`pnpm --filter @cardigan/web test:layout` 在真实 Chromium 中加载 App、字体和 CSS，使用非空测试夹具；不启动业务服务、Dispatcher，也不连接正式数据库。它与 jsdom 组件测试互补，不加入默认的无浏览器测试流程。

前置条件：已有 Node 24、workspace 依赖和本地 Chromium。默认执行 PATH 中的 `chromium`；使用其他安装位置时设置 `CHROMIUM_PATH` 为浏览器可执行文件路径。测试通过 Chromium 自带的 DevTools pipe 控制浏览器，不需要 Playwright 或新增 npm 依赖。浏览器使用临时 profile，以无沙箱模式运行本地测试代码，结束后关闭浏览器并删除 profile。

可选参数：

- `LAYOUT_BASELINE_REF`：桌面布局比较所用 Git ref，默认 `origin/main`；两套 CSS 作用于同一份 DOM，逐元素比较位置、尺寸和关键样式。验证指定交付时设为其对应的基线提交。
- `LAYOUT_SCREENSHOTS`：截图输出目录。设置后输出七页在 390px 下的亮、暗完整截图，以及执行视图在 1440px 下的亮、暗截图；未设置时只运行断言。

覆盖 390、760、768、1280、1440px 与亮暗主题的 70 个场景：

- 六个非看板页的公共导航及主内容宽度，另核对看板已有布局不变。
- 详情共 25 条时间线、初始加载 20 条：控制栏不越界、不重叠；真实点击分页按钮后显示 25 条，页面仍不溢出。
- 执行表格、快照最近交付表格可在自身区域横向滚动到末尾，不撑宽页面。
- 执行视图所有列头的实际文字（含排序按钮）都在同一行，且不溢出各自单元格；覆盖全部宽度及亮暗主题。
- 执行视图“运行状态”列的状态文字（夹具覆盖全部运行状态和 Assignment 状态，使用“全部”视图）都在同一行，且不越出所属单元格（不侵入相邻 Harness 列）；夹具使用三位编号和完整的模型、effort、上下文用量；覆盖全部宽度及亮暗主题。
- 所有页面、所有宽度下，导航里带计数的链接，计数与文字之间至少有 8px 间距。
- 768px 及以上的导航和所有元素几何、关键样式与基线一致；执行视图仅允许 C-122 的列头不换行和 C-159 的状态文字不换行（含状态值列最小宽度）调整，所有页面允许 C-159 的导航计数间距，比较时给基线加上同样的规则。390px 看板布局比较同样只允许导航计数间距。

失败退出码非零。`responsive-fixture.tsx` 只由该测试入口加载，不进入产品构建。

C-161 新建员工单独截图：`pnpm --filter @cardigan/web exec node test-support/employee-screenshots.mjs <输出目录>`。同样通过 `CHROMIUM_PATH` 指定浏览器；`EMPLOYEE_BASELINE_REF` 默认 `origin/main`，应指定实现起点提交以复现改前截图。仅加载设置页夹具与实际人物库，在 1440px、390px 及亮暗主题下输出改前新建角色、改后人物选择、自定义头像表单共 12 张图，并检查页面无水平溢出。不启动业务服务、不写正式员工。

C-158 并发面板单独核对：`CAPACITY_SCREENSHOTS=/tmp/cardigan-capacity CAPACITY_BASELINE_REF=<修改前提交> node apps/web/test-support/execution-capacity-screenshots.mjs`（从仓库根目录运行，可设 `CHROMIUM_PATH`）。使用本地夹具的同一执行视图，修改前加载指定提交的面板组件并展示 `local · Agent`，修改后按 Q-266 同样展示 `local · Agent`，并展示超限提示；输出 1440px、390px 亮暗截图，并检查封顶、保存按钮禁用和页面不溢出。截图是测试数据，显示名回退的真实读取另由 HTTP 测试覆盖。

C-205 拍板区块与卡片详情：`node apps/web/test-support/compact-merge-screenshots.mjs /tmp/cardigan-compact`（仓库根目录运行，可设 `CHROMIUM_PATH`）。`COMPACT_BASELINE_REF` 默认本卡起点 `69f4e14b20f453ff4ccea5d2dfe7a322154bdb8d`；改前加载该提交的 React 组件和 CSS，改后加载当前源码，两者使用同一份本地数据与产品字体，不连接业务服务。Q-337 文案来自 C-205 的历史摘录，检查名称、耗时及其他状态使用示意数据。覆盖 1440 亮／暗、390 亮，共 48 个页面组合，检查无横向溢出及单一状态条；另验证键盘展开／收起、导航自动展开，以及从已滚动页面进入详情和显式锚点定位。输出 29 张截图（含 4 张窄屏首屏对比图和 2 张定位图）与 `measurements.json`，记录区块高度、主操作相对视口位置及 3 组实际路由定位结果。完整截图超过一屏不表示按钮不可见，测量也不代表所有真实记录的固定节省幅度。

C-207 执行视图布局：`node apps/web/test-support/execution-layout-screenshots.mjs /tmp/cardigan-execution`（仓库根目录运行，可设 `CHROMIUM_PATH`）。`EXECUTION_BASELINE_REF` 默认本卡起点 `077f5ccf13787b6c117f3d7215a77c5890135ab1`，改前加载该提交的执行视图、并发面板、Foundation 和 CSS，改后加载当前源码，两者使用同一份演示数据（`execution-layout-fixture.tsx`，9 个 Assignment、上下文正常／提醒／换会话／未上报），不连接业务服务。覆盖 1440×900 与 390×844 的亮暗主题，断言无横向溢出、改后 1440 每行 ≤72px 且首屏至少 7 行完整可见、并发区位于列表之后、390 只渲染卡片；另截取展开并发区的超限校验和详情抽屉，输出首屏、整页截图和 `measurements.json`。`responsive-layout.mjs` 中执行视图不再与基线 CSS 做几何比较，760px 及以下检查卡片而非表格。
