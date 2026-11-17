/* C-408 design only. Deterministic synthetic data; no API or persistent writes. */
const q = new URLSearchParams(location.search);
const theme = q.get("theme") === "dark" ? "dark" : "light";
const view = q.get("view") === "drawer" ? "drawer" : "page";
const before = q.get("version") === "before";
const state = ["backlog", "progress", "review"].includes(q.get("state"))
  ? q.get("state")
  : "backlog";
const samples = {
  backlog: {
    id: "C-4081",
    title: "梳理任务交接的确认流程",
    status: "待整理",
    who: "",
    next: "",
    time: "11 小时前",
    risks: "权限 · 安全 · 数值规则",
    template: "开发卡 v1",
  },
  progress: {
    id: "C-4082",
    title: "整理卡片详情与抽屉的阅读顺序",
    status: "进行中",
    who: "设计师",
    next: "提交方案",
    time: "8 分钟前",
    risks: "",
    template: "开发卡 v1",
  },
  review: {
    id: "C-4083",
    title:
      "统一详情页与抽屉布局，并保留长标题、完整操作后果和审核记录的阅读入口",
    status: "审核中",
    who: "审核员",
    next: "审核交付",
    time: "2 分钟前",
    risks: "权限",
    template: "开发卡 v1",
  },
};
const data = { ...samples[state] };
if (q.get("edge") === "long")
  data.title += " / " + "VeryLongUnbrokenTitle".repeat(8);
if (q.get("edge") === "empty")
  Object.assign(data, { who: "", next: "", time: "", risks: "", template: "" });
document.documentElement.dataset.theme = theme;
document.title = `C-408 ${before ? "改前结构重绘" : "增量设计"} · ${data.status} · ${view} · 合成样本`;
const app = document.querySelector("#app");
const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const btn = (name, id, classes = "") =>
  `<button type="button" class="btn ${classes}" id="${id}">${name}</button>`;
const idTag = (id, kind = "") => `<span class="id ${kind}">${id}</span>`;
const values = [
  `<span class="state">${{ backlog: "◌", progress: "◉", review: "◇" }[state]} ${data.status}</span>`,
  data.who && `<span>等 ${data.who}</span>`,
  data.next && `<span>下一步 ${data.next}</span>`,
  data.time && `<span>更新于 ${data.time}</span>`,
  data.risks && `<span class="risk">${data.risks}</span>`,
  data.template && `<span>${data.template}</span>`,
].filter(Boolean);
const relatedTitle =
  q.get("edge") === "long"
    ? "交接记录整理：明确前序任务的状态、确认结果和后续负责人的接续方式"
    : "交接记录整理";
const source = `<p class="quote">合成来源：希望交接记录清楚、当前状态容易找到，操作前能看见后果。</p><div>相关卡片 <a href="#related" class="id-link" aria-label="查看相关卡片 C-4080：${esc(relatedTitle)}" title="C-4080：${esc(relatedTitle)}">${idTag("C-4080")}${before ? "" : `<span class="related-title">${esc(relatedTitle)}</span>`}</a></div>`;
const goal = `<section class="section"><h2>目标</h2><p>把当前状态、主要操作和任务要求放在容易找到的位置，让详情页与抽屉保持一致的阅读顺序。</p></section><section class="section"><h2>验收标准</h2><ol><li>标题和状态清楚，空值不占位。</li><li>主要操作集中，取消卡片前保留确认。</li><li>来源和关联信息可展开，手机上也能完整阅读。</li></ol></section>`;
const overview = `${goal}<details class="background"><summary><span>背景</span><span class="summary-text">来源原话 · 1 张相关卡片</span></summary><div class="background-body">${source}</div></details>`;
const meta = `<div class="meta-shell"><div class="meta" tabindex="0" role="region" aria-label="卡片元信息，可左右滚动">${before ? `<span>更新于 ${data.time || "待明确"}</span><span>${data.status}　等谁：${data.who || "待明确"}　下一步：${data.next || "待明确"}</span><span>待规划</span><span>风险标签：${data.risks || "无"}</span><span>模板：${data.template || "未指定"}</span>` : values.join("")}</div></div>`;
const precheck =
  state === "review"
    ? `<div class="precheck" aria-label="作者预检查"><span class="passed">✓ 预检通过</span><code>408a1b2</code><span>08:00</span><button id="logs">日志 ↗</button></div>`
    : "";
