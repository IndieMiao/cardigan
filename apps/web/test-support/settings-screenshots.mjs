import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

// C-455 evidence: settings fixture only (no backend, live data or e2e suite).
// Usage: node settings-screenshots.mjs <output-dir> [--card-page | --panels | --feishu]
// C-479: --panels captures only the capacity, roles, templates and employee
// panels and their drawers (preferences/authorization are the default run).
const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "../../artifacts/settings");
const cardPage = process.argv.includes("--card-page");
const panels = process.argv.includes("--panels");
const feishu = process.argv.includes("--feishu");
await mkdir(output, { recursive: true });
const server = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "settings-screenshot-fixture",
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (!request.url?.startsWith("/__settings")) return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              "/__settings",
              `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/${cardPage ? "page-skeleton" : "settings"}-fixture.tsx"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
let browser;
const report = { scenes: {} };
try {
  await server.listen();
  // Same software raster path as the page skeleton visual baseline.
  browser = await chromium({
    args: [
      "--run-all-compositor-stages-before-draw",
      "--disable-new-content-rendering-timeout",
      "--disable-threaded-animation",
      "--disable-threaded-scrolling",
      "--disable-partial-raster",
      "--disable-gpu",
      "--disable-skia-runtime-opts",
      "--force-color-profile=srgb",
      "--num-raster-threads=1",
    ],
  });
  const { send, evaluate } = browser;
  report.browser = (await send("Browser.getVersion")).product;
  const run = (fn, ...args) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const until = async (expression) => {
    const deadline = Date.now() + 15000;
    while (!(await evaluate(expression))) {
      assert(Date.now() < deadline, `Timed out: ${expression}`);
      await delay(40);
    }
  };
  const settle = () =>
    run(async () => {
      await document.fonts.ready;
      window.scrollTo(0, 0);
      await new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      );
    });
  const measure = () =>
    run(() => {
      const box = (e) => {
        if (!e) return null;
        const r = e.getBoundingClientRect(),
          s = getComputedStyle(e);
        return {
          text: e.textContent.trim().slice(0, 24),
          x: Math.round(r.left * 10) / 10,
          y: Math.round(r.top * 10) / 10,
          w: Math.round(r.width * 10) / 10,
          h: Math.round(r.height * 10) / 10,
          font: `${s.fontSize}/${s.lineHeight} ${s.fontWeight}`,
        };
      };
      const q = (selector) => box(document.querySelector(selector));
      const content =
        document.querySelector("[data-settings-content]:not([hidden])") ??
        document.querySelector(".settings-layout section:not([hidden])") ??
        document.querySelector(".settings-layout > div > section");
      const limit = content
        ? content.getBoundingClientRect().right + 0.5
        : innerWidth;
      // Every visible descendant must stay inside the bounded content column.
      const overflowing = [...(content?.querySelectorAll("*") ?? [])]
        .filter((e) => {
          if (e.closest("[hidden]")) return false;
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.right > limit;
        })
        .slice(0, 8)
        .map(box);
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        pageTitle: q(".ui-page-header h1"),
        navItem: q("nav[aria-label='设置分栏'] button"),
        navCurrent: q("nav[aria-label='设置分栏'] [aria-current='page']"),
        panelTitle: box(content?.querySelector("h2")),
        groupTitle: box(content?.querySelector("h3")),
        rowLabel: box(
          content?.querySelector(
            "[data-settings-row] label, [data-settings-row] span[id]",
          ),
        ),
        rowDescription: box(content?.querySelector("[data-settings-row] p")),
        row: box(content?.querySelector("[data-settings-row]")),
        switch: box(content?.querySelector("[role='switch']")),
        input: box(content?.querySelector("input:not([type=checkbox])")),
        button: box(
          content?.querySelector(
            "[data-ui='button']:not([aria-label$='说明'])",
          ),
        ),
        help: box(content?.querySelector("[aria-label$='说明']")),
        statusTag: box(content?.querySelector("[data-ui='badge']")),
        groups: [
          ...(content?.querySelectorAll("[data-settings-group]") ?? []),
        ].map((g) => ({
          title: box(g.querySelector("h3")),
          toggle: box(g.querySelector("h3 button")),
          rows: box(g.querySelector(":scope > div:last-child")),
          firstRow: box(g.querySelector("[data-settings-row]")),
          value: box(g.querySelector("[data-settings-row] > div:last-child")),
        })),
        table: box(content?.querySelector("table")),
        tableHead: box(content?.querySelector("th")),
        tableCell: box(content?.querySelector("td")),
        avatar: box(content?.querySelector("td img")),
        content: box(content),
        overflowing,
      };
    });
  const capture = async (name, width, theme) => {
    await settle();
    const metrics = await measure();
    // The "before" run of the legacy panels records overflow instead of stopping.
    if (
      !panels ||
      !(await evaluate("!!document.querySelector('.settings-layout')"))
    )
      assert.equal(metrics.scrollWidth, width, `${name}: horizontal overflow`);
    report.scenes[`${name}-${width}-${theme}`] = metrics;
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 0, width, height: 1000, scale: 1 },
    });
    await writeFile(
      resolve(output, `${name}-${width}-${theme}.png`),
      Buffer.from(data, "base64"),
    );
    const { cssContentSize } = await send("Page.getLayoutMetrics");
    const full = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width,
        height: Math.ceil(cssContentSize.height),
        scale: 1,
      },
    });
    await writeFile(
      resolve(output, `${name}-${width}-${theme}-full.png`),
      Buffer.from(full.data, "base64"),
    );
  };
  const click = (text) =>
    run((text) => {
      const button = [
        ...document.querySelectorAll("nav[aria-label='设置分栏'] button"),
      ].find((item) => item.textContent.trim() === text);
      if (!button) throw new Error(`Missing tab: ${text}`);
      button.click();
    }, text);
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-color-scheme", value: theme },
          { name: "prefers-reduced-motion", value: "reduce" },
        ],
      });
      const open = async (hash, ready) => {
        await send("Page.navigate", { url: "about:blank" });
        await until("location.href === 'about:blank'");
        await send("Page.navigate", {
          url: `${server.resolvedUrls.local[0]}__settings${hash}`,
        });
        await until(ready);
        await run((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
      };
      if (feishu) {
        for (const [state, badge] of [
          ["disabled", "未启用"],
          ["connected", "未绑定"],
        ]) {
          await open(
            `?feishu=${state}#/p/p-1/settings?tab=feishu`,
            `[...document.querySelectorAll('[data-ui="badge"]')].some(el => el.textContent.trim() === '${badge}')`,
          );
          await capture(`feishu-${state}`, width, theme);
        }
        // C-563: the six groups with synthetic configuration; 高级 folded, then open.
        await open(
          "?feishu=connected&feishuConfig=1#/p/p-1/settings?tab=feishu",
          "!!document.querySelector('[data-settings-content]:not([hidden]) [aria-expanded=false]') && [...document.querySelectorAll('[data-ui=\"badge\"]')].some(el => el.textContent.trim() === '未绑定')",
        );
        await capture("feishu-config", width, theme);
        await run(() => {
          document
            .querySelector(
              "[data-settings-content]:not([hidden]) h3 button[aria-expanded=false]",
            )
            .click();
        });
        await until(
          "!!document.querySelector('[data-settings-content]:not([hidden]) h3 button[aria-expanded=true]')",
        );
        await capture("feishu-config-advanced", width, theme);
        continue;
      }
      if (cardPage) {
        await open(
          "#/p/p-1/cards?view=board",
          "!!document.querySelector('.board-card')",
        );
        await capture("cards", width, theme);
        continue;
      }
      await open(
        "#/p/p-1/settings",
        "!!document.querySelector('[role=switch], .settings-layout input[type=checkbox]')",
      );
      if (panels) {
        const drawer = async (name, trigger, end = false) => {
          await run((text) => {
            const target = [
              ...document.querySelectorAll("main button, main a"),
            ].find(
              (b) =>
                b.offsetParent &&
                (b.textContent.trim() === text ||
                  b.getAttribute("aria-label") === text),
            );
            if (!target) throw new Error(`Missing trigger: ${text}`);
            // Keyboard path: focus the opener, open it, later close with Escape.
            window.__settingsOpener = target;
            target.focus();
            target.click();
          }, trigger);
          await until(
            "!!document.querySelector('[role=dialog] form, [role=dialog] section, [role=dialog] dl')",
          );
          await delay(300);
          await settle();
          const shot = await send("Page.captureScreenshot", { format: "png" });
          report.scenes[`${name}-${width}-${theme}`] = await run(() => {
            const d = document.querySelector("[role=dialog]");
            const r = d.getBoundingClientRect();
            const font = (e) => {
              if (!e) return null;
              const s = getComputedStyle(e),
                b = e.getBoundingClientRect();
              return {
                text: e.textContent.trim().slice(0, 24),
                font: `${s.fontSize}/${s.lineHeight} ${s.fontWeight}`,
                h: Math.round(b.height * 10) / 10,
              };
            };
            // Real hit testing (C-479 review): the centre of every header
            // action and of the close button must reach that control, also
            // while a feedback toast (e.g. connecting to live updates) shows.
            const hits = [...d.querySelectorAll(".drawer-actions button")].map(
              (button) => {
                const b = button.getBoundingClientRect();
                const top = document.elementFromPoint(
                  b.left + b.width / 2,
                  b.top + b.height / 2,
                );
                return {
                  name:
                    button.getAttribute("aria-label") ??
                    button.textContent.trim(),
                  hit: !!top && button.contains(top),
                  topmost: top?.closest(".request-feedback")
                    ? "request-feedback"
                    : top?.tagName,
                };
              },
            );
            const toasts = [...document.querySelectorAll(".request-feedback")]
              .filter((t) => t.textContent.trim())
              .map((t) => {
                const b = t.getBoundingClientRect();
                return {
                  text: t.textContent.trim(),
                  y: Math.round(b.top),
                  bottom: Math.round(b.bottom),
                };
              });
            return {
              hits,
              toasts,
              drawer: { x: r.left, y: r.top, w: r.width, h: r.height },
              drawerScrollWidth: d.scrollWidth,
              drawerClientWidth: d.clientWidth,
              title: font(d.querySelector("h2")),
              section: font(d.querySelector("section h3")),
              fact: font(d.querySelector("dt")),
              input: font(d.querySelector("input")),
              button: font(d.querySelector("form [data-ui='button']")),
              scrollWidth: document.documentElement.scrollWidth,
            };
          });
          await writeFile(
            resolve(output, `${name}-${width}-${theme}.png`),
            Buffer.from(shot.data, "base64"),
          );
          if (end) {
            // C-512: a long read-only drawer; its last section, scrolled in.
            await run(() => {
              const d = document.querySelector("[role=dialog]");
              const sections = d.querySelectorAll("section");
              sections[sections.length - 1]?.scrollIntoView({ block: "end" });
            });
            await settle();
            const bottom = await send("Page.captureScreenshot", {
              format: "png",
            });
            await writeFile(
              resolve(output, `${name}-end-${width}-${theme}.png`),
              Buffer.from(bottom.data, "base64"),
            );
          }
          for (const hit of report.scenes[`${name}-${width}-${theme}`].hits)
            assert(
              hit.hit,
              `${name}-${width}-${theme}: ${hit.name} is covered by ${hit.topmost}`,
            );
          // A real Escape key press closes it; focus must return to the opener.
          for (const type of ["keyDown", "keyUp"])
            await send("Input.dispatchKeyEvent", {
              type,
              key: "Escape",
              code: "Escape",
              windowsVirtualKeyCode: 27,
            });
          await until("!document.querySelector('[role=dialog]')");
          await delay(100);
          const returned = await evaluate(
            "document.activeElement === window.__settingsOpener",
          );
          report.scenes[`${name}-${width}-${theme}`].focusReturned = returned;
          assert(
            returned,
            `${name}-${width}-${theme}: focus not returned to ${trigger}`,
          );
        };
        // Mouse users see no focus ring on the panel focused after a nav
        // click; the scripted click has no pointer, so drop the focus.
        const blur = () =>
          run(
            () =>
              new Promise((done) =>
                requestAnimationFrame(() => {
                  document.activeElement?.blur?.();
                  done();
                }),
              ),
          );
        const isNew = await evaluate(
          "!document.querySelector('.settings-layout')",
        );
        await click("并发与容量");
        // C-511: the old entry now lands on the machine page.
        await until(
          "[...document.querySelectorAll('h2')].some((h) => (h.textContent.includes('并发与容量') || h.textContent.trim() === '机器') && h.offsetParent) && document.body.textContent.includes('本机')",
        );
        await blur();
        await capture("capacity", width, theme);
        await click("角色");
        await until("document.body.textContent.includes('文档写手')");
        await blur();
        await capture("roles", width, theme);
        if (isNew) await drawer("role-drawer", "开发工程师");
        await click("卡片模板");
        await until("document.body.textContent.includes('调研卡')");
        await capture("templates", width, theme);
        if (isNew) await drawer("template-drawer", "dev");
        await click("员工");
        await until("document.body.textContent.includes('孙悟空')");
        await capture("employees", width, theme);
        if (isNew) await drawer("employee-drawer", "选用孙悟空");
        // C-512: the read-only machine panel (absent before C-512).
        const machines = await evaluate(
          "[...document.querySelectorAll(\"nav[aria-label='设置分栏'] button\")].some((b) => b.textContent.trim() === '机器')",
        );
        if (machines) {
          await click("机器");
          await until(
            "!!document.querySelector('table[aria-label=\"机器列表\"]') && document.body.textContent.includes('Mac mini')",
          );
          await blur();
          await capture("machines", width, theme);
          await drawer("machine-drawer", "本机", true);
          await drawer("machine-failed-drawer", "构建机", true);
          // C-512 (V-2396): a failed detail read keeps 重试 in the drawer
          // body; the page stack (e.g. 正在连接实时更新…) must not cover it.
          await run(() => {
            const target = [...document.querySelectorAll("main button")].find(
              (b) => b.offsetParent && b.textContent.trim() === "Mac mini",
            );
            window.__settingsOpener = target;
            target.focus();
            target.click();
          });
          await until(
            "[...document.querySelectorAll('[role=dialog] button')].some((b) => b.textContent.trim() === '重试')",
          );
          await delay(300);
          await settle();
          const failedShot = await send("Page.captureScreenshot", {
            format: "png",
          });
          const retryScene = `machine-detail-error-${width}-${theme}`;
          report.scenes[retryScene] = await run(() => {
            const button = [
              ...document.querySelectorAll("[role=dialog] button"),
            ].find((b) => b.textContent.trim() === "重试");
            const b = button.getBoundingClientRect();
            const top = document.elementFromPoint(
              b.left + b.width / 2,
              b.top + b.height / 2,
            );
            const alert = button.closest("[role=alert]");
            return {
              retry: { x: b.left, y: b.top, w: b.width, h: b.height },
              hit: !!top && button.contains(top),
              topmost: top?.textContent?.trim().slice(0, 24),
              text: alert?.textContent,
              scrollWidth: document.documentElement.scrollWidth,
            };
          });
          await writeFile(
            resolve(output, `${retryScene}.png`),
            Buffer.from(failedShot.data, "base64"),
          );
          assert(
            report.scenes[retryScene].hit,
            `${retryScene}: 重试 is covered by ${report.scenes[retryScene].topmost}`,
          );
          // A real pointer click on the uncovered button reads again.
          const r = report.scenes[retryScene].retry;
          for (const type of ["mousePressed", "mouseReleased"])
            await send("Input.dispatchMouseEvent", {
              type,
              x: r.x + r.w / 2,
              y: r.y + r.h / 2,
              button: "left",
              clickCount: 1,
            });
          await until("!!document.querySelector('[role=dialog] dl')");
          const pressEscape = async () => {
            for (const type of ["keyDown", "keyUp"])
              await send("Input.dispatchKeyEvent", {
                type,
                key: "Escape",
                code: "Escape",
                windowsVirtualKeyCode: 27,
              });
            await until("!document.querySelector('[role=dialog]')");
          };
          await pressEscape();
          // C-511: machine actions and the add-worker wizard (absent before).
          const wizard = await evaluate(
            "[...document.querySelectorAll('main button')].some((b) => b.offsetParent && b.textContent.trim() === '添加 worker')",
          );
          if (wizard) {
            const press = (text) =>
              run((text) => {
                const target = [
                  ...document.querySelectorAll(
                    "[role=dialog] button, main button",
                  ),
                ].find(
                  (b) =>
                    b.offsetParent &&
                    (b.textContent.trim() === text ||
                      b.getAttribute("aria-label") === text),
                );
                if (!target) throw new Error(`Missing button: ${text}`);
                target.click();
              }, text);
            const has = (text) =>
              `[...document.querySelectorAll('[role=dialog] button, [role=dialog] table')].some((b) => b.offsetParent && (b.textContent.trim() === ${JSON.stringify(text)} || b.getAttribute('aria-label') === ${JSON.stringify(text)}))`;
            /** The open drawer as seen, scrolled to `section` when given. */
            const scene = async (name, section) => {
              await run((section) => {
                const d = document.querySelector("[role=dialog]");
                const target =
                  section === "@top"
                    ? d.querySelector("[data-feedback-host]")
                    : section
                      ? [...d.querySelectorAll("h3, table, label")].find(
                          (e) =>
                            (e.tagName === "LABEL"
                              ? e.firstChild?.textContent?.trim()
                              : e.textContent.trim()) === section ||
                            e.getAttribute("aria-label") === section,
                        )
                      : undefined;
                if (section && !target)
                  throw new Error(`Missing section: ${section}`);
                if (target) target.scrollIntoView({ block: "start" });
                else
                  d.querySelector(".drawer-body, [data-ui]")?.scrollTo?.(0, 0);
              }, section ?? null);
              await delay(150);
              await run(async () => {
                await document.fonts.ready;
                await new Promise((done) =>
                  requestAnimationFrame(() => requestAnimationFrame(done)),
                );
              });
              const shot = await send("Page.captureScreenshot", {
                format: "png",
              });
              report.scenes[`${name}-${width}-${theme}`] = await run(() => {
                const d = document.querySelector("[role=dialog]");
                const r = d.getBoundingClientRect();
                const box = (e) => {
                  if (!e) return null;
                  const b = e.getBoundingClientRect(),
                    st = getComputedStyle(e);
                  return {
                    text: e.textContent.trim().slice(0, 24),
                    x: Math.round(b.left * 10) / 10,
                    y: Math.round(b.top * 10) / 10,
                    w: Math.round(b.width * 10) / 10,
                    h: Math.round(b.height * 10) / 10,
                    font: `${st.fontSize}/${st.lineHeight} ${st.fontWeight}`,
                  };
                };
                const hits = [
                  ...d.querySelectorAll(".drawer-actions button"),
                ].map((button) => {
                  const b = button.getBoundingClientRect();
                  const top = document.elementFromPoint(
                    b.left + b.width / 2,
                    b.top + b.height / 2,
                  );
                  return {
                    name:
                      button.getAttribute("aria-label") ??
                      button.textContent.trim(),
                    h: Math.round(b.height * 10) / 10,
                    hit: !!top && button.contains(top),
                  };
                });
                // Nothing inside the drawer may stick out of it sideways.
                const outside = [...d.querySelectorAll("*")]
                  .filter((e) => {
                    const b = e.getBoundingClientRect();
                    return (
                      b.width > 0 &&
                      !e.closest("pre") &&
                      (b.right > r.right + 0.5 || b.left < r.left - 0.5)
                    );
                  })
                  .slice(0, 5)
                  .map(box);
                return {
                  drawer: { x: r.left, y: r.top, w: r.width, h: r.height },
                  drawerScrollWidth: d.scrollWidth,
                  drawerClientWidth: d.clientWidth,
                  scrollWidth: document.documentElement.scrollWidth,
                  hits,
                  title: box(d.querySelector("h2")),
                  section: box(d.querySelector("section h3")),
                  fact: box(d.querySelector("dt")),
                  input: box(d.querySelector("input")),
                  button: box(d.querySelector("form [data-ui='button']")),
                  tableHead: box(d.querySelector("th")),
                  tableCell: box(d.querySelector("td")),
                  statusTag: box(d.querySelector("td [data-ui='badge']")),
                  longText: box(d.querySelector("pre")),
                  // C-565: the step bar, its current step and a field hint.
                  steps: box(d.querySelector("ol[aria-label]")),
                  stepCurrent: box(d.querySelector("[aria-current='step']")),
                  stepMarker: box(
                    d.querySelector("[aria-current='step'] > span"),
                  ),
                  fieldHint: box(
                    document.getElementById(
                      d
                        .querySelector("input[aria-describedby]")
                        ?.getAttribute("aria-describedby")
                        ?.split(" ")[0] ?? "",
                    ),
                  ),
                  inputValues: [...d.querySelectorAll("form input")]
                    .filter((i) => i.type !== "hidden" && !i.hidden)
                    .map((i) => i.value),
                  outside,
                };
              });
              await writeFile(
                resolve(output, `${name}-${width}-${theme}.png`),
                Buffer.from(shot.data, "base64"),
              );
              for (const hit of report.scenes[`${name}-${width}-${theme}`].hits)
                assert(
                  hit.hit,
                  `${name}-${width}-${theme}: ${hit.name} covered`,
                );
            };
            // 立即检查 in progress (the synthetic check stays at SSH).
            await run(() => {
              const target = [...document.querySelectorAll("main button")].find(
                (b) => b.offsetParent && b.textContent.trim() === "本机",
              );
              target.click();
            });
            await until(has("立即检查"));
            await press("立即检查");
            await until(
              "document.querySelector('[role=dialog]').textContent.includes('正在检查：SSH…')",
            );
            await scene("machine-check-running");
            await pressEscape();
            // The wizard: form, preview, a failed step, then remote launch.
            await press("添加 worker");
            await until("!!document.querySelector('[role=dialog] form')");
            // C-565: the first screen, prefilled (port, account, MCP).
            await until(
              "[...document.querySelectorAll('[role=dialog] input')].some((i) => i.value.endsWith('/mcp'))",
            );
            await scene("wizard-start");
            await run(() => {
              const values = {
                机器编号: "studio",
                名称: "工作室",
                主机地址: "worker.invalid",
                专用账号: "cg_studio",
                UID: "1501",
                GID: "1501",
                "MCP 地址": "https://control.example.ts.net/mcp",
              };
              const set = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                "value",
              ).set;
              for (const label of document.querySelectorAll(
                "[role=dialog] label",
              )) {
                const name = label.firstChild?.textContent?.trim();
                const input = label.querySelector("input");
                if (!input || !(name in values)) continue;
                set.call(input, values[name]);
                input.dispatchEvent(new Event("input", { bubbles: true }));
              }
              document.activeElement?.blur?.();
            });
            await scene("wizard-form");
            await scene("wizard-form-ids", "UID");
            await press("预览配置");
            await until(has("工作室 配置差异"));
            await scene("wizard-preview");
            await press("确认写入配置");
            await until(has("开始检查"));
            await press("开始检查");
            await until(has("继续检查"));
            await scene("wizard-failed");
            await scene("wizard-commands", "目标机命令");
            await press("继续检查");
            // C-565: a stop the commands fix; the page will check again.
            await until(
              "document.querySelector('[role=dialog]').textContent.includes('会自动复查')",
            );
            await scene("wizard-recheck", "@top");
            await press("继续检查");
            await until(has("复查"));
            await press("预览开启");
            await until(has("派发配置差异"));
            await run(() =>
              document.querySelector("[role=dialog] [role=checkbox]").click(),
            );
            await scene("wizard-launch", "需谨慎");
            await press("开启远程派发");
            await until(
              "document.querySelector('[role=dialog]').textContent.includes('已开启远程派发')",
            );
            await press("完成");
            await until("!document.querySelector('[role=dialog]')");
          }
        }
        continue;
      }
      await capture("preferences", width, theme);
      await click("授权");
      await until(
        "[...document.querySelectorAll('h2')].some((h) => h.textContent.includes('授权') && h.offsetParent)",
      );
      await capture("authorization", width, theme);
      if (
        await evaluate("!!document.querySelector('[data-settings-content]')")
      ) {
        // Interaction states: a dirty number field and the reminder dialog.
        await click("偏好");
        await run(() => {
          const input = document.querySelector(
            "input[aria-label='PM 合并确认停留告警（分钟）']",
          );
          const set = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          ).set;
          set.call(input, "90");
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.scrollIntoView({ block: "center" });
        });
        await until(
          "[...document.querySelectorAll('[data-dirty]')].length > 0",
        );
        await settle();
        await run(() =>
          document
            .querySelector("input[aria-label='PM 合并确认停留告警（分钟）']")
            .scrollIntoView({ block: "center" }),
        );
        // Scrolled states: capture the visible viewport, not document y=0.
        const { data } = await send("Page.captureScreenshot", {
          format: "png",
        });
        await writeFile(
          resolve(output, `dirty-${width}-${theme}.png`),
          Buffer.from(data, "base64"),
        );
        await run(() =>
          document.querySelector("button[aria-label='编辑催办阈值']").click(),
        );
        await until("!!document.querySelector('[role=dialog]')");
        await run(() =>
          document
            .querySelector("[role=dialog] [role=switch]")
            .dispatchEvent(new MouseEvent("click", { bubbles: true })),
        );
        await until("!!document.querySelector('[role=dialog] input')");
        await delay(100);
        const dialog = await send("Page.captureScreenshot", {
          format: "png",
        });
        report.scenes[`dialog-${width}-${theme}`] = await run(() => {
          const d = document
            .querySelector("[role=dialog]")
            .getBoundingClientRect();
          return {
            dialog: { x: d.left, y: d.top, w: d.width, h: d.height },
            scrollWidth: document.documentElement.scrollWidth,
          };
        });
        await writeFile(
          resolve(output, `dialog-${width}-${theme}.png`),
          Buffer.from(dialog.data, "base64"),
        );
        // C-455 (Q-932): a newer read while the threshold dialog is open
        // replaces its draft and says so. The policy changes elsewhere; saving
        // another setting behind the dialog reads the preferences again.
        const reminders = `[...document.querySelectorAll("[role=switch]")].find((s) => document.getElementById(s.getAttribute("aria-labelledby"))?.textContent === "催办提醒").click()`;
        await run(() =>
          window.settingsFixtureUpdate({
            system_reminder_policy: {
              min_minutes: 5,
              max_minutes: 240,
              min_count: 1,
              max_count: 4,
              unassigned_ready_after_minutes: 30,
              pre_merge_check_pending_after_minutes: 20,
              repeat: false,
              repeat_interval_minutes: null,
              max_reminders: 1,
            },
          }),
        );
        await evaluate(reminders);
        await until(
          "[...document.querySelectorAll('[role=status]')].some((a) => a.textContent.includes('催办阈值已更新为最新值'))",
        );
        await settle();
        const updated = await send("Page.captureScreenshot", {
          format: "png",
        });
        report.scenes[`policy-updated-${width}-${theme}`] = await run(() => {
          const notice = [...document.querySelectorAll("[role=status]")].find(
            (a) => a.textContent.includes("催办阈值已更新为最新值"),
          );
          const r = notice.getBoundingClientRect();
          return {
            notice: { x: r.left, y: r.top, w: r.width, h: r.height },
            draftMaxMinutes: [
              ...document.querySelectorAll("[role=dialog] label"),
            ]
              .find((l) => l.textContent.startsWith("允许的最多分钟数"))
              ?.querySelector("input")?.value,
            scrollWidth: document.documentElement.scrollWidth,
          };
        });
        await writeFile(
          resolve(output, `policy-updated-${width}-${theme}.png`),
          Buffer.from(updated.data, "base64"),
        );
        // Back to the earlier state: no policy, reminders off, configuring.
        await run(() =>
          window.settingsFixtureUpdate({ system_reminder_policy: null }),
        );
        await evaluate(reminders);
        await until(
          "document.querySelector('[role=dialog] [role=switch]')?.getAttribute('aria-checked') === 'false'",
        );
        await run(() =>
          document
            .querySelector("[role=dialog] [role=switch]")
            .dispatchEvent(new MouseEvent("click", { bubbles: true })),
        );
        await until("!!document.querySelector('[role=dialog] input')");
        // Let the reminder switch notices expire so later scenes match.
        await until(
          "![...document.querySelectorAll('[role=status]')].some((a) => a.textContent.includes('催办提醒'))",
        );
        // A failed threshold save stays in the feedback stack once closed.
        await run(() => {
          const input = [...document.querySelectorAll("[role=dialog] label")]
            .find((l) => l.textContent.startsWith("允许的最少分钟数"))
            .querySelector("input");
          Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          ).set.call(input, "999");
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.form.requestSubmit();
        });
        await until("!!document.querySelector('[role=dialog] [role=alert]')");
        await run(() =>
          [...document.querySelectorAll("[role=dialog] button")]
            .find((b) => b.textContent === "取消")
            .click(),
        );
        await until("!document.querySelector('[role=dialog]')");
        await run(() =>
          document
            .querySelector("button[aria-label='编辑催办阈值']")
            .scrollIntoView({ block: "center" }),
        );
        await delay(100);
        const failed = await send("Page.captureScreenshot", { format: "png" });
        report.scenes[`policy-error-${width}-${theme}`] = await run(() => {
          const alert = [...document.querySelectorAll("[role=alert]")].find(
            (a) => a.textContent.includes("合成失败"),
          );
          const r = alert?.getBoundingClientRect();
          const s = alert && getComputedStyle(alert);
          return {
            alert: r && {
              x: r.left,
              y: r.top,
              w: r.width,
              h: r.height,
              fontSize: s.fontSize,
              lineHeight: s.lineHeight,
            },
            scrollWidth: document.documentElement.scrollWidth,
          };
        });
        await writeFile(
          resolve(output, `policy-error-${width}-${theme}.png`),
          Buffer.from(failed.data, "base64"),
        );
        // C-455#326: leave while a save is in flight (1438 fails slowly in
        // the fixture); the failure is reported once on the next page. Wait
        // first so the threshold failure above counts as seen.
        await delay(700);
        await run(() => {
          window.scrollTo(0, 0);
          const input = document.querySelector("input[id$='-minutes']");
          Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          ).set.call(input, "1438");
          input.dispatchEvent(new Event("input", { bubbles: true }));
          [...document.querySelectorAll("[role=switch]")]
            .find(
              (s) =>
                document.getElementById(s.getAttribute("aria-labelledby"))
                  ?.textContent === "超时自动合并",
            )
            .click();
        });
        await delay(100);
        await run(() => {
          window.location.hash = "#/p/p-1/help";
        });
        await until(
          "[...document.querySelectorAll('[role=alert]')].some((a) => a.textContent.includes('超时自动合并”，请回到设置重试'))",
        );
        await settle();
        const left = await send("Page.captureScreenshot", { format: "png" });
        report.scenes[`leave-notice-${width}-${theme}`] = await run(() => {
          const alert = [...document.querySelectorAll("[role=alert]")].find(
            (a) => a.textContent.includes("超时自动合并”，请回到设置重试"),
          );
          const r = alert.getBoundingClientRect();
          const s = getComputedStyle(alert);
          return {
            text: alert.textContent,
            stack: [...document.querySelectorAll("[role=alert]")].map(
              (a) => a.textContent,
            ),
            alert: {
              x: r.left,
              y: r.top,
              w: r.width,
              h: r.height,
              fontSize: s.fontSize,
              lineHeight: s.lineHeight,
            },
            hash: location.hash,
            scrollWidth: document.documentElement.scrollWidth,
          };
        });
        await writeFile(
          resolve(output, `leave-notice-${width}-${theme}.png`),
          Buffer.from(left.data, "base64"),
        );
      }
    }
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
} finally {
  await browser?.close();
  await server.close();
}
