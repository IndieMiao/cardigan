# Workbench 布局回归

C-534（续 C-517）Markdown 表格：`CHROMIUM_PATH=<本机 Chromium> node apps/web/test-support/c534-capture.mjs <新输出目录>`（在 `apps/web` 下运行）。合成夹具 `c534-fixture.tsx`：1 张卡，目标和第一条评论都是同一段正文，含 3 个 Markdown 表格（用户 C-517 截图同款 4 列表、`:---`/`:---:`/`---:` 对齐表含编号/代码/链接/原始 HTML、10 列宽表）；`?help` 用 HelpMarkdown 渲染同一正文。固定时钟 2026-01-01，无业务服务和生产数据。覆盖 1440/390 亮暗：卡片页、详情抽屉的目标与时间线、帮助正文和同宽同主题的卡片列表，目标与评论各展开全文，另把 10 列表滚到末尾截一张；输出截图与 `measurements.json`（表头/首行单元格字号、行高、对齐、边框，滚动容器 clientWidth/scrollWidth，页面与抽屉横向溢出，带编号标签那一行各单元格首行文字的顶边 `rowLineTops`、标签高度，宽表滚到末尾时末列右缘与滚动容器右缘）。脚本只记录不断言，改前改后用同一脚本。

C-518 设置页“模型”：`CHROMIUM_PATH=<本机 Chromium> node apps/web/test-support/c518-capture.mjs <新输出目录>`（仓库根目录运行）。设 `C518_BASELINE_REF=<基线提交>` 加载该提交的设置页、角色面板、api 与测试夹具，只截改前的角色面板与卡片列表；再设 `C518_BEFORE=<改前目录>` 运行改后，统计同名截图差异像素。合成数据为 `src/testing/launch-settings-fixture.ts`（4 个启动配置、3 个 provider、3 个角色引用和 2 个员工引用，只有虚构键名，没有密钥值）与 `settings-panels-data.ts`，固定时钟 2026-01-01，非生产规模，不连接业务服务。覆盖 1440/390 亮暗：模型列表、键盘打开详情（含使用者表）、未通过检查与未设置密钥、角色引用跳转到角色详情（关闭后去掉链接参数）、无数据、读取失败、加载中，并输出与角色面板和卡片列表同宽同主题的并排图与 `measurements.json`；断言无横向溢出、详情无写入控件、Esc 后焦点回到行按钮。

C-463 卡片详情抽屉宽度与加载占位：`CHROMIUM_PATH=<本机 Chromium> pnpm exec node apps/web/test-support/c463-drawer-width.mjs <新输出目录>`（仓库根目录运行）。固定内存夹具 3 张合成卡片，详情请求挂起到脚本放行，从卡片列表真实点击打开抽屉（不存在的 C-404 走同一抽屉路由）；点击前在页面内安装 MutationObserver（抽屉插入后、首次绘制前）和逐帧 requestAnimationFrame 采样，记录每一帧抽屉宽度、加载占位和内容状态。1440/390、亮暗下覆盖首次、重复、换卡和空内容，断言插入与首个绘制帧即有占位、所有帧宽度等于 min(760px, 视口)、占位与内容不同时出现、最终为内容或“找不到卡片”，且无横向溢出。输出加载中/加载后/空内容/卡片页截图和 `measurements.json`。设 `C463_BASELINE_REF=<基线提交>` 加载该提交的样式与详情/列表页组件，只采样截图不断言，用作改前对照。只启动本地 Vite，不连接业务服务。

C-426 / Q-849 正文弱化回归：`CHROMIUM_PATH=<本机 Chromium> pnpm --filter @cardigan/web exec node test-support/prose-layout.mjs <新输出目录>`。使用真实 App、Timeline、统一主题和固定内存夹具（1 张卡、7 条评论/指令、2 个工作项，固定时钟 2026-01-01，无随机种子，非生产规模），核对 390/768/1440、亮暗、抽屉/完整页/非详情上下文共 18 组。断言实际段落的颜色、字号、行高与 AA 对比度，覆盖长评论/指令、159/160 个 Unicode 字符、空白和结构化内容；输出 12 张当前截图及绑定 HEAD/工作区状态的 measurements.json。只启动本地 Vite，不连接业务服务。此脚本不替代五标签布局、键盘交互及 axe 的正式界面验收。

