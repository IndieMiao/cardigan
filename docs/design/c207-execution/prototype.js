/* C-207 design fixture only. No API calls, credentials or persisted writes. */
const before = new URLSearchParams(location.search).get('view') === 'before';
document.body.classList.add(before ? 'before' : 'after');
document.querySelector(before ? '#before-link' : '#after-link').setAttribute('aria-current', 'page');
if (before) document.querySelector('#description').textContent = '查看 Agent 的运行环境、最近执行和可用命令。';
const rows = [
  { id:'A-581', name:'晴雯', role:'UI/UX 设计师', avatar:'qingwen', card:'C-207', work:'W-628', title:'执行视图布局优化', task:'设计方案', state:'running', status:'运行中', detail:'本轮已运行 12 分钟', harness:'codex', model:'gpt-6', effort:'high', ratio:.6234, window:200000, run:'R-3095', minutes:1, active:true },
  { id:'A-582', name:'妙玉', role:'设计总监', avatar:'miaoyu', card:'C-205', work:'W-630', title:'紧凑任务信息与状态层级', task:'设计审核', state:'running', status:'运行中', detail:'本轮已运行 8 分钟', harness:'claude', model:'opus', effort:'high', ratio:.8, window:200000, run:'R-3094', minutes:2, active:true },
  { id:'A-583', name:'鲁智深', role:'开发工程师', avatar:'lu-zhishen', card:'C-204', work:'W-631', title:'编号标签与身份对齐组件', task:'组件开发', state:'running', status:'运行中', detail:'本轮已运行 24 分钟', harness:'codex', model:'gpt-6', effort:'high', ratio:.85, window:200000, run:'R-3093', minutes:3, active:true },
  { id:'A-584', name:'林冲', role:'代码审核', avatar:'lin-chong', card:'C-208', work:'W-632', title:'帮助文档与编号说明', task:'代码审核', state:'waiting', status:'排队中', detail:'前面还有 2 个', harness:'claude', model:'opus', effort:'—', ratio:null, run:'R-3092', minutes:4, active:true },
  { id:'A-585', name:'张良', role:'平台负责人', avatar:'zhang-liang', title:'项目沟通与需求整理', task:'常驻 PM 前台', state:'external', status:'外接身份', detail:'由对接 Agent 自行拉取', harness:'—', model:'—', effort:'—', ratio:null, minutes:5, active:true },
  { id:'A-586', name:'王熙凤', role:'项目经理（后台）', avatar:'wang-xifeng', title:'项目调度与交付跟进', task:'常驻 PM 后台', state:'idle', status:'空闲', detail:'等待下一次执行', harness:'claude', model:'opus', effort:'high', ratio:.4218, window:200000, run:'R-3090', minutes:8, active:true },
  { id:'A-587', name:'李逵', role:'开发工程师', avatar:'li-kui', card:'C-209', work:'W-633', title:'异常状态展示', task:'开发', state:'lost', status:'失联', detail:'运行环境无响应', harness:'codex', model:'gpt-6', effort:'high', ratio:null, run:'R-3089', minutes:18, active:false },
  { id:'A-588', name:'鲁肃', role:'验收测试', avatar:'lu-su', card:'C-210', work:'W-634', title:'组件验收', task:'测试', state:'released', status:'已释放', detail:'Assignment 已释放', harness:'claude', model:'opus', effort:'high', ratio:null, run:'R-3088', minutes:32, active:false },
];
let filter = 'working', descending = true, trigger, selected, limit = 6;
const percent = n => (n * 100).toFixed(2);
const idTag = (id, clickable=false) => id ? (clickable ? `<button class="id-link" data-open="${id}" aria-label="查看 ${id} 详情" aria-haspopup="dialog" aria-expanded="false"><span class="id id-${id[0].toLowerCase()}">${id}</span></button>` : `<span class="id id-${id[0].toLowerCase()}">${id}</span>`) : '';
const person = r => `<button class="person" data-person="${r.id}" aria-label="查看 ${r.name} 员工信息"><img src="../../../apps/web/public/avatars/v1/${r.avatar}/head-64.webp" alt=""><span class="person-copy"><strong>${r.name}</strong><small>${r.role}</small></span></button>`;
const stateIcon = r => ({running:'●',waiting:'◷',lost:'!',released:'○',external:'↗',idle:'○'})[r.state];
const state = r => `<span class="state state-${r.state}"><span aria-hidden="true">${stateIcon(r)}</span>${r.status}</span>`;
const task = r => `<div class="task"><div class="task-main">${r.card ? `<button class="id-link" data-card="${r.id}" aria-label="查看卡片 ${r.card}"><span class="id id-c">${r.card}</span></button>` : '<span class="muted">项目级</span>'}<span class="task-title">${r.title}</span></div><div class="task-meta">${idTag(r.work)}<span>${r.task}</span></div></div>`;
function context(r, interactive=true) {
  const tag = interactive ? 'button' : 'div';
  if (r.ratio === null) return `<${tag} class="context" ${interactive ? `data-context="${r.id}" aria-label="${r.name} 上下文未上报，查看说明"` : ''}><span class="context-head"><strong>—</strong><span>上下文</span></span><span class="sub">${r.state === 'external' ? '外接身份，暂无数据' : '尚未上报'}</span></${tag}>`;
  const level = r.ratio >= .85 ? 'critical' : r.ratio >= .8 ? 'warning' : 'normal';
  const label = level === 'critical' ? '↻ 换会话' : level === 'warning' ? '△ 提醒' : '用量正常';
  return `<${tag} class="context ${level}" ${interactive ? `data-context="${r.id}" aria-label="${r.name} 已用 ${percent(r.ratio)}%，剩余 ${percent(1-r.ratio)}%，${label}，查看详情"` : ''}><span class="context-head"><strong>${percent(r.ratio)}<small>%</small></strong><span>剩余 ${percent(1-r.ratio)}%</span></span><span class="meter" aria-hidden="true"><i style="width:${Math.min(100,r.ratio*100)}%"></i></span><span class="context-label">${label}<span class="muted">/ 200K</span></span></${tag}>`;
}
function config(r){return `<div class="config">${idTag(r.id,true)} <small>${r.state === 'released' ? '已释放' : '有效'}</small><span>${r.harness} / ${r.model}</span><span>effort ${r.effort}</span></div>`;}
function render(){
  const list = rows.filter(r=>filter==='all' || (filter==='working' ? r.active : r.state===filter)).sort((a,b)=>descending ? a.minutes-b.minutes : b.minutes-a.minutes);
  document.querySelector('#count').textContent=`显示 ${list.length} / ${rows.length} 个 Assignment`;
  document.querySelectorAll('[data-filter]').forEach(b=>b.setAttribute('aria-pressed', String(b.dataset.filter===filter)));
  document.querySelector('#mobile-sort').textContent=`最近活动 ${descending?'↓':'↑'}`;
  const headings = before ? ['员工','Assignment','卡片和工作项','运行状态','Harness','模型和 effort','上下文用量','最近 Run','最近活动'] : ['员工','正在做什么','运行状态','上下文用量','运行配置','最近活动'];
  const table = `<div class="table-wrap"><table><caption hidden>按最近活动排序的执行情况</caption>${before?'':'<colgroup><col style="width:168px"><col><col style="width:140px"><col style="width:196px"><col style="width:160px"><col style="width:108px"></colgroup>'}<thead><tr>${headings.map((h,i)=>`<th scope="col" ${i===headings.length-1?`aria-sort="${descending?'descending':'ascending'}"`:''}>${i===headings.length-1?`<button class="quiet" data-sort>${h} ${descending?'↓':'↑'}</button>`:h}</th>`).join('')}</tr></thead><tbody>${list.map(r=>`<tr data-row="${r.id}" class="${selected===r.id?'selected':''}">${before ? `<td>${person(r)}</td><td>${idTag(r.id,true)}<span class="sub">${r.role}</span></td><td>${idTag(r.card)} ${idTag(r.work)}${r.card?'':'常驻 PM（项目级）'}</td><td class="old-status"><span><small>运行　</small>${state(r)}</span><span><small>Assignment　有效</small></span></td><td>${r.harness}</td><td>${r.model} / ${r.effort}</td><td>${r.ratio===null?'—':Math.round(r.ratio*100)+'%（200K）'}</td><td>${idTag(r.run)}<span class="sub">${r.status}</span></td><td>${r.minutes} 分钟前</td>` : `<td>${person(r)}</td><td>${task(r)}</td><td>${state(r)}<span class="sub">${r.detail}</span></td><td>${context(r)}</td><td>${config(r)}</td><td class="activity">${r.minutes} 分钟前<span class="sub">${idTag(r.run)}</span></td>`}</tr>`).join('')}</tbody></table></div>`;
  const cards = `<div class="mobile-cards">${list.map(r=>`<article class="execution-card ${selected===r.id?'selected':''}" data-row="${r.id}" aria-label="${r.name} ${r.status}"><div class="card-person">${person(r)}${state(r)}</div>${task(r)}<div class="card-context">${context(r)}</div><div class="card-footer">${idTag(r.id,true)}<span class="activity">${r.minutes} 分钟前活跃</span></div><details class="card-config"><summary>运行配置与最近执行</summary><p>${r.harness} / ${r.model} / ${r.effort}<br>Assignment ${r.state === 'released' ? '已释放' : '有效'}<br>${r.detail}<br>最近执行 ${r.run||'尚无 Run'}</p></details></article>`).join('')}</div>`;
  document.querySelector('#assignments').innerHTML = list.length ? table+cards : '<div class="empty"><h2>没有符合条件的 Assignment</h2><p>可以切换筛选查看其他执行。</p><button data-filter="all">查看全部</button></div>';
  document.querySelectorAll('[data-open]').forEach(b=>b.setAttribute('aria-expanded',String(b.dataset.open===selected)));
}
function capacity(){
  const body=`<div class="capacity-body"><p class="capacity-intro">全项目共用。调低上限不会停止已运行的任务。</p><div class="machine"><div><strong>示例工作机 · Agent</strong><p class="machine-count">运行中 4 / 上限 <span id="limit-value">${limit}</span> / 排队 2</p></div><form id="limit-form" novalidate><label for="limit">上限</label><input id="limit" type="number" min="1" max="12" step="1" value="${limit}" aria-describedby="limit-hint save-feedback"><button type="submit" class="primary">保存</button><button type="button" id="cancel-limit">取消</button></form><p class="sub" id="limit-hint">可设 1–12；本机合并检查另占 2 个 Agent 名额。</p><p id="save-feedback" class="save-feedback" role="status"></p></div><div class="machine"><div><strong>示例检查机 · 合并检查</strong><p class="machine-count">运行中 1 / 上限 2 / 排队 0</p></div><span class="sub">需要主机预置，找平台负责人</span></div></div>`;
  if(before){document.querySelector('#old-capacity').innerHTML=`<section class="capacity"><h2>机器并发 <span class="muted">全项目共用</span></h2>${body}</section>`;}
  else document.querySelector('#capacity').innerHTML=`<details id="capacity-details"><summary><strong>机器并发</strong><span class="capacity-summary">Agent 运行中 4 / 上限 ${limit} / 排队 2 <span aria-hidden="true">　</span> 全项目共用</span><span class="edit-hint">查看与调整上限</span></summary>${body}</details>`;
  document.querySelector('#limit-form').addEventListener('submit',e=>{
    e.preventDefault();const input=document.querySelector('#limit'), feedback=document.querySelector('#save-feedback'), button=e.submitter;
    const n=Number(input.value);const valid=input.value.trim()!==''&&Number.isSafeInteger(n)&&n>0&&n<=12;
    input.setAttribute('aria-invalid',String(!valid));feedback.classList.toggle('error',!valid);
    if(!valid){feedback.textContent=n>12?'并发上限不能超过 12。':'并发上限必须为正整数。';input.focus();return;}
    button.disabled=true;input.disabled=true;button.textContent='保存中…';
    setTimeout(()=>{limit=n;document.querySelector('#limit-value').textContent=n;const summary=document.querySelector('.capacity-summary');if(summary)summary.textContent=`Agent 运行中 4 / 上限 ${n} / 排队 2　全项目共用`;feedback.textContent='已保存，下一轮调度生效。（原型演示）';button.disabled=false;input.disabled=false;button.textContent='保存';},350);
  });
  document.querySelector('#cancel-limit').addEventListener('click',()=>{document.querySelector('#limit').value=limit;document.querySelector('#limit').removeAttribute('aria-invalid');document.querySelector('#save-feedback').textContent='已取消修改。';});
  document.querySelector('#limit').addEventListener('input',()=>{document.querySelector('#save-feedback').textContent='';document.querySelector('#limit').removeAttribute('aria-invalid');});
}
const drawer=document.querySelector('#drawer');
function openDrawer(r, source, type='assignment'){
  trigger=source;selected=r.id;
  document.querySelector('#drawer-title').textContent=type==='person'?r.name:type==='card'?`${r.card} 卡片预览`:`${r.id} 运行详情`;
  const usage=r.ratio===null?'暂无上报值；不以 0% 代替，不估算用量。':`已用 ${Math.round(r.ratio*r.window).toLocaleString('en-US')} / ${r.window.toLocaleString('en-US')} tokens；原始比例 ${r.ratio}。显示保留两位小数，分档使用原始比例。`;
  const full=`${person(r)}<section><h3>当前工作</h3>${task(r)}<p>${state(r)}　${r.detail}</p></section><section><h3>上下文用量</h3><p>${context(r,false)}</p><p>${usage}</p><p class="muted">剩余 ≤ 20% 提醒；剩余 ≤ 15% 换会话。以主机的会话管理状态为准。</p><p class="muted">数据采样于 ${r.minutes} 分钟前；当前会话。${r.state==='external'?'外接身份没有可接入的终端。':''}</p></section><section><h3>运行配置</h3><dl><dt>Assignment</dt><dd>${r.id} · ${r.state==='released'?'已释放':'有效'}</dd><dt>Harness</dt><dd>${r.harness}</dd><dt>模型 / effort</dt><dd>${r.model} / ${r.effort}</dd><dt>最近执行</dt><dd>${r.run||'尚无 Run'}</dd><dt>运行环境</dt><dd>${r.state==='external'?'外接身份':'示例工作机'}</dd></dl></section><details><summary>终端、历史与签收记录</summary><p>沿用现有详情抽屉内容与只读终端入口；此原型不连接会话。</p></details>`;
  document.querySelector('#drawer-body').innerHTML=type==='person'?`${person(r)}<p class="muted">${r.role}</p><p>员工信息预览，当前 Assignment 为 ${r.id}。</p>`:type==='card'?`${task(r)}<p class="muted">原型中的卡片预览。正式界面沿用现有卡片跳转。</p>`:full;
  drawer.hidden=false;document.querySelector('#close-drawer').focus();
  document.querySelectorAll('[data-row]').forEach(el=>el.classList.toggle('selected',el.dataset.row===r.id));
  document.querySelectorAll('[data-open]').forEach(b=>b.setAttribute('aria-expanded',String(b.dataset.open===r.id)));
}
function closeDrawer(restore=true){drawer.hidden=true;selected=undefined;document.querySelectorAll('.selected').forEach(el=>el.classList.remove('selected'));document.querySelectorAll('[data-open]').forEach(b=>b.setAttribute('aria-expanded','false'));if(restore&&trigger?.isConnected)trigger.focus();}
document.addEventListener('click',e=>{
  const b=e.target.closest('[data-filter],[data-sort],[data-open],[data-person],[data-card],[data-context]');
  if(b){
    if(b.dataset.filter){filter=b.dataset.filter;closeDrawer(false);render();return;}
    if(b.hasAttribute('data-sort')){descending=!descending;closeDrawer(false);render();document.querySelector('[data-sort]')?.focus();return;}
    const id=b.dataset.open||b.dataset.person||b.dataset.card||b.dataset.context;const r=rows.find(r=>r.id===id);if(r)openDrawer(r,b,b.dataset.person?'person':b.dataset.card?'card':'assignment');return;
  }
  const row=e.target.closest('[data-row]');
  if(row&&!e.target.closest('button,a,input,summary,details')){const r=rows.find(r=>r.id===row.dataset.row);openDrawer(r,row.querySelector('[data-open]'));return;}
  if(!drawer.hidden&&!drawer.contains(e.target))closeDrawer(false);
});
document.querySelector('#close-drawer').onclick=()=>closeDrawer();
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!drawer.hidden)closeDrawer();});
document.querySelector('#mobile-sort').onclick=()=>{descending=!descending;closeDrawer(false);render();};
document.querySelector('#capacity-jump').onclick=()=>{const details=document.querySelector('#capacity-details');details.open=true;details.scrollIntoView({block:'start'});details.querySelector('summary').focus();};
document.querySelector('#theme').onclick=()=>{const current=document.documentElement.dataset.theme|| (matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');document.documentElement.dataset.theme=current==='dark'?'light':'dark';};
render();capacity();
