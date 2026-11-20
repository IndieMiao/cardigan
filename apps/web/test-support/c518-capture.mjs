// C-518: settings "模型" panel (read-only launch profiles): list, detail
// drawer, empty / failed / loading reads and the role link, at 1440/390 in
// light/dark, plus the existing roles panel and the card list at the same
// width/theme for side-by-side comparison. V-2439 rework: masked duplicate
// names, the referenced role version, browser back and the employee link
// (execution view filtered by employee id).
// CHROMIUM_PATH=<chromium> node apps/web/test-support/c518-capture.mjs <new output dir>
// C518_BASELINE_REF=<git ref> renders that ref's settings page (before; no 模型).
// C518_BEFORE=<before output dir> counts differing pixels against it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
assert(process.argv[2], "Pass a new output directory");
const output = resolve(process.argv[2]);
const baseline = process.env.C518_BASELINE_REF;
const before = process.env.C518_BEFORE && resolve(process.env.C518_BEFORE);
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
// Files this card changes; the baseline renders its own copies.
const historical = new Map(
  baseline
    ? [
        "api.ts",
        "testing/fixtures.ts",
        "views/SettingsPage.tsx",
        "views/RolesSettings.tsx",
        "views/ExecutionPage.tsx",
        "components/ExecutionToolbar.tsx",
        "components/ui/table.tsx",
        "components/ui/theme.css",
      ].map((path) => [
        resolve(root, "src", path),
        git("show", `${baseline}:apps/web/src/${path}`),
      ])
    : [],
);
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c518-fixture",
      enforce: "pre",
      load(id) {
        return historical.get(id.split("?")[0]);
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c518")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c518",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c518-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
const cases = [];
const shots = {};
const pairs = [];
let browser;
try {
  await mkdir(output, { recursive: true });
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
  const run = (fn, ...args) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const until = async (expression, ms = 15000) => {
    const end = Date.now() + ms;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, `Timed out: ${expression}`);
      await delay(25);
    }
  };
  const settle = async () => {
    await evaluate("document.fonts.ready.then(() => true)");
    await run(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    await delay(150);
  };
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(resolve(output, name), Buffer.from(data, "base64"));
    shots[name] = data;
    return data;
  };
  const key = async (name, code) => {
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key: name,
        code: name,
        windowsVirtualKeyCode: code,
        nativeVirtualKeyCode: code,
        ...(name === "Enter" && type === "keyDown" ? { text: "\r" } : {}),
      });
  };
  const open = async (path, ready, theme) => {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c518${path}`,
    });
    await until(ready);
    await run((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await settle();
  };
  const tab = async (name) => {
    await run((name) => {
      const button = [
        ...document.querySelectorAll("nav[aria-label='设置分栏'] button"),
      ].find((b) => b.textContent.trim() === name);
      if (!button) throw new Error(`Missing tab: ${name}`);
      button.click();
      // A scripted click has no pointer: drop the panel focus ring.
      requestAnimationFrame(() => document.activeElement?.blur());
    }, name);
    await settle();
  };
  const measurePage = () =>
    run(() => {
      const box = (e) => {
        if (!e) return null;
        const r = e.getBoundingClientRect(),
          s = getComputedStyle(e);
        return {
          text: e.textContent.trim().slice(0, 32),
          x: Math.round(r.left * 10) / 10,
          y: Math.round(r.top * 10) / 10,
          w: Math.round(r.width * 10) / 10,
          h: Math.round(r.height * 10) / 10,
          font: `${s.fontSize}/${s.lineHeight} ${s.fontWeight}`,
          color: s.color,
        };
      };
      const content = document.querySelector(
        "[data-settings-content]:not([hidden])",
      );
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
      const nav = [
        ...document.querySelectorAll("nav[aria-label='设置分栏'] button"),
      ];
      const feedback = [...document.querySelectorAll(".request-feedback")]
        .filter((t) => t.textContent.trim())
        .map((t) => ({
          text: t.textContent.trim(),
          role: t.getAttribute("role"),
        }));
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        pageTitle: box(document.querySelector(".ui-page-header h1")),
        nav: nav.map((b) => b.textContent.trim()),
        navItem: box(nav[0]),
        navLast: box(nav.at(-1)),
        navCurrent: box(
          document.querySelector(
            "nav[aria-label='设置分栏'] [aria-current='page']",
          ),
        ),
        content: box(content),
        panelTitle: box(content?.querySelector("h2")),
        table: box(content?.querySelector("table")),
        tableHead: box(content?.querySelector("th")),
        tableCell: box(content?.querySelector("td")),
        tableCellText: box(content?.querySelector("td:nth-child(2)")),
        rowLink: box(content?.querySelector("td [data-ui='button']")),
        statusTag: box(content?.querySelector("td [data-ui='badge']")),
        empty: box(content?.querySelector(".empty-state, .empty")),
        feedback,
        overflowing,
      };
    });
  const measureDrawer = () =>
    run(() => {
      const d = document.querySelector("[role=dialog]");
      const font = (e) => {
        if (!e) return null;
        const s = getComputedStyle(e),
          b = e.getBoundingClientRect();
        return {
          text: e.textContent.trim().slice(0, 32),
          font: `${s.fontSize}/${s.lineHeight} ${s.fontWeight}`,
          x: Math.round(b.left),
          y: Math.round(b.top),
          w: Math.round(b.width),
          h: Math.round(b.height),
        };
      };
      const r = d.getBoundingClientRect();
      const scroller = d.querySelector(".card-page-drawer")?.parentElement;
      return {
        drawer: { x: r.left, y: r.top, w: r.width, h: r.height },
        drawerScrollWidth: d.scrollWidth,
        drawerClientWidth: d.clientWidth,
        innerOverflow: [...d.querySelectorAll("*")]
          .filter((e) => e.getBoundingClientRect().right > r.right + 0.5)
          .slice(0, 5)
          .map(font),
        title: font(d.querySelector("h2")),
        section: font(d.querySelector("section h3")),
        factLabel: font(d.querySelector("dt")),
        factValue: font(d.querySelector("dd")),
        statusTag: font(d.querySelector("[data-ui='badge']")),
        link: font(d.querySelector("a[data-ui='button']")),
        close: font(d.querySelector("[aria-label='关闭抽屉']")),
        writeControls: d.querySelectorAll(
          "input, textarea, select, [role=switch], [role=checkbox]",
        ).length,
        buttons: [...d.querySelectorAll("button")].map(
          (b) => b.getAttribute("aria-label") ?? b.textContent.trim(),
        ),
        scroller: scroller
          ? {
              scrollHeight: scroller.scrollHeight,
              clientHeight: scroller.clientHeight,
            }
          : null,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
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
      const results = {};
      const suffix = `${width}-${theme}.png`;
      const settings = "!!document.querySelector('[data-settings-content]')";
      // Card page reference (same fixture App, list view).
      await open(
        "/#/p/p-1/cards?view=list",
        "!!document.querySelector('table, .card-list')",
        theme,
      );
      const cardsShot = await shot(`cards-${suffix}`);
      results.cards = await measurePage();
      // Existing settings page: roles panel (before and after).
      await open("/#/p/p-1/settings", settings, theme);
      await tab("角色");
      await until("!!document.querySelector('[data-settings-content] table')");
      await settle();
      const rolesShot = await shot(`roles-${suffix}`);
      results.roles = await measurePage();
      // Execution view: unfiltered, and with an employee id (before: ignored).
      const rowIds = () =>
        run(() =>
          [...document.querySelectorAll("button[aria-label^='查看 A-']")].map(
            (b) => /A-\d+/.exec(b.getAttribute("aria-label"))[0],
          ),
        );
      const executionReady =
        "!!document.querySelector(\"button[aria-label^='查看 A-']\") || !!document.body?.textContent.includes('没有匹配的执行记录')";
      for (const [name, query] of [
        ["execution", "view=all"],
        ["execution-employee", "view=all&employee=E-3"],
      ]) {
        await open(`/#/p/p-1/execution?${query}`, executionReady, theme);
        await shot(`${name}-${suffix}`);
        results[name] = {
          rows: await rowIds(),
          employeeControl: await evaluate(
            "[...document.querySelectorAll('[role=combobox]')].map((c) => c.textContent.trim()).find((t) => t.startsWith('员工：')) ?? null",
          ),
          scrollWidth: await evaluate("document.documentElement.scrollWidth"),
        };
      }
      if (!baseline) {
        // Models list.
        await tab("模型");
        await until(
          "!!document.querySelector('table[aria-label=启动配置] tbody tr')",
        );
        await settle();
        const modelsShot = await shot(`models-${suffix}`);
        results.models = await measurePage();
        assert.equal(results.models.scrollWidth, width, "models: overflow");
        assert.deepEqual(results.models.overflowing, [], "models: column");
        pairs.push(
          {
            name: "models-vs-roles",
            width,
            theme,
            left: rolesShot,
            right: modelsShot,
          },
          {
            name: "models-vs-cards",
            width,
            theme,
            left: cardsShot,
            right: modelsShot,
          },
        );
        // Detail opened with the keyboard; Escape returns focus to the opener.
        await run(() => {
          const b = [
            ...document.querySelectorAll("[data-settings-content] td button"),
          ].find((x) => x.textContent.trim() === "claude-opus");
          window.__opener = b;
          b.focus();
        });
        await key("Enter", 13);
        await until("!!document.querySelector('[role=dialog] dl')");
        await delay(300);
        await settle();
        await shot(`models-detail-${suffix}`);
        results.detail = await measureDrawer();
        assert.equal(results.detail.writeControls, 0, "detail: read only");
        assert.deepEqual(results.detail.buttons, ["关闭抽屉"]);
        assert(
          results.detail.drawerScrollWidth <= results.detail.drawerClientWidth,
          "detail: drawer overflow",
        );
        // Scroll the drawer to the references table.
        await run(() =>
          document
            .querySelector("[role=dialog] table[aria-label=使用者]")
            .scrollIntoView({ block: "end" }),
        );
        await settle();
        await shot(`models-detail-users-${suffix}`);
        results.detailUsers = await measureDrawer();
        await key("Escape", 27);
        await until("!document.querySelector('[role=dialog]')");
        await delay(100);
        results.focusReturned = await evaluate(
          "document.activeElement === window.__opener",
        );
        assert(results.focusReturned, "detail: focus returns to the row");
        // A failed check with an unset secret.
        await run(() =>
          [...document.querySelectorAll("[data-settings-content] td button")]
            .find((x) => x.textContent.trim() === "codex-sol")
            .click(),
        );
        await until("!!document.querySelector('[role=dialog] dl')");
        await delay(300);
        await settle();
        await shot(`models-detail-failed-${suffix}`);
        results.detailFailed = await measureDrawer();
        await key("Escape", 27);
        await until("!document.querySelector('[role=dialog]')");
        // Role link: opens the role detail on the roles panel.
        await run(() =>
          [...document.querySelectorAll("[data-settings-content] td button")]
            .find((x) => x.textContent.trim() === "codex-sol")
            .click(),
        );
        await until("!!document.querySelector('[role=dialog] a')");
        await run(() =>
          [...document.querySelectorAll("[role=dialog] a")]
            .find((a) => a.textContent.trim() === "开发工程师")
            .click(),
        );
        await until(
          "!!document.querySelector('[role=dialog]') && document.querySelector('[role=dialog] h2')?.textContent.includes('开发工程师') && !!document.querySelector('[role=dialog] dl')",
        );
        await delay(300);
        await settle();
        await shot(`role-link-${suffix}`);
        results.roleLink = {
          hash: await evaluate("location.hash"),
          current: await evaluate(
            "document.querySelector(\"nav[aria-label='设置分栏'] [aria-current='page']\").textContent.trim()",
          ),
        };
        // The referenced version (v1, current is v2) is marked in the history.
        await until(
          "!!document.querySelector('[role=dialog] table[aria-label=版本历史] tbody tr')",
        );
        await run(() =>
          document
            .querySelector("[role=dialog] table[aria-label=版本历史]")
            .scrollIntoView({ block: "end" }),
        );
        await settle();
        await shot(`role-link-history-${suffix}`);
        results.roleLink.history = await run(() =>
          [
            ...document.querySelectorAll(
              "[role=dialog] table[aria-label=版本历史] tbody tr",
            ),
          ].map((tr) => {
            const td = tr.querySelector("td");
            const s = getComputedStyle(td);
            return {
              version: td.textContent.trim(),
              current: tr.getAttribute("aria-current"),
              background: s.backgroundColor,
              color: s.color,
              h: Math.round(tr.getBoundingClientRect().height),
            };
          }),
        );
        assert.equal(
          results.roleLink.hash,
          "#/p/p-1/settings?tab=roles&role=coder&version=1",
        );
        assert.deepEqual(
          results.roleLink.history.map((r) => [r.version, r.current]),
          [
            ["v2", null],
            ["v1", "true"],
          ],
        );
        await key("Escape", 27);
        await until("!document.querySelector('[role=dialog]')");
        results.roleLink.afterClose = await evaluate("location.hash");
        assert.equal(results.roleLink.current, "角色");
        assert.equal(results.roleLink.afterClose, "#/p/p-1/settings?tab=roles");
        // Browser back from a followed role link returns to 模型.
        await open("/#/p/p-1/settings", settings, theme);
        await tab("模型");
        await until(
          "!!document.querySelector('table[aria-label=启动配置] tbody tr')",
        );
        await run(() =>
          [...document.querySelectorAll("[data-settings-content] td button")]
            .find((x) => x.textContent.trim() === "codex-sol")
            .click(),
        );
        await until("!!document.querySelector('[role=dialog] a')");
        await run(() =>
          [...document.querySelectorAll("[role=dialog] a")]
            .find((a) => a.textContent.trim() === "开发工程师")
            .click(),
        );
        await until(
          "document.querySelector('[role=dialog] h2')?.textContent.includes('开发工程师') && !!document.querySelector('[role=dialog] dl')",
        );
        await run(() => history.back());
        await until(
          "!document.querySelector('[role=dialog]') && !!document.querySelector('table[aria-label=启动配置] tbody tr')",
        );
        await settle();
        await shot(`models-after-back-${suffix}`);
        results.back = {
          hash: await evaluate("location.hash"),
          current: await evaluate(
            "document.querySelector(\"nav[aria-label='设置分栏'] [aria-current='page']\").textContent.trim()",
          ),
        };
        assert.deepEqual(results.back, {
          hash: "#/p/p-1/settings?tab=models",
          current: "模型",
        });
        // Employee link: that employee's records only, in any status.
        await run(() =>
          [...document.querySelectorAll("[data-settings-content] td button")]
            .find((x) => x.textContent.trim() === "claude-opus")
            .click(),
        );
        await until("!!document.querySelector('[role=dialog] a')");
        await run(() =>
          [...document.querySelectorAll("[role=dialog] a")]
            .find((a) => a.textContent.trim() === "悟空")
            .click(),
        );
        await until(executionReady);
        await settle();
        await shot(`employee-link-${suffix}`);
        results.employeeLink = {
          hash: await evaluate("location.hash"),
          rows: await rowIds(),
          employeeControl: await evaluate(
            "[...document.querySelectorAll('[role=combobox]')].map((c) => c.textContent.trim()).find((t) => t.startsWith('员工：')) ?? null",
          ),
          scrollWidth: await evaluate("document.documentElement.scrollWidth"),
        };
        assert.deepEqual(results.employeeLink, {
          hash: "#/p/p-1/execution?view=all&employee=E-3",
          rows: ["A-1"],
          employeeControl: "员工：悟空",
          scrollWidth: width,
        });
        // Names redacted to the same mask: each row opens its own profile.
        await open(
          "/?models=masked#/p/p-1/settings?tab=models",
          settings,
          theme,
        );
        await until(
          "document.querySelectorAll('[data-settings-content] td button').length >= 4",
        );
        await run(() =>
          [...document.querySelectorAll("[data-settings-content] td button")]
            .filter((x) => x.textContent.trim() === "***")[1]
            .click(),
        );
        await until("!!document.querySelector('[role=dialog] dl')");
        await delay(300);
        await settle();
        await shot(`models-masked-detail-${suffix}`);
        results.masked = await run(() => {
          const d = document.querySelector("[role=dialog]").textContent;
          return {
            second: d.includes("gpt-fixture-sol"),
            first: d.includes("claude-opus-fixture-1"),
          };
        });
        assert.deepEqual(results.masked, { second: true, first: false });
        // Read states.
        for (const state of ["empty", "error", "pending"]) {
          await open(`/?models=${state}#/p/p-1/settings`, settings, theme);
          await tab("模型");
          await until(
            state === "empty"
              ? "document.querySelector('[data-settings-content]:not([hidden])')?.textContent.includes('没有启动配置')"
              : state === "error"
                ? "!!document.querySelector('.request-feedback-error button')"
                : "[...document.querySelectorAll('.request-feedback')].some((t) => t.textContent.includes('正在加载启动配置'))",
          );
          await settle();
          await shot(`models-${state}-${suffix}`);
          results[`models-${state}`] = await measurePage();
          assert.equal(results[`models-${state}`].scrollWidth, width);
        }
      }
      cases.push({ width, theme, results });
    }
  // Side-by-side: reference (left) | models panel (right), same width/theme.
  await send("Emulation.setDeviceMetricsOverride", {
    width: 2 * 1440 + 16,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: "about:blank" });
  await until("location.href === 'about:blank'");
  const compose = (a, b, width) =>
    run(
      async (a, b, width) => {
        const load = (src) =>
          new Promise((r) => {
            const img = new Image();
            img.onload = () => r(img);
            img.src = `data:image/png;base64,${src}`;
          });
        const [left, right] = await Promise.all([load(a), load(b)]);
        const canvas = document.createElement("canvas");
        canvas.width = width * 2 + 16;
        canvas.height = Math.max(left.height, right.height);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#888";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(left, 0, 0);
        ctx.drawImage(right, width + 16, 0);
        return canvas.toDataURL("image/png").split(",")[1];
      },
      a,
      b,
      width,
    );
  for (const { name, width, theme, left, right } of pairs)
    await writeFile(
      resolve(output, `side-by-side-${name}-${width}-${theme}.png`),
      Buffer.from(await compose(left, right, width), "base64"),
    );
  // Pixel difference against the before capture, same name.
  const diffs = {};
  if (before)
    for (const name of Object.keys(shots)) {
      let old;
      try {
        old = (await readFile(resolve(before, name))).toString("base64");
      } catch {
        continue; // new scene, no before
      }
      diffs[name] = await run(
        async (a, b) => {
          const load = (src) =>
            new Promise((r) => {
              const img = new Image();
              img.onload = () => r(img);
              img.src = `data:image/png;base64,${src}`;
            });
          const [x, y] = await Promise.all([load(a), load(b)]);
          if (x.width !== y.width || x.height !== y.height) return "size";
          const pixels = (img) => {
            const c = document.createElement("canvas");
            c.width = img.width;
            c.height = img.height;
            const ctx = c.getContext("2d");
            ctx.drawImage(img, 0, 0);
            return ctx.getImageData(0, 0, img.width, img.height).data;
          };
          const [p, q] = [pixels(x), pixels(y)];
          let n = 0;
          for (let i = 0; i < p.length; i += 4)
            if (
              p[i] !== q[i] ||
              p[i + 1] !== q[i + 1] ||
              p[i + 2] !== q[i + 2] ||
              p[i + 3] !== q[i + 3]
            )
              n++;
          return n;
        },
        old,
        shots[name],
      );
    }
  assert.deepEqual(browser.errors, []);
  const report = {
    stage: baseline ? "before" : "after",
    head: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    dirty: git("status", "--porcelain") !== "",
    baseline: baseline ? git("rev-parse", baseline) : null,
    browser: await send("Browser.getVersion"),
    viewport:
      "1440x1000 / 390x1000, DPR 1, prefers-reduced-motion: reduce, --hide-scrollbars, software raster flags of the page skeleton baseline",
    fonts:
      "Inter Variable, Noto Sans SC Variable, JetBrains Mono Variable (lockfile @fontsource)",
    fixture:
      "test-support/c518-fixture.tsx + src/testing/launch-settings-fixture.ts: 4 synthetic launch profiles (2 names masked to *** in the masked scene), 3 providers, 3 role and 2 employee references, fake key names only; settings-panels-data.ts for roles (coder v2 current, v1 history); 2 synthetic execution records (E-3 悟空, E-4 八戒 whose card title names 悟空); fixed clock 2026-01-01T00:00Z; no backend, not production scale",
    cases,
    pixelDiffAgainstBefore: before ? diffs : null,
  };
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`C-518 ${report.stage}: ${Object.keys(shots).length} shots`);
} finally {
  await browser?.close();
  await server.close();
}