C-409 侧栏构建版本：`CHROMIUM_PATH=<本机 Chromium> node apps/web/test-support/build-version-screenshots.mjs <输出目录>`。使用既有 App 的固定内存夹具（1 项目、1 张卡、2 件待处理，无随机种子，非生产规模），版本为明确固定的演示 SHA 与构建时间，不代表截图环境实际部署。覆盖 1440×900、390×844 亮暗主题，输出桌面侧栏、手机导航展开/收起及完整 SHA 提示共 10 张截图与 `measurements.json`；实际检查本地时区显示、悬停、剪贴板完整内容、44px 触控命中区和页面无横向溢出。不连接业务服务或生产数据。

C-314 审核修正后，执行页脚本增加未分组卡片列表、长中文/连续英文/短标题夹具及标题首行与优先级图标对齐检查，当前版本共 44 场景。用同一命令加 `CARD_LIST_BASELINE_REF=<历史基线SHA>` 可加载该版本的卡片列表组件与样式，只取 1440/390 亮暗四张未分组对照及测量；此模式保留历史目标尺寸，不按本版 44px 要求判历史基线通过。

C-314 执行页分组与泳道：`CHROMIUM_PATH=<本机 Chromium> node apps/web/test-support/execution-display-screenshots.mjs <输出目录>`。加载真实 App 和固定的 8 个 Assignment / 4 个 Run / 4 张卡片合成夹具，无随机种子、无生产数据。核对 1440×900 / 390×844 亮暗主题的执行表格、紧凑筛选、员工分组、折叠、卡片、状态排序、详情抽屉，以及卡片列表的分组菜单、分组、折叠，共 40 张截图及 `measurements.json`；检查页面不溢出、宽屏泳道内部滚动、窄屏纵向堆叠、执行页、卡片列表和分组菜单控件目标至少 44×44、正文与次要文字的主题颜色对比度至少 4.5:1。宽屏下拉框、条件标签与计数同一行；窄屏卡片列表折叠按钮无需横向滚动即可操作；容量入口两种主题下均无边框和底色。实际使用键盘与触控切换，Esc 后焦点回原按钮。组件测试补筛选、空结果、同名员工隔离和本地偏好恢复。只启动本地 Vite，不连接业务服务。

C-316 容量与合并点击盒：`node apps/web/test-support/merge-capacity-targets.mjs <输出目录>`，可设 `CHROMIUM_PATH` 与 `TARGETS_BASELINE_REF`（默认首轮交付）。使用既有内存合成 App 夹具，对比基线／当前 CSS，核对 1440×900、390×844 亮暗主题的容量入口、容量设置输入／保存、卡片合并处理折叠及操作按钮实际至少 44×44px，检查焦点、键盘折叠、容量弹层、合并通过／排队／运行时禁用状态和无横向溢出。输出 40 张截图与盒模型记录；不连接业务服务、不保存设置、不执行候选检查，不代表真实 CI 资源测量。

C-271 合并确认收尾：`node apps/web/test-support/pre-merge-screenshots.mjs <输出目录>`（可设 `CHROMIUM_PATH`，先构建领域包）。`PRE_MERGE_BASELINE_REF` 默认 `17e01446c0f4d08b622d51d1be6e7b20c884e1c3`；同一份非生产规模合成数据加载改前／改后组件，覆盖 Needs You、卡片详情，1440×900／390×844，亮／暗，无记录／排队／运行／通过，共 64 个布局组合。输出 40 张页面、弹窗和超限提示截图及 `measurements.json`，记录按钮、按钮行、缺项列表盒模型和页面宽度；核对单行按钮高度、状态一致性、遮罩、焦点双向圈定、Esc 返回触发按钮及 500／501 个表情码点输入。不连接业务服务或生产库，结束关闭浏览器和本地 Vite。