const titlebar =
  before && view === "page"
    ? `<header class="titlebar"><button class="icon" id="back" aria-label="返回卡片">←</button></header>`
    : `<header class="titlebar"><button class="icon" id="back" aria-label="${view === "drawer" ? "关闭抽屉" : "返回卡片"}">${view === "drawer" ? "×" : "←"}</button><h1 id="card-title">${idTag(data.id)}${esc(data.title)}</h1><span class="spacer" aria-hidden="true"></span></header>`;
const more = `<div class="menu" id="more-menu" role="menu" aria-label="更多操作" hidden><button role="menuitem" id="copy-link">复制链接</button><button role="menuitem" id="sensitive">标为敏感</button><hr><button role="menuitem" class="danger" id="cancel-card">取消卡片…</button></div>`;
const actions = `<div class="action-row" aria-label="卡片操作">${btn("编辑", "edit")}${btn("暂停", "hold")}${btn("更多 ⌄", "more")}<a class="textlink right" href="?view=page&state=${state}&theme=${theme}" id="fullpage" ${view === "page" ? "hidden" : ""}>完整页面 ↗</a>${more}</div>`;
const tabs = `<nav class="tabs" role="tablist" aria-label="卡片内容"><button role="tab" id="tab-overview" aria-selected="true" aria-controls="panel-overview">概览</button><button role="tab" id="tab-work" aria-selected="false" aria-controls="panel-work" tabindex="-1">工作项<span class="count">4</span></button><button role="tab" id="tab-timeline" aria-selected="false" aria-controls="panel-timeline" tabindex="-1">时间线<span class="count">2</span></button>${state === "review" ? '<button role="tab" id="tab-records" aria-selected="false" aria-controls="panel-records" tabindex="-1">交付与审核<span class="count">1</span></button>' : ""}</nav>`;
const work = ["整理要求", "设计方案", "设计验收", "实现布局"]
  .map(
    (name, i) =>
      `<div class="work-row"><span class="id work">W-${4081 + i}</span><span class="label">${name}</span><span class="work-status">${i === 0 && state !== "backlog" ? "已完成" : "待处理"}</span></div>`,
  )
  .join("");
