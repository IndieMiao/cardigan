// C-514: the comment box suggests employees after `@`. Captures 1440/390 ×
// light/dark: the card list reference, the box at rest, the open list, the
// filtered list, keyboard selection, the inserted name and the list near the
// viewport bottom; plus card list | open list side-by-side images, and measures
// list geometry, typography, viewport containment and overflow.
// CHROMIUM_PATH=<chrome> node apps/web/test-support/c514-capture.mjs <new output dir>
// C514_BASELINE_REF=<git ref> serves that ref's comment box for before shots.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "");
assert(process.argv[2], "Pass a new output directory");
const baseline = process.env.C514_BASELINE_REF;
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const historical = new Map(
  baseline
    ? [
        "components/CommentBox.tsx",
        "views/CardDetailPage.tsx",
        "styles.css",
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
      name: "c514-fixture",
      enforce: "pre",
      load(id) {
        return historical.get(id.split("?")[0]);
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c514")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c514",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c514-fixture.tsx"></script></body></html>',
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
    await delay(150);
  };
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(resolve(output, name), Buffer.from(data, "base64"));
    return name;
  };
  const open = async (hash, theme, ready) => {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c514${hash}`,
    });
    await until(ready);
    await evaluate("document.fonts.ready.then(() => true)");
    await run((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await settle();
  };
  const key = async (key, code, keyCode) => {
    for (const type of ["rawKeyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key,
        code,
        windowsVirtualKeyCode: keyCode,
      });
    await settle();
  };
  const type = async (text) => {
    await send("Input.insertText", { text });
    await settle();
  };
  /** Clear the box and put the caret in it, `block` sets where it sits. */
  const focusBox = async (block) => {
    await run((block) => {
      const input = document.querySelector(".comment-input");
      input.scrollIntoView({ block });
      input.focus();
      input.select();
      document.execCommand("delete");
    }, block);
    await settle();
  };
  const measure = () =>
    run(() => {
      const px = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect(),
          s = getComputedStyle(el);
        return {
          top: Math.round(r.top * 100) / 100,
          left: Math.round(r.left * 100) / 100,
          bottom: Math.round(r.bottom * 100) / 100,
          right: Math.round(r.right * 100) / 100,
          width: Math.round(r.width * 100) / 100,
          height: Math.round(r.height * 100) / 100,
          font: `${s.fontSize}/${s.lineHeight}`,
          color: s.color,
          background: s.backgroundColor,
          padding: s.padding,
        };
      };
      const input = document.querySelector(".comment-input");
      const popover = document.querySelector(".ui-suggestions");
      const options = [...document.querySelectorAll("[role=option]")];
      const first = options[0];
      const activeId = input?.getAttribute("aria-activedescendant");
      return {
        value: input?.value,
        placeholder: input?.placeholder,
        input: px(input),
        popover: px(popover),
        popoverInViewport: popover
          ? (() => {
              const r = popover.getBoundingClientRect();
              return (
                r.top >= 0 &&
                r.left >= 0 &&
                r.bottom <= innerHeight &&
                r.right <= innerWidth
              );
            })()
          : null,
        popoverSide: popover?.getAttribute("data-side") ?? null,
        options: options.map((o) => o.textContent),
        status: popover?.querySelector("[role=status]")?.textContent ?? null,
        option: px(first),
        avatar: px(first?.querySelector(".employee-avatar")),
        label: px(first?.querySelector(".ui-suggestion-label")),
        meta: px(first?.querySelector(".ui-suggestion-meta")),
        avatarToLabel:
          first &&
          first.querySelector(".ui-suggestion-label").getBoundingClientRect()
            .left -
            first.querySelector(".employee-avatar").getBoundingClientRect()
              .right,
        active: activeId
          ? document.getElementById(activeId)?.textContent
          : null,
        activeStyle: activeId ? px(document.getElementById(activeId)) : null,
        oldList: px(document.querySelector(".mention-list")),
        oldButtons: [...document.querySelectorAll(".mention-list button")].map(
          (b) => b.textContent,
        ),
        focusInInput: document.activeElement === input,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        innerHeight,
      };
    });
  const sideBySide = async (left, right, name, width) => {
    const data = async (file) =>
      `data:image/png;base64,${(await readFile(resolve(output, file))).toString("base64")}`;
    await send("Emulation.setDeviceMetricsOverride", {
      width: width * 2 + 16,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await run(
      (a, b) => {
        document.body.style.cssText =
          "margin:0;display:flex;gap:16px;background:#888";
        for (const src of [a, b]) {
          const img = document.createElement("img");
          img.src = src;
          img.style.display = "block";
          document.body.append(img);
        }
        return Promise.all(
          [...document.images].map((i) => i.decode().then(() => true)),
        );
      },
      await data(left),
      await data(right),
    );
    await settle();
    return shot(name);
  };
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const viewport = async () => {
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
      };
      await viewport();
      const tag = `${width}-${theme}`;
      const result = { width, theme, shots: [] };
      cases.push(result);
      // Reference page: the card list at the same width and theme.
      await open(
        "#/p/p-1/cards?view=list",
        theme,
        "!!document.querySelector('.card-table')",
      );
      result.shots.push(await shot(`cards-${tag}.png`));
      await open(
        "#/p/p-1/cards/C-1",
        theme,
        "!!document.querySelector('.card-page .comment-input')",
      );
      await run(() => {
        [...document.querySelectorAll(".card-page [role=tab]")]
          .find((t) => t.textContent.startsWith("时间线"))
          ?.click();
      });
      await until(
        "document.querySelector('.comment-input').getBoundingClientRect().width > 0",
      );
      await run(() =>
        document.querySelector(".comment-input").scrollIntoView({
          block: "center",
        }),
      );
      await settle();
      result.rest = await measure();
      result.shots.push(await shot(`box-${tag}.png`));
      await focusBox("center");
      await type("请 @");
      if (baseline) {
        await until("!!document.querySelector('.mention-list')");
        await settle();
        result.open = await measure();
        result.shots.push(await shot(`open-${tag}.png`));
      } else {
        await until("document.querySelectorAll('[role=option]').length > 0");
        await settle();
        result.open = await measure();
        result.shots.push(await shot(`open-${tag}.png`));
        await type("宝");
        result.filter = await measure();
        result.shots.push(await shot(`filter-${tag}.png`));
        await focusBox("center");
        await type("@");
        await until("document.querySelectorAll('[role=option]').length > 0");
        await key("ArrowDown", "ArrowDown", 40);
        await key("ArrowDown", "ArrowDown", 40);
        result.keyboard = await measure();
        result.shots.push(await shot(`keyboard-${tag}.png`));
        await key("Enter", "Enter", 13);
        result.inserted = await measure();
        result.shots.push(await shot(`inserted-${tag}.png`));
        await key("Escape", "Escape", 27);
        // Close to the viewport bottom (a 560px tall viewport, the box
        // scrolled to its end): the list flips above the box.
        await send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 560,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await focusBox("end");
        await type("@");
        await until("document.querySelectorAll('[role=option]').length > 0");
        result.edge = await measure();
        result.shots.push(await shot(`edge-${tag}.png`));
        await key("Escape", "Escape", 27);
        result.escaped = await measure();
        // Inside the card drawer, Escape closes the list, not the drawer.
        await viewport();
        await open(
          "#/p/p-1/cards?view=list&card=C-1",
          theme,
          "!!document.querySelector('.drawer-content .comment-input')",
        );
        await run(() => {
          [...document.querySelectorAll(".drawer-content [role=tab]")]
            .find((t) => t.textContent.startsWith("时间线"))
            ?.click();
        });
        await until(
          "document.querySelector('.drawer-content .comment-input').getBoundingClientRect().width > 0",
        );
        await focusBox("center");
        await type("@");
        await until("document.querySelectorAll('[role=option]').length > 0");
        result.drawer = await measure();
        result.shots.push(await shot(`drawer-${tag}.png`));
        await key("Escape", "Escape", 27);
        result.drawerEscaped = {
          ...(await measure()),
          drawerOpen: await evaluate(
            "!!document.querySelector('.drawer-content')",
          ),
        };
      }
      result.shots.push(
        await sideBySide(
          `cards-${tag}.png`,
          `open-${tag}.png`,
          `side-${tag}.png`,
          width,
        ),
      );
      console.log(
        `${tag}: ${(result.open.options.length ? result.open.options : result.open.oldButtons).join(" | ")}`,
      );
    }
  assert.deepEqual(browser.errors, []);
  const report = {
    head: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    dirty: git("status", "--porcelain") !== "",
    baseline: baseline ? git("rev-parse", baseline) : null,
    browser: await send("Browser.getVersion"),
    viewport: "1440x1000 / 390x1000, DPR 1, prefers-reduced-motion: reduce",
    fixture:
      "test-support/c514-fixture.tsx: shared cardDetail sample card + 2 list cards, 9 synthetic active employees (3 on the card, 7 library avatars, 2 initials); not production data",
    cases,
  };
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (!baseline)
    for (const c of cases) {
      const label = `${c.width}/${c.theme}`;
      assert.equal(
        c.rest.placeholder,
        "支持 Markdown；@ 提及员工；可以直接粘贴图片",
        label,
      );
      assert.equal(c.open.options.length, 9, `${label}: candidates`);
      assert(
        c.open.options.every((o) => !/角色|Assignment/.test(o)),
        `${label}: roles`,
      );
      assert.equal(c.open.popoverInViewport, true, `${label}: open in view`);
      assert.equal(c.filter.options.length, 1, `${label}: filter`);
      assert.equal(c.keyboard.active, c.keyboard.options[2], label);
      assert.equal(c.inserted.value, "@张良 ", label);
      assert.equal(c.inserted.popover, null, `${label}: closed`);
      assert.equal(c.edge.popoverInViewport, true, `${label}: edge in view`);
      assert.equal(c.escaped.popover, null, `${label}: escape`);
      assert(c.escaped.focusInInput, `${label}: focus kept`);
      assert.equal(c.drawer.popoverInViewport, true, `${label}: drawer list`);
      assert.equal(c.drawerEscaped.popover, null, `${label}: drawer escape`);
      assert(c.drawerEscaped.drawerOpen, `${label}: drawer kept open`);
      assert(c.drawerEscaped.focusInInput, `${label}: drawer focus kept`);
      for (const m of [c.open, c.filter, c.keyboard, c.edge])
        assert(m.scrollWidth <= m.innerWidth, `${label}: page overflows`);
    }
} finally {
  await browser?.close();
  await server.close();
}