C-261 列表到底提示：`node apps/web/test-support/pagination-end-screenshots.mjs <输出目录>`（仓库根目录运行，可设 `CHROMIUM_PATH`）。`PAGINATION_BASELINE_REF` 默认本卡起点 `7495a4d7fe274d69f314c43b5d820852456cac00`。同一演示数据加载基线／当前真实组件和样式，输出项目动态、拍板记录的最后一页与空列表，在 1440／390、亮／暗主题下的改前改后共 32 张截图和 `measurements.json`。检查到底文案、分页按钮隐藏、空状态、返回最新和无横向溢出；不连接业务服务。

C-206 / C-254 帮助页截图：`pnpm --filter @cardigan/web exec node test-support/help-screenshots.mjs <输出目录>`（可设 `CHROMIUM_PATH`）。仅启动本地 Vite 并加载现有 App 测试夹具，核对 1440、1920、2560、390px 亮暗主题、帮助目录切换、窄屏抽屉入口和页面无水平溢出。正文段落、列表、标题不超过既有 680px 阅读上限，页面仍撑满，表格和代码使用正文列可用宽度，超长代码可以滚到末尾；列表、引用和代码由真实 HelpMarkdown 渲染额外夹具，不改帮助文档。输出编号、状态、导航文档、正文夹具及抽屉共 34 张截图和 `measurements.json`。不启动业务服务，不访问生产 Workbench。文档维护约定见开发方案 §8.1 的 C-206 段落。

C-203 加载测量：`node apps/web/test-support/load-performance.mjs --local --json /tmp/load.json`（从仓库根目录运行，先 `pnpm exec tsc -b apps/server`、`pnpm --filter @cardigan/web build`）。独立临时 SQLite、210 张卡、577 个 Assignment、4200 条事件/时间线；不启动 Dispatcher，不读取正式数据库。复用本地 Chromium，无新增依赖。详细口径、远程一条命令、冷暖缓存和修前修后数据见 [加载测量记录](../../../docs/research/workbench-load-c203.md)。

C-133 拍板影响范围人工截图：运行 `pnpm --filter @cardigan/web dev --host localhost`，打开 Vite 地址下的 `/test-support/decision-impact.html`。这是本地夹具，不连接业务服务或正式数据库，也不进入产品构建。分别在 1440px、390px 下模拟 `prefers-color-scheme: light/dark`，截取 Needs You 和点击 C-1 后的卡片详情（含合并处理、侧栏拍板和请求／解决时间线）。Q-1 和失败合并确认 Q-2 显示 C-2、C-3、C-4 的链接、缩略标题与状态；Q-3 为空列表、Q-4 仅含所属卡片，均不显示影响行。检查无水平溢出、状态文字不截断、长标题悬停可读，点击 C-2 可打开详情，影响行仍只排除拍板所属的 C-1。

`pnpm --filter @cardigan/web test:layout` 在真实 Chromium 中加载 App、字体和 CSS，使用非空测试夹具；不启动业务服务、Dispatcher，也不连接正式数据库。它与 jsdom 组件测试互补，不加入默认的无浏览器测试流程。

前置条件：已有 Node 24、workspace 依赖和本地 Chromium。默认执行 PATH 中的 `chromium`；使用其他安装位置时设置 `CHROMIUM_PATH` 为浏览器可执行文件路径。测试通过 Chromium 自带的 DevTools pipe 控制浏览器，不需要 Playwright 或新增 npm 依赖。浏览器使用临时 profile，以无沙箱模式运行本地测试代码，结束后关闭浏览器并删除 profile。

可选参数：

- `LAYOUT_BASELINE_REF`：桌面布局比较所用 Git ref，默认 `origin/main`；两套 CSS 作用于同一份 DOM，逐元素比较位置、尺寸和关键样式。验证指定交付时设为其对应的基线提交。
- `LAYOUT_CASES`：按逗号分隔选择页面，例如 `board` 仅检查看板的 5 种宽度与亮暗主题；省略时仍运行全部页面。
- `LAYOUT_SCREENSHOTS`：截图输出目录。设置后输出七页在 390px 下的亮、暗完整截图，以及执行视图在 1440px 下的亮、暗截图；未设置时只运行断言。

覆盖 390、760、768、1280、1440px 与亮暗主题的 70 个场景：

