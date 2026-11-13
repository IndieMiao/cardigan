/* Standalone design prototype. It makes no API calls and persists no decisions. */
const sample = {
  card: "C-199", decision: "Q-337", title: "将 C-199 合并到 main？",
  cardTitle: "P2a-14 ⑧ 跟进：灰度开关 enable_reviewer_browser 接入界面卡代确认判定",
  change: "开了截图核对开关后，界面卡的截图核对只能由二郎神给结论，PM 只有在它通过时才能代确认合并。",
  impact: "开关默认关着，现在行为不变。",
  risk: "改了 PM 和独立复核员的角色规则，须由你亲自确认。",
  gaps: ["改了 PM 和独立复核员的角色规则，须由你亲自确认。"],
  delivery: "孙悟空：C-199 完成申请。按 Q-336 a 把开关接上界面卡代确认。D-684 已通过代码审核 V-658 和独立复核 V-657。角色正文改动按 Q-279 需要人确认后合并。",
  context: "卡片标题：P2a-14 ⑧ 跟进：灰度开关 enable_reviewer_browser 接入界面卡代确认判定。拍板原问题：将 C-199 合并到 main？建议理由原文：合并检查全部通过；代码审核、独立复核、PM 验收都已通过，没有未处理的 must_fix；开关默认关闭，关闭时行为不变。补充说明还包含改动章节及合并后两条 role upgrade 命令。",
  work: "W-592", author: "孙悟空", assignment: "",
  source: "来源：C-205#9（PM 摘录 Q-337 交人时的历史快照，现已合并）。三段概述为 PM 提供的 C-202 字段示例；不代表当前待办。",
};
const scenarios = {
  ready: { label: "核对完成 / 等你", handler: "等你确认", check: "已通过", tone: "pass" },
  pm: { label: "核对完成 / PM 代确认", handler: "PM 代确认中", check: "已通过", tone: "pass", pm: true },
  held: { label: "暂缓 / PM / 检查中", handler: "PM 暂缓中", check: "运行中", tone: "progress", held: true, pm: true, waiting: true },
  heldHuman: { label: "暂缓 / 等你 / 检查中", handler: "等你确认", check: "运行中", tone: "progress", held: true, waiting: true },
  handoff: { label: "Q-332 / 暂缓交接歧义", handler: "PM 暂缓中", check: "已通过", tone: "pass", held: true, pm: true, handoff: true, gaps: null },
  running: { label: "等你 / 检查中", handler: "等你确认", check: "运行中", tone: "progress", waiting: true },
  pending: { label: "核对待完成 / 旧结论", handler: "等你确认", check: "已通过", tone: "pass", pending: true, stale: true },
  queued: { label: "等你 / 检查排队", handler: "等你确认", check: "排队中", tone: "wait", waiting: true },
  nonblocking: { label: "非阻塞 / 等你", handler: "等你确认", check: "已通过", tone: "pass", nonblocking: true },
  expired: { label: "暂缓到期 / 等你", handler: "等你确认", check: "已通过", tone: "pass", expired: true },
  failed: { label: "检查失败 / 建议退回", handler: "等你处理", check: "未通过", tone: "danger", failure: true, gaps: ["窄屏操作区溢出，当前不能视为已修复。"] },
  confirmed: { label: "已确认 / 检查超时", handler: "等你处理", check: "超时", tone: "danger", failure: true, confirmed: true, gaps: ["检查超时，尚未合并。"] },
  unreachable: { label: "执行主机不可达", handler: "等主机恢复", check: "执行主机不可达", tone: "wait", unreachable: true },
  interrupted: { label: "检查中断", handler: "等主机恢复", check: "已中断", tone: "wait", unreachable: true },
  invalid: { label: "闸门配置无效", handler: "等主机处理", check: "配置无效", tone: "danger", invalid: true },
  stale: { label: "建议过期 / 等你", handler: "等你确认", check: "已通过", tone: "pass", stale: true },
  missing: { label: "旧记录 / 缺少概述", handler: "等你确认", check: "已通过", tone: "pass", missing: true },
  noop: { label: "交付已在基线", handler: "等你确认", check: "无需检查", tone: "pass", noop: true },
  noGate: { label: "未启用合并检查", handler: "等你确认", check: "未启用", tone: "muted", noGate: true },
  batch: { label: "卡级检查已通过", handler: "等你确认", check: "卡级检查已通过", tone: "pass", batch: true },
  noGaps: { label: "遗留 / 明确 0 项", handler: "等你确认", check: "已通过", tone: "pass", gaps: [] },
  differentGaps: { label: "遗留 / 与风险不同的 2 项", handler: "等你确认", check: "已通过", tone: "pass", gaps: ["390px 截图中的长标题尚未核对。", "暗色错误态截图尚未补齐。"] },
  cardReview: { label: "详情 / 等审核 / 无合并确认", noMerge: true, cardStatus: "审核中", handler: "等妙玉审核", next: "完成设计审核", risk: "窄屏与暗色布局尚待设计审核。", gaps: [] },
  cardBlocked: { label: "详情 / 人工待办阻塞 / 无合并确认", noMerge: true, cardStatus: "进行中", handler: "等你处理", next: "补齐截图", blocked: true, risk: "缺少窄屏截图，设计审核暂不能继续。", gaps: ["缺少 390px 截图，须补齐后再继续设计审核。"] },
};
const $ = (selector) => document.querySelector(selector);
const escapeText = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Prototype counterpart of the shared IdTag registry; full prefixes only.
const idTypes = {
  C: { label: "卡片", token: "card" }, W: { label: "工作项", token: "work-item" },
  Q: { label: "拍板", token: "decision" }, A: { label: "责任上下文", token: "assignment" },
  R: { label: "执行", token: "run" }, D: { label: "交付", token: "delivery" },
  V: { label: "审核", token: "review" }, H: { label: "人工待办", token: "human-action" },
  E: { label: "员工", token: "employee" }, M: { label: "成员", token: "member" },
  MB: { label: "合并批次", token: "merge-batch" },
};
const idTag = (id, label, href = "") => {
  const match = /^(MB|[A-Z]+)-\d+(?:#\d+)?$/.exec(id);
  if (!match) return escapeText(id);
  const type = idTypes[match[1]] ?? { label: "编号", token: "unknown" };
  const description = label || type.label;
  return `<${href ? "a" : "span"} class="id id-${type.token}" ${href ? `href="${escapeText(href)}"` : ""} title="${escapeText(description)}"><span class="id-code">${escapeText(id)}</span><span class="id-label">${escapeText(description)}</span></${href ? "a" : "span"}>`;
};
const identity = (name = "系统") => `<span class="identity"><span class="avatar" aria-hidden="true">${name === "系统" ? "⚙" : name[0]}</span><strong>${name}</strong></span>`;
const state = (text, tone = "muted", symbol = "○") => `<span class="state tone-${tone}"><span aria-hidden="true">${symbol}</span><b>${text}</b></span>`;
const params = new URLSearchParams(location.search);
if (params.get("capture") === "1") document.body.classList.add("capture");
let view = ["before", "card"].includes(params.get("view")) ? params.get("view") : "after";
let scenario = Object.hasOwn(scenarios, params.get("scenario")) ? params.get("scenario") : "ready";
if (view === "before") scenario = "ready";
let activeAction = "";
let returnFocus;
const drafts = { note: "", reason: "", until: "" };
$("#scenario").innerHTML = Object.entries(scenarios).map(([key, s]) => `<option value="${key}">${s.label}</option>`).join("");
$("#view").value = view;
$("#scenario").value = scenario;
$("#theme").value = params.get("theme") === "dark" ? "dark" : "light";

function statusLine(s, inCard = false) {
  return `<div class="status-line" role="group" aria-label="${inCard ? "卡片状态、等谁与下一步" : "合并状态汇总"}">
    ${inCard ? state("待合并", "muted", "○") : ""}
    ${state(s.nonblocking ? "非阻塞" : "阻塞后续", "muted", "◇")}
    ${s.expired ? state("暂缓已到期", "wait", "◷") : ""}
    ${s.held ? state(s.handoff ? '已暂缓至 <time datetime="2026-11-13T10:21:00Z" title="2026-11-13 18:21，UTC+08:00">11-13 18:21</time>' : '已暂缓至 <time datetime="2026-11-14T10:30:00+08:00" title="2026-11-14 10:30，UTC+08:00">11-14 10:30</time>', "wait", "◷") : ""}
    ${state(s.handler, s.pm ? "muted" : "wait", s.pm ? "◉" : "○")}
    ${inCard ? state(`下一步：${s.failure ? "处理检查问题" : s.unreachable ? "恢复检查" : s.invalid ? "修复配置" : s.held ? "处理暂缓" : "确认合并"}`, "muted", "↗") : ""}
    ${s.pm ? state("你可直接处理", "muted", "↗") : s.pending ? state("可提前确认", "wait", "!") : ""}
    ${state(`合并检查：${s.check}`, s.tone, s.tone === "pass" ? "✓" : s.tone === "danger" ? "!" : "◷")}
    ${s.confirmed ? state("已确认合并", "muted", "✓") : ""}
  </div>`;
}
function meta() {
  return `<div class="decision-meta">${identity()}${idTag(scenarios[scenario].handoff ? "Q-332" : sample.decision, "合并确认")}${idTag(scenarios[scenario].handoff ? "C-197" : sample.card, "卡片", `?view=card&scenario=${scenario}`)}<span class="age">${scenario === "ready" || scenarios[scenario].handoff ? "历史样例" : "状态示意"}</span></div>`;
}
function overview(s, omitRisk = false) {
  if (s.missing) return `<div class="exception"><strong>尚未提供改动概述</strong><p>请先查看交付原文；风险尚未说明。</p></div>`;
  if (s.handoff) return `<dl class="overview" aria-label="改动概述"><dt>改了什么</dt><dd>原始资料未摘录，请查看 C-197 交付说明。</dd><dt>对你的影响</dt><dd>原始资料未摘录。</dd>${omitRisk ? "" : '<dt>风险</dt><dd class="risk">原始资料未摘录，不能视为无风险。</dd>'}</dl>`;
  return `<dl class="overview" aria-label="改动概述"><dt>改了什么</dt><dd>${escapeText(sample.change)}</dd><dt>对你的影响</dt><dd>${escapeText(sample.impact)}</dd>${omitRisk ? "" : `<dt>风险</dt><dd class="risk tone-wait">${escapeText(sample.risk)}</dd>`}</dl>`;
}
function exceptions(s) {
  const parts = [];
  if (s.held) parts.push(`<strong>暂缓原因：${s.handoff ? "只差截图核对。" : "等待核对最新截图。"}</strong>`);
  if (s.expired) parts.push('<strong>此前暂缓：等待核对最新截图。</strong>');
  if (s.handoff) parts.push('<p>截图核对：已通过。<a href="#context">暂缓原说明</a></p>');
  if (s.pending) parts.push('<strong>截图核对待完成：旧版本结论已失效。</strong>');
  if (s.failure) parts.push(`<strong>${s.confirmed ? "检查超时，尚未合并。" : "必须修复：窄屏操作区溢出。"}</strong>`);
  if (s.unreachable) parts.push('<strong>等主机恢复后自动重新排队。</strong>');
  if (s.invalid) parts.push('<strong>合并闸门配置无效，请查看 server 启动日志。</strong>');
  if (s.noop) parts.push('<strong>主机已验证交付均在基线中，无需合并检查。</strong>');
  if (s.batch) parts.push('<strong>卡级检查不含端到端检查。</strong>');
  if (scenario === "ready") parts.push('<strong>合并后：升级 PM、独立复核员两个角色。</strong> <a href="#deliveries">查看说明</a>');
  return parts.length ? `<div class="exception ${s.failure || s.invalid ? "error" : ""}" aria-label="当前需要留意">${parts.join("")}</div>` : "";
}
function suggestion(s) {
  if (s.missing || s.invalid || s.waiting || s.unreachable || s.confirmed || s.noop || s.noGate || s.handoff) return "";
  return `<div class="suggestion"><strong>建议：${s.failure ? "退回修改" : "确认合并"}</strong>${s.stale ? ' <span class="tone-wait">已过期</span>' : ""}<p class="small">${s.stale ? "依据已更新，请重新判断。" : s.failure ? "先修复窄屏溢出，再提交新版本。" : "六项检查、三类审核均通过，无待修问题。"}</p></div>`;
}
function hasSuggestion(s) {
  return !s.missing && !s.invalid && !s.waiting && !s.unreachable && !s.confirmed && !s.noop && !s.noGate && !s.stale && !s.handoff;
}
function actionBlock(s) {
  return `<section class="decision-actions" aria-label="合并操作">
    <div class="actions" id="primary-actions">
      ${hasSuggestion(s) ? `<button type="button" data-action="suggestion">按建议：${s.failure ? "退回修改" : "确认合并"}</button>` : ""}
      ${!s.confirmed ? `<button type="button" data-action="merge" class="${hasSuggestion(s) ? "quiet" : ""}">${s.batch ? "确认合并（批次检查通过后生效）" : "确认合并"}</button>` : ""}
      ${s.failure ? '<button type="button" class="quiet" data-action="recheck">重新检查</button>' : ""}
      ${!s.confirmed ? '<button type="button" class="quiet" data-action="hold">暂不合并</button>' : ""}
      <button type="button" class="quiet danger" data-action="return">退回修改</button>
    </div>
    ${s.batch || s.waiting || s.failure || s.invalid || s.unreachable || s.pending ? `<p class="action-help">${s.pending ? "未完成核对，确认时会再提醒。" : s.batch ? "批次检查通过后生效。" : "检查通过后才会合并。"}</p>` : ""}
    <details class="note-details"><summary>补充说明 <span class="muted">可选，作为你的原话记录</span></summary><label class="field">你的补充说明<textarea id="note" aria-label="补充说明">${escapeText(drafts.note)}</textarea></label></details>
  </section>`;
}
function delivery() {
  if (scenarios[scenario].handoff) return '<p>本例仅取得 Q-332 的暂缓与交接状态；完整交付原文未摘录。</p>';
  return `<div class="detail-row">${identity(sample.author)}${idTag(sample.work, "产出")}</div><p>${escapeText(sample.delivery)}</p><p class="muted small">补充说明另有合并后的两条角色升级命令，本例未取得命令全文，不作补造。</p>`;
}
function reviews(s) {
  return `<p>${s.pending ? "截图核对：待完成（旧版本结论）。" : "合并前核对：已通过。"}</p><p>${s.failure ? "审核：有必须修复问题，详见上方风险提示。" : s.handoff ? "截图核对已通过。其余审核信息未摘录。" : "代码审核 V-658：已通过；独立复核 V-657：已通过；PM 验收：已通过。"}</p><p>当前合并检查：${s.check}。${scenario === "ready" ? "六项全部通过；各项名称和耗时未摘录，不作补造。" : "此状态为设计示意。"}</p>`;
}
function evidence(s) {
  return `<div class="evidence">
    <details id="deliveries" ${s.missing ? "open" : ""}><summary>交付详情 <span class="muted">查看原文</span></summary><div class="detail-content">${delivery()}</div></details>
    <details id="reviews"><summary>审核与验收 <span class="${s.pending || s.failure ? "tone-wait" : "muted"}">${s.pending ? "1 项待核对" : s.failure ? "有待处理问题" : "查看依据"}</span></summary><div class="detail-content">${reviews(s)}</div></details>
    ${knownGaps(s)}
    <details id="context"><summary>上下文原文</summary><div class="detail-content">${s.handoff ? "来源 C-205#8、#9。PM 说明：等截图核对通过后交人确认，不由我代确认。" : escapeText(sample.context)}</div></details>
  </div><details class="standard"><summary>操作说明</summary><div class="detail-content"><ol><li>查看交付和审核与验收。</li><li>需要时填写补充说明。</li><li>点击确认合并。</li><li>${s.noGate || s.noop ? "合并结果会出现在卡片时间线上。" : "等待合并检查通过并完成合并，结果会出现在卡片时间线上。"}</li></ol><p>“按建议：确认合并”和“确认合并”都会记录你的合并决定；前者另记为采纳建议。暂缓到期会回到待处理，不等于自动合并。PM 持有时，你仍可直接处理。</p></div></details>`;
}
function knownGaps(s) {
  // Explicit empty list differs from missing data. Never classify free text.
  const gaps = s.gaps ?? null;
  const summary = gaps === null ? "资料未提供" : `${gaps.length} 项`;
  return `<details id="gaps" ${gaps === null || gaps.length > 0 ? "open" : ""}><summary>已知遗留 <span class="muted">${summary}</span></summary><div class="detail-content">${gaps === null ? "遗留资料未提供，不能视为无遗留。" : gaps.length ? `<ul>${gaps.map(gap => `<li>${escapeText(gap)}</li>`).join("")}</ul>` : "交付明确记录无已知遗留。"}</div></details>`;
}
function after(s) {
  return `<article class="decision" id="decision" aria-label="合并确认原型">${meta()}<h2 class="decision-title">${s.handoff ? "将 C-197 合并到 main？" : escapeText(sample.title)}</h2>${statusLine(s)}${overview(s)}${exceptions(s)}${suggestion(s)}${actionBlock(s)}${evidence(s)}</article>`;
}
function before(s) {
  return `<article class="decision before" id="decision" aria-label="改前布局复刻">
    ${meta()}<p class="tone-danger small">◇ 阻塞</p><h2 class="decision-title">${escapeText(sample.title)}</h2>
    ${s.held ? '<p class="old-status">◷ 已暂缓：等待核对最新截图（到 10:30）</p>' : ""}
    ${s.pm ? '<p class="old-status muted">PM 正在代确认。你可以直接选择合并、暂不合并或退回修改，按你的拍板记录，PM 之后不能再处理这一条；选择合并仍要通过合并闸门检查。</p>' : ""}
    <div class="old-box"><p class="tone-pass"><strong>核对已完成，可以确认合并</strong></p><ul><li>截图核对：已通过</li><li>独立复核：已通过</li></ul><ol><li>看一遍下面的“要合并的交付”和“审核与验收”。</li><li>需要的话，在“补充说明”里写下你的原话。</li><li>点“确认合并”。</li><li>等待合并检查通过并完成合并，结果会出现在卡片时间线上。</li></ol></div>
    ${suggestion(s)}<div class="old-section"><h3>合并检查</h3><p class="tone-${s.tone}">${s.check}</p><p class="small muted">检查范围：全量</p></div>
    <div class="old-section"><h3>要合并的交付</h3><div class="old-row">${delivery()}</div></div>
    <div class="old-section"><h3>审核与验收</h3><div class="old-row">${reviews(s)}</div></div>
    <div class="old-section"><h3>已知遗留</h3><div class="old-row">${escapeText(sample.risk)}</div></div>
    <label class="field">补充说明（可选，会作为你的原话记录）<textarea id="note">${escapeText(drafts.note)}</textarea></label>
    <div class="decision-actions"><div class="actions" id="primary-actions"><button data-action="merge">确认合并</button><button class="quiet" data-action="hold">暂不合并</button><button class="quiet" data-action="return">退回修改</button></div></div>
    <details class="standard"><summary>上下文原文</summary><p>${escapeText(sample.context)}</p></details>
  </article>`;
}
function card(s) {
  const cardId = s.noMerge ? "C-205" : s.handoff ? "C-197" : sample.card;
  const cardTitle = s.noMerge ? "拍板区块紧凑化：合并状态收成一行，标准步骤和次要信息折叠" : s.handoff ? "卡片标题未摘录" : sample.cardTitle;
  const risk = s.noMerge ? s.risk : s.handoff || s.missing ? "风险资料未提供，不能视为无风险。" : sample.risk;
  const status = s.noMerge ? `<div class="status-line" role="group" aria-label="卡片状态、等谁与下一步">${state(s.cardStatus, "muted", "○")}${s.blocked ? state("人工待办阻塞", "danger", "◇") : ""}${state(s.handler, "wait", "○")}${state(`下一步：${s.next}`, "muted", "↗")}</div>` : statusLine(s, true);
  return `<article class="decision card-hero" id="${s.noMerge ? "card-summary" : "decision"}" aria-label="卡片详情原型">
      <header><div class="decision-meta">${idTag(cardId, "卡片")}<span class="age">${s.noMerge || scenario !== "ready" && !s.handoff ? "状态示意" : "历史样例"}</span></div><h1>${escapeText(cardTitle)}</h1>${status}<div class="card-risk"><span class="muted">关键风险</span><p>${escapeText(risk)}</p></div></header>
      ${s.noMerge ? `<section class="card-current"><h2>${s.blocked ? "待你处理" : "等待设计审核"}</h2><p>${s.blocked ? "补齐 390px 截图后，设计审核才能继续。" : "方案与原型已提交，等待宽屏、窄屏和暗色截图核对。"}</p><a class="button-link" href="#card-task">${s.blocked ? "查看人工待办" : "查看待审交付"}</a></section><div class="evidence">${knownGaps(s)}</div>` : `<section class="card-current" aria-label="合并处理"><h2>${idTag(s.handoff ? "Q-332" : sample.decision, "合并确认")} ${s.handoff ? "将 C-197 合并到 main？" : escapeText(sample.title)}</h2>${overview(s, true)}${exceptions(s)}${suggestion(s)}${actionBlock(s)}${evidence(s)}</section>`}
    </article>
    <nav class="card-nav" aria-label="卡片区块"><a href="#${s.noMerge ? "card-summary" : "decision"}">${s.noMerge ? "当前进展" : "合并处理"}</a><a href="#card-overview">目标与验收</a><a href="#timeline">时间线</a><a href="#execution">执行视图</a></nav>
    ${s.noMerge ? `<details id="card-task" class="card-task"><summary>${s.blocked ? "人工待办" : "待审交付"} <span class="muted">${s.blocked ? "补齐窄屏截图" : "设计方案与原型"}</span></summary><div class="detail-content"><p>${s.blocked ? "缺少 390px 截图，须补齐后再继续设计审核。" : "核对状态条、默认信息层级、亮暗主题与窄屏布局。"}</p><p>${idTag("W-625", "设计产出")}${idTag("W-626", "设计审核")}</p></div></details>` : ""}
    <section class="card-subsections" aria-label="卡片次要信息"><details id="card-overview"><summary>目标与验收标准 <span class="muted">展开查看完整要求</span></summary><div class="detail-content">目标与逐条验收沿用原页面完整数据。本例未摘录，不由完成申请推测勾选。</div></details><details><summary>工作项、关联与附件</summary><div class="detail-content">${s.noMerge ? idTag("W-625", "设计产出") : s.handoff ? "" : idTag(sample.work, "产出")} 完整状态与关联保留原入口。</div></details></section>
    <section class="timeline" id="timeline"><h2>时间线</h2><div class="timeline-line"><div class="detail-row">${identity()}<span class="muted small">${s.noMerge ? "状态示意" : "最新记录"}</span></div><p>${s.noMerge ? s.blocked ? "已登记人工待办：补齐窄屏截图。" : "设计方案已提交，等待审核。" : "合并确认等待处理。历史结论和原话仍按原记录展示。"}</p></div></section>
    <details id="execution" class="following"><summary>执行视图 <span class="muted">运行、责任上下文与调试信息</span></summary><div class="detail-content">执行信息放在卡片下方，按需展开。</div></details>`;
}
function render() {
  if (view === "before") scenario = "ready";
  if (scenarios[scenario].noMerge) view = "card";
  $("#view").value = view;
  $("#scenario").value = scenario;
  $("#scenario").disabled = view === "before";
  const s = { ...sample, ...scenarios[scenario] };
  const title = '<div class="page-heading"><h1>需要我</h1><p>看清影响，再作决定。</p></div>';
  const hiddenWaiting = view === "after" && (s.invalid || (s.waiting && !s.pm && !s.held));
  $("main").innerHTML = view === "card" ? card(s) : `${title}<div class="group-heading"><h2>${s.pm ? "PM 代确认中的合并" : "合并确认"}</h2><span class="muted small">${s.pm ? "不计入你的待办" : hiddenWaiting ? "等待检查" : "1 条"}</span></div>${hiddenWaiting ? `<div class="waiting"><h2>还有 1 条合并确认在等检查</h2><p class="muted">检查结束后会出现在这里。</p><p>${idTag(sample.card, "卡片", `?view=card&scenario=${scenario}`)} ${idTag(sample.decision, s.check, `?view=card&scenario=${scenario}`)}</p></div>` : view === "before" ? before(s) : after(s)}<section class="following"><h2>知会</h2><p>已处理的决定与进展保留在这里。</p></section>`;
  $("main").insertAdjacentHTML("beforeend", `<p class="source-note">${s.noMerge ? "C-205 无合并确认的布局示意。卡号、标题与工作项取自本卡，状态、人工待办及风险为假设数据，不代表真实记录。" : s.handoff ? "来源：C-205#8、#9，Q-332 暂缓与交接歧义的历史示例。改动概述未摘录。" : escapeText(sample.source)}${scenario !== "ready" && !s.handoff && !s.noMerge ? " 当前状态组合为交互示意，并非该历史记录的真实状态。" : ""}${view === "before" ? " 改前为基于仓库组件的布局复刻，不是生产截图。" : ""}</p>`);
  document.documentElement.dataset.theme = $("#theme").value;
  const next = new URLSearchParams({ view, scenario, theme: $("#theme").value });
  if (document.body.classList.contains("capture")) next.set("capture", "1");
  history.replaceState(null, "", `?${next}`);
}
function showDialog(action, trigger) {
  const s = scenarios[scenario];
  activeAction = action === "suggestion" ? s.failure ? "return" : "merge" : action;
  returnFocus = trigger;
  if ((activeAction === "merge" && !s.pending) || activeAction === "recheck") {
    $("#feedback").hidden = false;
    $("#feedback").textContent = "演示完成，未提交真实拍板；状态保持不变。";
    return;
  }
  const copies = {
    merge: [s.pending ? "还有 1 项核对没有完成，确定现在确认合并吗？" : "确认合并", s.pending ? "确认后会按你的拍板合并，不再等待这些核对。合并检查仍须通过。" : "这是本地原型。实际产品沿用原有提交；仅有未完成核对时才弹二次确认。"],
    hold: ["暂不合并", "请填写暂缓原因。到期时间可选，不填时沿用项目设置。"],
    return: ["退回修改", "请写清需要修改的内容，原因会记录在卡片时间线上。"],
    recheck: ["重新检查", "原型演示：提交后等待当前完成申请的新检查结果。"],
  };
  $("#dialog-title").textContent = copies[activeAction][0];
  $("#dialog-copy").textContent = copies[activeAction][1];
  const isReason = ["hold", "return"].includes(activeAction);
  $("#dialog-fields").innerHTML = isReason ? `<label class="field">${activeAction === "hold" ? "暂缓" : "退回"}原因（必填）<textarea id="reason" required>${escapeText(drafts.reason || (action === "suggestion" ? "请修复窄屏操作区溢出，再提交新版本。" : ""))}</textarea></label>${activeAction === "hold" ? `<label class="field">到期时间（可选）<input id="until" type="datetime-local" value="${escapeText(drafts.until)}"></label>` : ""}` : "";
  $("#dialog-submit").textContent = s.pending && activeAction === "merge" ? "仍然确认合并" : activeAction === "hold" ? "登记暂缓" : activeAction === "return" ? "确认退回" : "确认";
  $("#action-dialog").showModal();
  if (s.pending && activeAction === "merge") $("#dialog-cancel").focus();
}
$("#main").addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (button) showDialog(button.dataset.action, button);
  const link = event.target.closest('a[href^="#"]');
  if (link) {
    const target = document.getElementById(link.getAttribute("href").slice(1));
    if (target?.tagName === "DETAILS") target.open = true;
  }
});
document.addEventListener("input", (event) => {
  if (event.target.id === "note") drafts.note = event.target.value;
  if (event.target.id === "reason") drafts.reason = event.target.value;
  if (event.target.id === "until") drafts.until = event.target.value;
});
$("#action-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if ($("#reason") && !$("#reason").value.trim()) { $("#reason").setCustomValidity("请填写原因，不能只有空白。"); $("#reason").reportValidity(); return; }
  $("#action-dialog").close();
  $("#feedback").hidden = false;
  $("#feedback").textContent = "演示完成，未提交真实拍板；状态保持不变。";
});
$("#dialog-fields").addEventListener("input", () => $("#reason")?.setCustomValidity(""));
$("#dialog-cancel").addEventListener("click", () => $("#action-dialog").close());
$("#action-dialog").addEventListener("close", () => returnFocus?.focus());
for (const control of ["view", "scenario", "theme"]) {
  $(`#${control}`).addEventListener("change", () => {
    view = $("#view").value; scenario = $("#scenario").value;
    if (control === "view" && view !== "card" && scenarios[scenario].noMerge) scenario = "ready";
    render();
  });
}
render();
