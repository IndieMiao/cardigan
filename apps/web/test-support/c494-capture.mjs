import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

// C-494 evidence: role import / export / template hookup, launch profile
// picker, Markdown preview and employee role change, on the synthetic
// c494-fixture (C-479 panels data + canned previews; no backend or live data).
// The same script runs on the base commit for "before" pictures: scenes whose
// controls do not exist there are recorded as missing instead of failing.
// Usage: node c494-capture.mjs <output-dir>
const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "../../artifacts/c494");
await mkdir(output, { recursive: true });
const entry = (name) =>
  `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/${name}.tsx"></script></body></html>`;
const server = await createServer({
  root,
  // The "before" checkout borrows this worktree's node_modules by symlink;
  // let the local-only server read the fonts through it.
  server: { host: "127.0.0.1", port: 0, fs: { strict: false } },
  plugins: [
    {
      name: "c494-fixture",
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const page = request.url?.startsWith("/__c494")
            ? "c494-fixture"
            : request.url?.startsWith("/__cards")
              ? "page-skeleton-fixture"
              : undefined;
          if (!page) return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(request.url, entry(page)),
          );
        });
      },
    },
  ],
});
let browser;
const report = { scenes: {}, missing: [], beforeUnloadPrompts: [] };
try {
  await server.listen();
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
  const until = async (expression, ms = 15000) => {
    const deadline = Date.now() + ms;
    while (!(await evaluate(expression))) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${expression}`);
      await delay(40);
    }
  };
  const settle = () =>
    run(async () => {
      await document.fonts.ready;
      await new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      );
    });
  const key = async (name, code = name, keyCode = 0) => {
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key: name,
        code,
        windowsVirtualKeyCode: keyCode,
      });
  };
  /** Click the visible button (in a dialog when one is open) with this name. */
  const press = (name) =>
    run((name) => {
      const scope = [...document.querySelectorAll("[role=dialog]")].at(-1);
      const target = [
        ...(scope ?? document).querySelectorAll("button, [role=button]"),
      ].find(
        (b) =>
          b.offsetParent &&
          (b.textContent.trim() === name ||
            b.getAttribute("aria-label") === name),
      );
      if (!target) throw new Error(`Missing button: ${name}`);
      target.focus();
      target.click();
    }, name);
  const type = (label, value) =>
    run(
      (label, value) => {
        const scope = [...document.querySelectorAll("[role=dialog]")].at(-1);
        const field =
          [...scope.querySelectorAll("label")]
            .find((l) => l.textContent.trim().startsWith(label))
            ?.querySelector("input, textarea") ??
          scope.querySelector(`textarea[aria-label^="${label}"]`);
        if (!field) throw new Error(`Missing field: ${label}`);
        const proto =
          field.tagName === "TEXTAREA"
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      },
      label,
      value,
    );
  /** Open a Radix select by its label and pick the option whose text starts so. */
  const choose = async (label, option) => {
    await run((label) => {
      const scope = [...document.querySelectorAll("[role=dialog]")].at(-1);
      const trigger = [...scope.querySelectorAll("label")]
        .find((l) => l.textContent.trim().startsWith(label))
        ?.querySelector("[role=combobox]");
      if (!trigger) throw new Error(`Missing select: ${label}`);
      trigger.focus();
    }, label);
    await key("ArrowDown", "ArrowDown", 40);
    await until("!!document.querySelector('[role=option]')");
    await run((option) => {
      const item = [...document.querySelectorAll("[role=option]")].find((o) =>
        o.textContent.trim().startsWith(option),
      );
      if (!item) throw new Error(`Missing option: ${option}`);
      item.focus();
    }, option);
    await key("Enter", "Enter", 13);
    await until("!document.querySelector('[role=option]')");
  };
  // A drawer left with unapplied edits asks through the browser before the
  // page unloads; accept it and record it as evidence.
  const leave = async (label) => {
    let left = false;
    const leaving = send("Page.navigate", { url: "about:blank" }).finally(
      () => {
        left = true;
      },
    );
    for (let i = 0; i < 25 && !left; i++) {
      await delay(80);
      await send("Page.handleJavaScriptDialog", { accept: true }).then(
        () => report.beforeUnloadPrompts.push(label),
        () => undefined,
      );
    }
    await leaving;
    await until("location.href === 'about:blank'");
  };
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
      const dialog = [...document.querySelectorAll("[role=dialog]")].at(-1);
      const panel = document.querySelector(
        "[data-settings-content]:not([hidden])",
      );
      const content = dialog ?? panel;
      const limit = content
        ? content.getBoundingClientRect().right + 0.5
        : innerWidth;
      const overflowing = [...(content?.querySelectorAll("*") ?? [])]
        .filter((e) => {
          if (e.closest("[hidden]")) return false;
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.right > limit;
        })
        .slice(0, 8)
        .map(box);
      const hits = [
        ...(dialog?.querySelectorAll(".drawer-actions button") ?? []),
      ].map((button) => {
        const b = button.getBoundingClientRect();
        const top = document.elementFromPoint(
          b.left + b.width / 2,
          b.top + b.height / 2,
        );
        return {
          name: button.getAttribute("aria-label") ?? button.textContent.trim(),
          hit: !!top && button.contains(top),
          h: Math.round(b.height * 10) / 10,
        };
      });
      const q = (selector) => box(content?.querySelector(selector));
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        content: box(content),
        panelTitle: box(panel?.querySelector("h2")),
        panelActions: [
          ...(panel?.querySelectorAll("h2 ~ div button") ?? []),
        ].map(box),
        drawerTitle: box(dialog?.querySelector("h2")),
        sectionTitle: q("section h3"),
        tableHead: q("th"),
        tableCell: q("td"),
        fact: q("dt"),
        label: q("label"),
        input: q("input:not([type=file])"),
        select: q("[role=combobox]"),
        textarea: q("textarea"),
        markdown: q(".markdown"),
        warning: q("[role=alert], [role=note]"),
        toggle: q("[data-ui=toggle-group] button"),
        primary: box(
          [...(content?.querySelectorAll("button") ?? [])].find((b) =>
            b.className.includes("primary"),
          ),
        ),
        avatar: q("td img"),
        hits,
        overflowing,
      };
    });
  const shoot = async (name, width, theme) => {
    await delay(150);
    await settle();
    const metrics = await measure();
    assert.equal(metrics.scrollWidth, width, `${name}: horizontal overflow`);
    // An open menu or confirmation makes the drawer inert on purpose.
    if (
      !(await evaluate(
        "!!document.querySelector('[role=option], [role=dialog] [role=dialog], body > [data-ui=dialog], [data-ui=dialog]')",
      ))
    )
      for (const hit of metrics.hits)
        assert(hit.hit, `${name}-${width}-${theme}: ${hit.name} is covered`);
    report.scenes[`${name}-${width}-${theme}`] = metrics;
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(
      resolve(output, `${name}-${width}-${theme}.png`),
      Buffer.from(data, "base64"),
    );
  };
  const scene = async (name, width, theme, steps) => {
    try {
      await steps();
      await shoot(name, width, theme);
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      report.missing.push(`${name}-${width}-${theme}: ${error.message}`);
    }
  };
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
      const open = async (path, hash, ready) => {
        await leave(`${width}-${theme}`);
        await send("Page.navigate", {
          url: `${server.resolvedUrls.local[0]}${path}${hash}`,
        });
        await until(ready);
        await run((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
      };
      const tab = async (name, ready) => {
        await open(
          "__c494",
          "#/p/p-1/settings",
          "!!document.querySelector('nav[aria-label=设置分栏]')",
        );
        await run((name) => {
          [...document.querySelectorAll("nav[aria-label='设置分栏'] button")]
            .find((b) => b.textContent.trim() === name)
            .click();
        }, name);
        await until(ready);
        await delay(100);
        await run(() => document.activeElement?.blur?.());
      };
      // Reference page: the cards board at the same width and theme.
      await open(
        "__cards",
        "#/p/p-1/cards?view=board",
        "!!document.querySelector('.board-card')",
      );
      await shoot("cards", width, theme);
      const roles = () =>
        tab("角色", "document.body.textContent.includes('文档写手')");
      await scene("roles", width, theme, roles);
      await scene("role-detail", width, theme, async () => {
        await roles();
        await press("开发工程师");
        await until("!!document.querySelector('[role=dialog] dl')");
        await run(() => document.activeElement?.blur?.());
      });
      await scene("role-edit", width, theme, async () => {
        await roles();
        await press("开发工程师");
        await until("!!document.querySelector('[role=dialog] dl')");
        await press("编辑");
        await until("!!document.querySelector('[role=dialog] textarea')");
        await run(() => {
          const field = [
            ...document.querySelectorAll("[role=dialog] label"),
          ].find((l) => l.textContent.trim().startsWith("启动配置"));
          field.scrollIntoView({ block: "center" });
          document.activeElement?.blur?.();
        });
      });
      await scene("role-profile-menu", width, theme, async () => {
        await roles();
        await press("开发工程师");
        await until("!!document.querySelector('[role=dialog] dl')");
        await press("编辑");
        await until("!!document.querySelector('[role=dialog] textarea')");
        await run(() => {
          const trigger = [...document.querySelectorAll("[role=dialog] label")]
            .find((l) => l.textContent.trim().startsWith("启动配置"))
            .querySelector("[role=combobox]");
          trigger.scrollIntoView({ block: "center" });
          trigger.focus();
        });
        await key("ArrowDown", "ArrowDown", 40);
        await until("!!document.querySelector('[role=option]')");
      });
      await scene("role-markdown-preview", width, theme, async () => {
        await roles();
        await press("开发工程师");
        await until("!!document.querySelector('[role=dialog] dl')");
        await press("编辑");
        await until("!!document.querySelector('[role=dialog] textarea')");
        await type(
          "角色说明",
          "## 职责\n\n- 按卡片实现功能并附带**单元测试**。\n- 交付前跑 `pnpm lint` 与相关测试。\n\n> 有疑问先在卡片上提问。",
        );
        await press("预览");
        await until("!!document.querySelector('[role=dialog] .markdown h2')");
        await run(() => document.activeElement?.blur?.());
      });
      await scene("import-preview", width, theme, async () => {
        await roles();
        await press("从 Markdown 导入");
        await until("!!document.querySelector('[role=dialog] textarea')");
        await type(
          "Markdown",
          `---\nrole_id: proofreader\ndisplay_name: 校对员\nbased_on: reviewer\nlaunch_profile: codex-agent\ntemplate: {id: proofread, from: dev, replace_role: reviewer}\nemployees:\n  - {name: 小林, title: 校对员}\n---\n对照验收标准检查稿件，逐条列出需修改的地方。\n`,
        );
        await press("预览");
        await until(
          "[...document.querySelectorAll('[role=dialog] button')].some((b) => b.textContent === '应用')",
        );
        await run(() => {
          document.activeElement?.blur?.();
          [...document.querySelectorAll("[role=dialog] button")]
            .find((b) => b.textContent === "应用")
            .scrollIntoView({ block: "start" });
        });
      });
      // V-2525 / Q-1045: long work item changes and long ids (the reviewers'
      // attachment-7768 replay). The table must fit its column with every cell
      // visible and no overlap inside a record; otherwise the run fails.
      for (const [name, marker] of [
        ["import-long-change", "long-change"],
        ["import-replay-7768", "replay-7768"],
      ])
        await scene(name, width, theme, async () => {
          await roles();
          await press("从 Markdown 导入");
          await until("!!document.querySelector('[role=dialog] textarea')");
          await type(
            "Markdown",
            `---\nrole_id: proofreader\ntemplate: {id: copy, from: source, replace_role: qa-one}\n---\n${marker}\n`,
          );
          await press("预览");
          await until(
            "!!document.querySelector('[role=dialog] table[aria-label=模板工作项]')",
          );
          await run(() => {
            document.activeElement?.blur?.();
            document
              .querySelector("[role=dialog] table[aria-label=模板工作项]")
              .scrollIntoView({ block: "start" });
          });
          const fit = await run(() => {
            const table = document.querySelector(
              "[role=dialog] table[aria-label=模板工作项]",
            );
            const scroll = table.parentElement;
            const box = scroll.getBoundingClientRect();
            const rows = [...table.querySelectorAll("tbody tr")];
            const overlaps = rows.flatMap((row) => {
              const cells = [...row.children].map((c) => ({
                r: c.getBoundingClientRect(),
                label: c.dataset.label ?? c.dataset.record,
              }));
              const out = [];
              for (let i = 0; i < cells.length; i++)
                for (let j = i + 1; j < cells.length; j++) {
                  const a = cells[i].r,
                    b = cells[j].r;
                  const x =
                    Math.min(a.right, b.right) - Math.max(a.left, b.left);
                  const y =
                    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                  if (x > 0.5 && y > 0.5 && a.width > 0 && b.width > 0)
                    out.push(`${cells[i].label}/${cells[j].label}`);
                }
              return out;
            });
            const outside = [...table.querySelectorAll("td")].filter((td) => {
              const r = td.getBoundingClientRect();
              return (
                r.width > 0 &&
                (r.right > box.right + 0.5 || r.left < box.left - 0.5)
              );
            }).length;
            return {
              tableWidth: Math.round(table.getBoundingClientRect().width),
              scrollWidth: scroll.scrollWidth,
              clientWidth: scroll.clientWidth,
              cellsOutside: outside,
              overlaps,
            };
          });
          report.tableFit ??= {};
          report.tableFit[`${name}-${width}-${theme}`] = fit;
          assert(
            fit.scrollWidth <= fit.clientWidth &&
              fit.cellsOutside === 0 &&
              fit.overlaps.length === 0,
            `${name}-${width}-${theme}: table does not fit ${JSON.stringify(fit)}`,
          );
        });
      await scene("discard-dialog", width, theme, async () => {
        await roles();
        await press("从 Markdown 导入");
        await until("!!document.querySelector('[role=dialog] textarea')");
        await type("Markdown", "---\nrole_id: draft\n---\n草稿\n");
        await press("取消");
        await until(
          "[...document.querySelectorAll('[role=dialog]')].some((d) => d.textContent.includes('放弃未应用的修改'))",
        );
      });
      await scene("role-created", width, theme, async () => {
        await roles();
        await press("新建角色");
        await until("!!document.querySelector('[role=dialog] form')");
        await type("新角色编号", "proofreader");
        await press("创建角色");
        await until(
          "[...document.querySelectorAll('[role=dialog] button')].some((b) => b.textContent === '加进模板')",
        );
        await run(() => document.activeElement?.blur?.());
      });
      await scene("template-preview", width, theme, async () => {
        await roles();
        await press("新建角色");
        await until("!!document.querySelector('[role=dialog] form')");
        await type("新角色编号", "proofreader");
        await press("创建角色");
        await until(
          "[...document.querySelectorAll('[role=dialog] button')].some((b) => b.textContent === '加进模板')",
        );
        await press("加进模板");
        await until(
          "[...document.querySelectorAll('[role=dialog] [role=combobox]')].length > 0 && document.querySelector('[role=dialog] h2')?.textContent === '加进模板'",
        );
        await choose("模板", "文档卡");
        await type("工作项编号", "proofreading");
        await type("工作项标题", "校对");
        await press("预览");
        await until(
          "[...document.querySelectorAll('[role=dialog] button')].some((b) => b.textContent === '应用')",
        );
        await run(() => document.activeElement?.blur?.());
      });
      const employees = () =>
        tab("员工", "document.body.textContent.includes('孙悟空')");
      await scene("employees", width, theme, employees);
      await scene("employee-blocked", width, theme, async () => {
        await employees();
        await press("八戒");
        await until("!!document.querySelector('[role=dialog] form')");
        await run(() => document.activeElement?.blur?.());
      });
      await scene("employee-role", width, theme, async () => {
        await employees();
        await press("悟净");
        await until("!!document.querySelector('[role=dialog] form')");
        await choose("角色", "开发工程师");
        await run(() => document.activeElement?.blur?.());
      });
    }
  // Side by side with the cards page at the same width and theme.
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const cards = await readFile(
        resolve(output, `cards-${width}-${theme}.png`),
      );
      for (const name of ["roles", "employees", "import-preview"]) {
        const file = resolve(output, `${name}-${width}-${theme}.png`);
        let shot;
        try {
          shot = await readFile(file);
        } catch {
          continue;
        }
        await send("Emulation.setDeviceMetricsOverride", {
          width: width * 2 + 16,
          height: 1000,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await leave(`side-by-side-${width}-${theme}`);
        await run(
          (a, b) => {
            document.body.style.cssText =
              "margin:0;display:flex;gap:16px;background:#888";
            for (const src of [a, b]) {
              const img = document.createElement("img");
              img.src = `data:image/png;base64,${src}`;
              document.body.append(img);
            }
            return Promise.all([...document.images].map((i) => i.decode()));
          },
          shot.toString("base64"),
          cards.toString("base64"),
        );
        const { data } = await send("Page.captureScreenshot", {
          format: "png",
        });
        await writeFile(
          resolve(output, `side-by-side-${name}-${width}-${theme}.png`),
          Buffer.from(data, "base64"),
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