- 六个非看板页的公共导航及主内容宽度，另核对看板周边布局不变（C-210 的列和卡片规则按当前设计比较）。
- 详情共 25 条时间线、初始加载 20 条：控制栏不越界、不重叠；真实点击分页按钮后显示 25 条，页面仍不溢出。
- 执行表格、快照最近交付表格可在自身区域横向滚动到末尾，不撑宽页面。
- 执行视图所有列头的实际文字（含排序按钮）都在同一行，且不溢出各自单元格；覆盖全部宽度及亮暗主题。
- 执行视图“运行状态”列的状态文字（夹具覆盖全部运行状态和 Assignment 状态，使用“全部”视图）都在同一行，且不越出所属单元格（不侵入相邻 Harness 列）；夹具使用三位编号和完整的模型、effort、上下文用量；覆盖全部宽度及亮暗主题。
- 所有页面、所有宽度下，导航里带计数的链接，计数与文字之间至少有 8px 间距。
- 768px 及以上的导航和所有元素几何、关键样式与基线一致；执行视图仅允许 C-122 的列头不换行和 C-159 的状态文字不换行（含状态值列最小宽度）调整，所有页面允许 C-159 的导航计数间距，比较时给基线加上同样的规则。390px 看板布局比较同样允许导航计数间距；C-210 的列宽、滚动条和卡片排版在各宽度使用当前规则，真实改前改后由专项脚本核对。

失败退出码非零。`responsive-fixture.tsx` 只由该测试入口加载，不进入产品构建。

C-161 新建员工单独截图：`pnpm --filter @cardigan/web exec node test-support/employee-screenshots.mjs <输出目录>`。同样通过 `CHROMIUM_PATH` 指定浏览器；`EMPLOYEE_BASELINE_REF` 默认 `origin/main`，应指定实现起点提交以复现改前截图。仅加载设置页夹具与实际人物库，在 1440px、390px 及亮暗主题下输出改前新建角色、改后人物选择、自定义头像表单共 12 张图，并检查页面无水平溢出。不启动业务服务、不写正式员工。

C-158 并发面板单独核对：`CAPACITY_SCREENSHOTS=/tmp/cardigan-capacity CAPACITY_BASELINE_REF=<修改前提交> node apps/web/test-support/execution-capacity-screenshots.mjs`（从仓库根目录运行，可设 `CHROMIUM_PATH`）。使用本地夹具的同一执行视图，修改前加载指定提交的面板组件并展示 `local · Agent`，修改后按 Q-266 同样展示 `local · Agent`，并展示超限提示；输出 1440px、390px 亮暗截图，并检查封顶、保存按钮禁用和页面不溢出。截图是测试数据，显示名回退的真实读取另由 HTTP 测试覆盖。

C-205 拍板区块与卡片详情：`node apps/web/test-support/compact-merge-screenshots.mjs /tmp/cardigan-compact`（仓库根目录运行，可设 `CHROMIUM_PATH`）。`COMPACT_BASELINE_REF` 默认本卡起点 `69f4e14b20f453ff4ccea5d2dfe7a322154bdb8d`；改前加载该提交的 React 组件和 CSS，改后加载当前源码，两者使用同一份本地数据与产品字体，不连接业务服务。Q-337 文案来自 C-205 的历史摘录，检查名称、耗时及其他状态使用示意数据。覆盖 1440 亮／暗、390 亮，共 48 个页面组合，检查无横向溢出及单一状态条；另验证键盘展开／收起、导航自动展开，以及从已滚动页面进入详情和显式锚点定位。输出 29 张截图（含 4 张窄屏首屏对比图和 2 张定位图）与 `measurements.json`，记录区块高度、主操作相对视口位置及 3 组实际路由定位结果。完整截图超过一屏不表示按钮不可见，测量也不代表所有真实记录的固定节省幅度。