const timeline = `<div class="timeline-entry"><b>项目成员</b> <span class="timestamp">08:00</span><p>请先整理状态和操作，再补齐宽窄屏对照。</p></div><div class="timeline-entry"><b>设计师</b> <span class="timestamp">08:10</span><p>已整理方案，下一步检查交互。</p></div><form id="comment-form"><label for="comment">写评论</label><textarea id="comment" placeholder="输入评论" required></textarea><div class="form-actions">${btn("发表（演示）", "send", "primary regular")}</div></form>`;
const body = `${before ? `<div class="source-before"><h2>来源原话</h2>${source}${btn("展开全文", "expand-old")}</div><h2 class="title-repeat">${idTag(data.id)} ${esc(data.title)}</h2>` : ""}${meta}${before ? `<div class="old-action-group">${btn("暂停卡片", "hold")}<div class="old-actions">${btn("编辑", "edit")}${btn("取消卡片", "cancel-card", "danger")}${btn("标为敏感", "sensitive")}</div></div><section class="old-precheck"><h2>作者预检查</h2><p>结果仅适用于所列被检提交。通过后仍需正式审核和最终合并检查。</p><p>${state === "review" ? "预检通过 · 408a1b2 · 08:00" : "尚无作者预检查"}</p></section>` : actions + precheck}${tabs}${before ? btn("写评论", "old-comment", "primary") : ""}<div class="content" id="panel-overview" role="tabpanel" aria-labelledby="tab-overview">${before ? goal + '<details class="old-work"><summary>工作项（0/4 完成）</summary>' + work + "</details>" : overview}</div><div class="content" id="panel-work" role="tabpanel" aria-labelledby="tab-work" hidden>${work}</div><div class="content" id="panel-timeline" role="tabpanel" aria-labelledby="tab-timeline" hidden>${timeline}</div><div class="content" id="panel-records" role="tabpanel" aria-labelledby="tab-records" hidden><h2>交付与审核</h2><p>设计稿 v1 · 待审核</p></div>`;
const nav = `<aside class="shell-nav"><div class="brand">CARDIGAN</div><span class="nav-label">合成项目</span><span class="nav-label">Needs You</span><span class="nav-label active">卡片</span><span class="nav-label">执行视图</span><span class="nav-label">项目动态</span></aside>`;
const board = `<div class="board"><h1>卡片</h1><div class="board-columns"><section class="column"><h2>待整理</h2><button class="tile" id="open-card">打开合成示例</button></section><section class="column"><h2>进行中</h2><div class="tile">检查任务交接</div></section></div></div>`;
app.innerHTML = `${nav}<main class="shell" id="background">${view === "drawer" ? board : `<div class="page"><article class="card ${before ? "before" : ""}">${titlebar}${body}</article></div>`}</main>${view === "drawer" ? `<div class="overlay" id="shade"></div><section class="drawer" id="drawer" role="dialog" aria-modal="true" aria-labelledby="card-title"><article class="card ${before ? "before" : ""}">${titlebar}${body}</article></section>` : ""}<dialog class="dialog" id="modal"></dialog>`;
let returnFocus, noticeTimer;
const modal = document.querySelector("#modal");
const cardRoot = document.querySelector(".card");
function closeDialog() {
  modal.close();
  returnFocus?.focus();
}
function openDialog(title, content, danger = false) {
  returnFocus = document.activeElement;
  modal.classList.toggle("danger-dialog", danger);
  modal.innerHTML = `<button class="icon dialog-close" aria-label="关闭对话框">×</button><h2 id="modal-title">${title}</h2>${content}`;
  modal.setAttribute("aria-labelledby", "modal-title");
  modal.showModal();
  modal.querySelector(".dialog-close").onclick = closeDialog;
  modal.querySelector("[data-dismiss]")?.addEventListener("click", closeDialog);
  (
    modal.querySelector("input,textarea") ||
    modal.querySelector("[data-dismiss]") ||
    modal.querySelector("button")
  ).focus();
}
modal.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDialog();
});
function notify(kind, text) {
  document.querySelector(".notice")?.remove();
  clearTimeout(noticeTimer);
  const box = document.createElement("div");
  box.className = `notice ${kind}`;
  box.innerHTML = `<p class="message" role="${kind === "error" ? "alert" : "status"}">${esc(text)}</p><button class="notice-details">详情</button><button class="dismiss" aria-label="关闭通知">×</button>`;
  (document.querySelector("#drawer") || document.body).append(box);
  box.querySelector(".dismiss").onclick = () => {
    const focused = box.contains(document.activeElement);
    box.remove();
    if (focused) document.querySelector("#edit")?.focus();
  };
  box.querySelector(".notice-details").onclick = () =>
    openDialog(
      "通知详情",
      `<p>${esc(text)}</p><div class="form-actions"><button class="btn" data-dismiss>关闭</button></div>`,
    );
  positionNotice();
  if (kind === "success") {
    const dismiss = () => {
      if (
        box.matches(":hover") ||
        box.contains(document.activeElement) ||
        modal.open
      ) {
        noticeTimer = setTimeout(dismiss, 1000);
      } else box.remove();
    };
    noticeTimer = setTimeout(dismiss, 5000);
  }
}
function positionNotice() {
  const box = document.querySelector(".notice");
  if (!box) return;
  const r = document.querySelector(".titlebar").getBoundingClientRect();
  const w = Math.min(420, r.width - 100);
  box.style.setProperty("--notice-x", `${r.x + (r.width - w) / 2}px`);
  box.style.setProperty("--notice-width", `${w}px`);
}
window.addEventListener("resize", positionNotice);
window.prototypeNotify = notify;
function changeTab(id) {
  document.querySelectorAll("[role=tab]").forEach((t) => {
    const active = t.id === id;
    t.setAttribute("aria-selected", String(active));
    t.tabIndex = active ? 0 : -1;
    document.querySelector("#" + t.getAttribute("aria-controls")).hidden =
      !active;
  });
}
document.querySelectorAll("[role=tab]").forEach((tab) => {
  tab.onclick = () => changeTab(tab.id);
  tab.onkeydown = (e) => {
    const ts = [...document.querySelectorAll("[role=tab]")];
    let i = ts.indexOf(tab);
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    i =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? ts.length - 1
          : (i + (e.key === "ArrowRight" ? 1 : -1) + ts.length) % ts.length;
    changeTab(ts[i].id);
    ts[i].focus();
  };
});
document.querySelector("#old-comment")?.addEventListener("click", () => {
  changeTab("tab-timeline");
  document.querySelector("#comment").focus();
});
const moreButton = document.querySelector("#more"),
  menu = document.querySelector("#more-menu");
