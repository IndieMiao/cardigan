// C-684: the cards page's 新建需求 entry, its dialog and the 人可开的卡片模板
// setting. Captures 1440 and 390 × light/dark: the page header, the story
// dialog with chosen files and a refused one, the template choice once dev is
// opened, a server refusal, the discard question, and the settings row and
// dialog. `--before` captures the base commit's empty-state dialog and the
// caution group instead. Measures control geometry and page overflow.
// CHROMIUM_PATH=<chrome> node apps/web/test-support/c684-capture.mjs <new output dir> [--before]
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "");
assert(process.argv[2], "Pass a new output directory");
const before = process.argv.includes("--before");
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c684-fixture",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c684")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c684",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c684-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
const cases = [];
let browser;
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium({
    args: [
      "--run-all-compositor-stages-before-draw",
      "--disable-gpu",
      "--force-color-profile=srgb",
    ],
  });
  const { send, evaluate } = browser;
  const version = (await send("Browser.getVersion")).product;
  const run = (fn, ...args) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const until = async (expression, ms = 20000) => {
    const end = Date.now() + ms;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(25);
    }
  };
  const settle = async () => {
    await run(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    await delay(200);
  };
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(resolve(output, name), Buffer.from(data, "base64"));
    return name;
  };
  const press = async (key, code, windowsVirtualKeyCode) => {
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key,
        code,
        windowsVirtualKeyCode,
      });
  };
  const open = async (hash, params = "") => {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c684${params}#${hash}`,
    });
    await evaluate("document.fonts.ready.then(() => true)");
  };
  const measure = () =>
    run(() => {
      const box = (e) => {
        if (!e) return null;
        const r = e.getBoundingClientRect();
        const s = getComputedStyle(e);
        return {
          text: e.textContent.trim().slice(0, 40),
          top: Math.round(r.top),
          left: Math.round(r.left),
          right: Math.round(r.right),
          width: Math.round(r.width),
          height: Math.round(r.height),
          font: `${s.fontSize}/${s.lineHeight}`,
        };
      };
      const button = (name) =>
        [...document.querySelectorAll("button")].find(
          (b) => b.textContent.trim() === name,
        );
      const dialog = document.querySelector("[role=dialog]");
      return {
        header: box(document.querySelector(".ui-page-header")),
        title: box(document.querySelector(".ui-page-header h1")),
        entry: box(button("新建需求") ?? button("新建卡片")),
        capacity: box(document.querySelector(".ui-page-capacity")),
        toolbar: box(document.querySelector(".ui-filter-row")),
        dialog: box(dialog),
        dialogTitle: box(dialog?.querySelector("h2")),
        fields: [
          ...(dialog?.querySelectorAll("input:not([type=file]), textarea") ??
            []),
        ]
          .filter((e) => e.type !== "hidden" && e.offsetParent)
          .map(box),
        labels: [...(dialog?.querySelectorAll("label") ?? [])]
          .filter((e) => e.offsetParent)
          .map((e) => e.firstChild?.textContent?.trim() ?? ""),
        buttons: [...(dialog?.querySelectorAll("button") ?? [])]
          .filter((e) => e.offsetParent)
          .map(box),
        chips: [...document.querySelectorAll(".ui-file-chip")].map(box),
        problems: [...document.querySelectorAll(".ui-file-problems li")].map(
          (e) => e.textContent,
        ),
        options: [...document.querySelectorAll("[role=option]")].map(
          (e) => e.textContent,
        ),
        checkboxes: [...document.querySelectorAll("[role=checkbox]")].map(
          (e) => ({ ...box(e), checked: e.getAttribute("aria-checked") }),
        ),
        alerts: [...document.querySelectorAll("[role=alert]")].map((e) =>
          e.textContent.trim(),
        ),
        row: box(
          [...document.querySelectorAll("[data-settings-row]")].find((e) =>
            e.textContent.includes("人可开的卡片模板"),
          ),
        ),
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
      };
    });
  const clickButton = (name) =>
    run((label) => {
      const found = [...document.querySelectorAll("button")].find(
        (b) => b.textContent.trim() === label,
      );
      found?.click();
      return !!found;
    }, name);
  const type = async (label, text) => {
    await run((name) => {
      const field = [...document.querySelectorAll("[role=dialog] label")]
        .find((l) => l.firstChild?.textContent?.trim() === name)
        ?.querySelector("input, textarea");
      field?.focus();
    }, label);
    await send("Input.insertText", { text });
  };
  const chooseFiles = () =>
    run(() => {
      const picker = document.querySelector('[role=dialog] input[type="file"]');
      const transfer = new DataTransfer();
      transfer.items.add(
        new File(["%PDF-1.4"], "需求草图说明.pdf", { type: "application/pdf" }),
      );
      transfer.items.add(
        new File(["png"], "导出页面.png", { type: "image/png" }),
      );
      transfer.items.add(
        new File(["zip"], "旧报表.zip", { type: "application/zip" }),
      );
      picker.files = transfer.files;
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
  for (const [width, theme] of [1440, 390].flatMap((w) =>
    ["light", "dark"].map((t) => [w, t]),
  )) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: width > 600 ? 1000 : 844,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: theme }],
    });
    const tag = `${width}-${theme}`;
    const result = { width, theme, shots: {} };
    cases.push(result);
    const scene = async (name) => {
      await settle();
      result[name] = await measure();
      result.shots[name] = await shot(`${name}-${tag}.png`);
    };

    // The page header, then the dialog with files (base: empty-state entry).
    await open("/p/p-1/cards?view=board", before ? "?empty" : "");
    await until(
      "[...document.querySelectorAll('button')].some(b => ['新建需求','新建卡片'].includes(b.textContent.trim()))",
    );
    result.scheme = await run(() => ({
      dark: matchMedia("(prefers-color-scheme: dark)").matches,
      background: getComputedStyle(document.body).backgroundColor,
    }));
    await scene("cards");
    if (!(await clickButton("新建需求"))) await clickButton("新建卡片");
    await until("!!document.querySelector('[role=dialog] input[name=title]')");
    await until("!document.querySelector('[role=dialog] fieldset')?.disabled");
    await scene("dialog-empty");
    if (!before) {
      await type("标题", "每周导出一次报表");
      await type("描述", "希望每周一早上能把上周的卡片进度导出成表格。");
      await chooseFiles();
      await until("document.querySelectorAll('.ui-file-chip').length === 2");
      await scene("dialog-story");
      // The discard question.
      await press("Escape", "Escape", 27);
      await until(
        "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '放弃修改')",
      );
      await scene("dialog-discard");
      await clickButton("继续编辑");
      await until(
        "![...document.querySelectorAll('button')].some(b => b.textContent.trim() === '放弃修改')",
      );
      // A server refusal stays in the dialog.
      await type("标题", "（失败示例）");
      await clickButton("创建");
      await until(
        "document.querySelectorAll('[role=dialog] [role=alert]').length > 0",
      );
      await scene("dialog-error");

      // The template choice once the owner opened dev.
      await open("/p/p-1/cards?view=board", "?open=dev");
      await until(
        "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '新建需求')",
      );
      await clickButton("新建需求");
      await until("!!document.querySelector('[role=dialog] [role=combobox]')");
      await run(() =>
        document.querySelector("[role=dialog] [role=combobox]").focus(),
      );
      await press("ArrowDown", "ArrowDown", 40);
      await until("document.querySelectorAll('[role=option]').length > 0");
      await scene("dialog-choice");
    }

    // The setting in the caution group, then its dialog.
    await open("/p/p-1/settings");
    await until(
      "[...document.querySelectorAll('h3, h2, [role=heading]')].some(h => h.textContent.includes('需谨慎'))",
    );
    await run(() => {
      const row =
        [...document.querySelectorAll("[data-settings-row]")].find((e) =>
          e.textContent.includes("人可开的卡片模板"),
        ) ??
        [...document.querySelectorAll("[data-settings-row]")].find((e) =>
          e.textContent.includes("跨卡只读"),
        );
      row?.scrollIntoView({ block: "center" });
    });
    await scene("settings");
    if (!before) {
      await run(() =>
        document.querySelector('[aria-label="编辑人可开的卡片模板"]').click(),
      );
      await until("document.querySelectorAll('[role=checkbox]').length > 0");
      await run(() =>
        [...document.querySelectorAll("[role=checkbox]")][1]?.click(),
      );
      await scene("settings-dialog");
    }
  }
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify({ browser: version, before, cases }, null, 2)}\n`,
  );
  for (const c of cases) {
    const label = `${c.width}/${c.theme}`;
    assert.equal(c.scheme.dark, c.theme === "dark", `${label}: scheme`);
    for (const [name, m] of Object.entries(c)) {
      if (!m || typeof m !== "object" || !("scrollWidth" in m)) continue;
      assert(m.scrollWidth <= m.innerWidth, `${label} ${name}: overflow`);
    }
    if (before) continue;
    assert.equal(c.cards.entry.height, 28, `${label}: entry 28px`);
    assert.equal(c["dialog-story"].chips.length, 2, `${label}: chips`);
    assert.equal(c["dialog-story"].problems.length, 1, `${label}: refused`);
    assert.deepEqual(
      c["dialog-choice"].options,
      ["需求卡", "开发卡"],
      `${label}: options`,
    );
    assert(c["dialog-error"].alerts.some((a) => a.includes("人只能开需求卡")));
  }
} finally {
  await browser?.close();
  await server.close();
}