C-210 产品看板对照：设置 `C210_PRODUCT=1`、`C210_PLAYWRIGHT_MODULE`、`CHROMIUM_PATH`、`C210_SCREENSHOTS`，执行 `C210_HEADED=1 xvfb-run -a node apps/web/test-support/c210-capture.mjs`。自启本地 Vite，以同一内存夹具加载基线／当前真实组件和样式，核对 Chromium、Firefox 的 1440/390 亮暗共 16 个场景；含 48px 下一列露出、单行常规标题、文本 AA、时间附件同行、键盘滚动和全文提示。基线和证据口径见 [设计说明 §8](../../../docs/design/c210-board-readability.md#8-产品实现与验证w-640)。

C-242 页面撑满：`node apps/web/test-support/full-width-screenshots.mjs /tmp/cardigan-full-width`（仓库根目录运行，可设 `CHROMIUM_PATH`）。`FULL_WIDTH_BASELINE_REF` 默认 `origin/main`；同一份 DOM 先套基线 CSS 截“改前”，再套当前 CSS 截“改后”。夹具参数 `wideBoard` 让看板有 4 列非空（宽于 1920、窄于 2560），`pendingCards` 让卡片列表一直加载以显示“正在加载卡片…”，`feedbackStack` 用真实 `RequestFeedback` 叠一条超长错误和一条带重试按钮的错误。覆盖看板、卡片详情、Needs You、执行视图、加载提示和提示堆叠，在 1440、1920、2560、390 宽度及亮暗主题下输出 96 张截图和 `measurements.json`；断言改后无横向溢出、桌面宽度页面右缘到达内边距、2560 下 4 列看板无需横向滚动，提示区滚到底时区域和末个按钮都在视口底部 16px 以内。不连接业务服务。

C-207 执行视图布局：`node apps/web/test-support/execution-layout-screenshots.mjs /tmp/cardigan-execution`（仓库根目录运行，可设 `CHROMIUM_PATH`）。`EXECUTION_BASELINE_REF` 默认本卡起点 `077f5ccf13787b6c117f3d7215a77c5890135ab1`，改前加载该提交的执行视图、并发面板、Foundation 和 CSS，改后加载当前源码，两者使用同一份演示数据（`execution-layout-fixture.tsx`，9 个 Assignment、上下文正常／提醒／换会话／未上报），不连接业务服务。覆盖 1440×900 与 390×844 的亮暗主题，断言无横向溢出、改后 1440 每行 ≤72px 且首屏至少 7 行完整可见、并发区位于列表之后、390 只渲染卡片；另截取展开并发区的超限校验和详情抽屉，输出首屏、整页截图和 `measurements.json`。`responsive-layout.mjs` 中执行视图不再与基线 CSS 做几何比较，760px 及以下检查卡片而非表格。

C-256 看板卡片尺寸：设置 `C256_PLAYWRIGHT_MODULE`（另行安装的 Playwright 入口）、`C256_SCREENSHOTS`，Chromium 可设 `CHROMIUM_PATH`，执行 `node apps/web/test-support/c256-capture.mjs`。`C256_BASELINE_REF` 默认 `origin/main`，同一份 C-210 本地夹具先套基线 CSS 截改前、再套当前 CSS 截改后；`C256_ENGINES` 默认 `chromium,firefox`。覆盖 1440、1920、2560、390 与亮暗，断言宽屏卡片外框 326px、内容区 300px、列宽等于卡片加滚动条槽位加 8px、列间距 16px，卡片无溢出、标题不截断、每列首屏 10 张、页面无横向溢出；输出截图与 `measurements.json`。不连接业务服务。

C-259 看板平移与隐藏纵向滚动条：设置 `C259_PLAYWRIGHT_MODULE`、`C259_SCREENSHOTS`，Chromium 可设 `CHROMIUM_PATH`，执行 `C259_HEADED=1 xvfb-run -a node apps/web/test-support/c259-capture.mjs`（本机 Firefox 无头环境会隐藏所有滚动条，需有显示环境核对）。基线样式默认取 C-256 合入提交 `2a1584bf`，可通过 `C259_BASELINE_REF` 指定；同一份 C-210 本地夹具比较改前／改后样式，不连接业务服务。`C259_ENGINES` 默认 `chromium,firefox`，按顺序检查 1440、390 的亮暗主题，输出 24 张截图（改前、改后、实际拖动后）与 `measurements.json`。断言纵向滚动条隐藏且无槽位、横向滚动条保留、桌面列宽 334px／卡片外框 326px、窄屏列宽仍为看板宽减 64px；实际鼠标拖动 180px，验证阈值、光标、松开即停与未打开抽屉，并实际操作键盘、纵向滚轮与横向滚轮。Safari、Edge 未单独启动；跨浏览器隐藏由标准与 WebKit 两套 CSS 覆盖。

C-408 详情/抽屉整理：`CHROMIUM_PATH=<本机 Chromium 可执行文件> node apps/web/test-support/c408-capture.mjs <新输出目录>`。脚本比较固定基线 `60eb95489d5361cca6040ab9517a05289eb7ab03` 和当前真实组件；三张固定合成卡（种子标识408、固定时钟2026-11-17T00:00:00Z），分别模拟C-283待整理结构、进行中、审核有预检，不使用生产原文。输出1440×900/390×844、亮暗、完整页/抽屉的48张前后图，另40张取消确认、暂停展开、暂停后取消、元信息焦点和背景展开图及尺寸/行数/对比度测量。核单标题、单行元信息/主操作、44px命中、局部键盘滚动、更多/危险确认/焦点返回、表单互斥与Escape、关联行无下划线/居中、可见元信息焦点和唯一评论入口；只运行本地组件夹具，不连接业务服务。`C408_STAGE=after`只供改后调试，正式证据须省略。改前日志中的重复卡号key警告来自基线同层CardTemplate/CardHold的重复key，改后不再有该警告。

C-411 模板标记：`CHROMIUM_PATH=<本机 Chromium> node apps/web/test-support/c411-capture.mjs <新输出目录>`。以固定基线 `cbd0c094d69499a4e077c4aa1b80226862546baa` 对比当前真实 App；固定合成种子 `c411-implementation-v1`、12 张卡，非生产规模，不连接业务服务。覆盖所有内置/历史/自定义同名/未知/缺版本/长名称，1440×900 与 390×844 亮暗看板、列表、详情及图例，附 44px 命中、16px 图形、24px 浅底、对比度、无页面横溢和窄屏右侧位置测量。浏览器模拟鼠标、触控及 Tab/Enter/Escape，不代表物理触控或真实读屏。`C411_STAGE=after` 只用于调试；正式证据使用两阶段并绑定提交。

C-411 悬停提示回归（V-1862）：`CHROMIUM_PATH=<本机 Chromium> node apps/web/test-support/c411-hover-escape.mjs <新输出目录>`。沿同一固定12卡夹具，覆盖1440/390亮暗页面与抽屉八场景；保留自然焦点（抽屉关闭按钮），只移动鼠标悬停模板图标，核第一次Escape收提示且保留焦点/抽屉、第二次关闭抽屉。输出16张前后状态图和绑定当前SHA的JSON，不使用生产数据或真实业务API。

C-436 执行视图迁移：`CHROMIUM_PATH=<Chromium> AXE_PATH=<axe.min.js> node apps/web/test-support/execution-migration-layout.mjs <输出目录> after`。使用固定内存夹具（8 个 Assignment、4 个 Run、4 张卡、2 台机器，非生产规模），覆盖表格/分组/卡片及卡片页/详情页对照，1440/390 亮暗主题；另核对机器筛选/分组、状态鼠标与 Tab 提示、容量、抽屉焦点返回、28px 控件与 axe。`before` 参数只用于在改前源码上采集基线，不自动检出历史提交；正式报告应注明基线和产出 SHA。旧 execution-display/compact 截图脚本只保留历史证据，当前迁移验证用本脚本。

C-438 执行工具组：`CHROMIUM_PATH=<Chromium> node apps/web/test-support/execution-toolbar-layout.mjs <输出目录> before`，再用 `after` 运行。改前通过 Vite 加载固定基线的 ExecutionPage，不修改工作树；两阶段均复用 C-436 内存夹具（固定时钟 2026-11-15T07:47:30Z、8 个 Assignment、4 个 Run、4 张卡、2 台机器，非生产规模）。覆盖 1440/390×亮暗×表格/分组/卡片和卡片页对照、五种刷新周期与实际鼠标切换/立即刷新、键盘选择周期；每阶段 32 张截图和边界测量。改后断言文字容纳、中心点击命中、相邻 8/8/0px 间距、右对齐、控件不换行、页面无横溢。本地 Chromium 的改前状态未复现用户重叠，不将此回归当作现场问题已复现的证据；不连接生产服务。