function closeMenu(focus = true) {
  if (!menu) return;
  menu.hidden = true;
  moreButton.setAttribute("aria-expanded", "false");
  if (focus) moreButton.focus();
}
if (moreButton) {
  moreButton.setAttribute("aria-haspopup", "menu");
  moreButton.setAttribute("aria-expanded", "false");
  moreButton.setAttribute("aria-controls", "more-menu");
  moreButton.onclick = () => {
    const open = menu.hidden;
    menu.hidden = !open;
    moreButton.setAttribute("aria-expanded", String(open));
    if (open) menu.querySelector("button").focus();
  };
  menu.onkeydown = (e) => {
    const items = [...menu.querySelectorAll("button")];
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      let i = items.indexOf(document.activeElement);
      i =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? items.length - 1
            : (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) %
              items.length;
      items[i].focus();
    }
    if (e.key === "Tab") closeMenu(false);
  };
  document.addEventListener("click", (e) => {
    if (
      !menu.hidden &&
      !menu.contains(e.target) &&
      !moreButton.contains(e.target)
    )
      closeMenu(false);
  });
}
document.querySelector("#cancel-card").onclick = () => {
  if (menu) {
    closeMenu();
  }
  openDialog(
    `取消卡片 ${data.id}？`,
    `<p>卡片将进入已取消状态。</p><label for="reason">取消原因（可选）</label><textarea id="reason"></textarea><div class="form-actions"><button class="btn" data-dismiss>返回</button><button class="btn danger regular" id="confirm-cancel">确认取消（演示）</button></div>`,
    true,
  );
  modal.querySelector("#confirm-cancel").onclick = () => {
    closeDialog();
    notify("success", "演示：已确认取消流程，未修改任何卡片。");
  };
};
document.querySelector("#copy-link")?.addEventListener("click", () => {
  closeMenu();
  notify("success", "演示：复制卡片链接，未写入剪贴板。");
});
document.querySelector("#sensitive").onclick = () => {
  if (menu) closeMenu();
  notify("success", "演示：标为敏感后，合并确认由人亲自处理。未修改任何卡片。");
};
document.querySelector("#edit").onclick = () => {
  openDialog(
    "编辑卡片 · 演示",
    `<form id="edit-form"><label for="edit-title">标题</label><input id="edit-title" value="${esc(data.title)}" required><label for="edit-goal">目标</label><textarea id="edit-goal" required>把状态、操作和任务要求放在容易找到的位置。</textarea><label for="edit-criteria">验收标准</label><textarea id="edit-criteria" required>标题清楚，操作集中。</textarea><label for="priority">优先级</label><select id="priority"><option>无</option><option>低</option><option>中</option><option selected>高</option><option>紧急</option></select><div class="form-actions"><button type="button" class="btn" data-dismiss>返回</button><button class="btn primary regular">保存（演示）</button></div></form>`,
  );
  modal.querySelector("form").onsubmit = (e) => {
    e.preventDefault();
    closeDialog();
    notify("success", "演示：已完成保存流程，未向服务器提交。");
  };
};
document.querySelector("#hold").onclick = () => {
  openDialog(
    "暂停卡片 · 演示",
    `<form><label for="hold-reason">暂停原因</label><textarea id="hold-reason" required></textarea><label for="resume-condition">恢复条件</label><textarea id="resume-condition" required></textarea><p>暂停期间不派发新工作。已有结果保留，正在执行的工作可继续完成。</p><div class="form-actions"><button type="button" class="btn" data-dismiss>返回</button><button class="btn primary regular">保存（演示）</button></div></form>`,
  );
  modal.querySelector("form").onsubmit = (e) => {
    e.preventDefault();
    closeDialog();
    notify("success", "演示：已完成暂停流程，未修改卡片。");
  };
};
document
  .querySelector("#logs")
  ?.addEventListener("click", () =>
    openDialog(
      "作者预检查",
      `<p>通过 · 08:00</p><p><code>${"408a1b2".padEnd(40, "0")}</code></p><p>合成日志：构建、相关测试通过。</p><div class="form-actions"><button class="btn" data-dismiss>关闭</button></div>`,
    ),
  );
