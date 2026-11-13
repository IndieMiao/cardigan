import { createRoot } from "react-dom/client";
import { StatusTag, IdTag } from "../../src/components/Foundation.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../../src/styles.css";
import "./palette.css";
import "./swatches.css";
import palette from "./palette.json";
document.documentElement.dataset.c208 = "after";
const statuses = [
  "passed",
  "failed",
  "running",
  "blocked",
  "snoozed",
  "review",
  "todo",
  "idle",
];
function Sheet() {
  return (
    <main className="swatch-sheet">
      <h1>C-208 中性深灰 × C-204 编号标签</h1>
      <p className="hint">晴雯 · 设计候选 v1 · 示例数据</p>
      <div className="swatch-levels">
        {["--bg", "--surface", "--surface-muted"].map((key, i) => (
          <section className={`swatch-level level-${i}`} key={key}>
            <h2>
              {["页面底色", "侧栏 / 卡片 / 输入框", "次级 / 选中 / 时间线"][i]}
            </h2>
            <code>
              {key} {palette.after[key]}
            </code>
            <p>正文清晰，次要文字保持足够对比。</p>
            <p className="hint">次要文字 #b8b8b8</p>
            <div className="swatch-items">
              {statuses.map((status) => (
                <StatusTag key={status} status={status} />
              ))}
            </div>
            <div className="swatch-items">
              {palette.labels.map(([kind, id]) => (
                <span key={kind} data-demo-kind={kind}>
                  <IdTag id={id} label={kind} />
                </span>
              ))}
            </div>
          </section>
        ))}
      </div>
      <section className="swatch-controls">
        <h2>交互与强调</h2>
        <div className="swatch-items">
          <button type="button">确认方案</button>
          <button type="button" className="quiet">
            暂缓
          </button>
          <a href="#controls">查看设计说明</a>
          <label>
            筛选 <input placeholder="输入编号" />
          </label>
        </div>
        <p className="hint">
          键盘焦点沿用品牌色轮廓。状态保留形状与中文名称；编号始终保留类型前缀。
        </p>
      </section>
      <p>中性色均为 R=G=B。彩色仅出现在状态、强调、身份及小面积编号标签中。</p>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Sheet />);
new MutationObserver(() =>
  document
    .querySelectorAll<HTMLElement>("[data-demo-kind] .id-tag")
    .forEach((el) => (el.dataset.idKind = el.parentElement!.dataset.demoKind)),
).observe(document.getElementById("root")!, { childList: true, subtree: true });