document.querySelector(".id-link")?.addEventListener("click", (e) => {
  e.preventDefault();
  openDialog(
    "相关卡片 C-4080",
    `<p>合成参考：${esc(relatedTitle)}</p><div class="form-actions"><button class="btn" data-dismiss>关闭</button></div>`,
  );
});
document.querySelector("#send").onclick = (e) => {
  e.preventDefault();
  const field = document.querySelector("#comment");
  if (!field.reportValidity()) return;
  notify(
    "error",
    "演示：评论未发送，服务暂时不可用。输入内容已保留，请稍后重试。",
  );
};
function closeDrawer() {
  document.querySelector("#drawer").hidden = true;
  document.querySelector("#shade").hidden = true;
  document.querySelector("#background").inert = false;
  document.querySelector(".shell-nav").inert = false;
  document.querySelector("#open-card").focus();
}
if (view === "drawer") {
  document.querySelector("#background").inert = true;
  document.querySelector(".shell-nav").inert = true;
  document.querySelector("#open-card").onclick = () => {
    document.querySelector("#drawer").hidden = false;
    document.querySelector("#shade").hidden = false;
    document.querySelector("#background").inert = true;
    document.querySelector(".shell-nav").inert = true;
    document.querySelector("#back").focus();
  };
  document.querySelector("#back").onclick = closeDrawer;
  document.querySelector("#back").focus();
  document.addEventListener("keydown", (e) => {
    if (modal.open || document.querySelector("#drawer").hidden) return;
    if (e.key === "Escape" && (!menu || menu.hidden)) {
      e.preventDefault();
      closeDrawer();
    }
    if (e.key === "Tab") {
      const items = [
        ...document
          .querySelector("#drawer")
          .querySelectorAll(
            'button,a,summary,input,textarea,select,[tabindex="0"]',
          ),
      ].filter((n) => n.getClientRects().length && !n.disabled);
      const first = items[0],
        last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
} else
  document.querySelector("#back").onclick = () =>
    notify("success", "演示：返回卡片列表。");
if (q.get("notice"))
  notify(
    q.get("notice"),
    q.get("notice") === "error"
      ? "演示：保存失败，服务暂时不可用。草稿已保留。请求超时，未收到保存结果。"
      : q.get("notice") === "loading"
        ? "演示：正在读取卡片…"
        : "演示：保存完成，未修改真实数据。",
  );

// Keep metadata keyboard scrolling immediate and independent of browser animation.
document.querySelector(".meta").addEventListener("keydown", (event) => {
  const region = event.currentTarget;
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  region.scrollLeft =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? region.scrollWidth
        : region.scrollLeft + (event.key === "ArrowRight" ? 80 : -80);
});

// Edge fading communicates local overflow without adding explanatory copy.
const metadata = document.querySelector(".meta");
const metadataShell = document.querySelector(".meta-shell");
function syncMetadataEdges() {
  const max = metadata.scrollWidth - metadata.clientWidth;
  metadataShell.classList.toggle(
    "has-left-overflow",
    !before && metadata.scrollLeft > 1,
  );
  metadataShell.classList.toggle(
    "has-right-overflow",
    !before && metadata.scrollLeft < max - 1,
  );
}
metadata.addEventListener("scroll", syncMetadataEdges);
metadata.addEventListener("keydown", syncMetadataEdges);
new ResizeObserver(syncMetadataEdges).observe(metadata);
syncMetadataEdges();
