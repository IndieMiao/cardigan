// C-511 Q-1048: the machine drawer after a write whose reply was lost —
// unknown check (with 仍要重新检查 and its question), unknown drain still at
// the old state, and another project's check followed as the machine's — at
// 1440/390 in light/dark, beside the card list at the same width and theme.
// CHROMIUM_PATH=<chromium> node apps/web/test-support/c511-unknown-capture.mjs <new output dir>
// C511_BASELINE_REF=<git ref> renders that ref's machine page (before).
// C511_BEFORE=<before output dir> counts differing pixels against it.
// Q-1076 scenes (stale-reply, verify-failed): a late start reply for an
// older check after the reopened drawer follows a newer one. Q-1083 scenes:
// r4-late-reply (the running reply for a check already seen passed) and
// p1-next-check (B taken up after A failed). Q-1085 scene: p1c-late-answer
// (attachment-8243: A fails while B is followed, B passes, then A's reply).
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
const baseline = process.env.C511_BASELINE_REF;
const before = process.env.C511_BEFORE && resolve(process.env.C511_BEFORE);
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const historical = new Map(
  baseline
    ? [
        "views/MachinesSettings.tsx",
        "views/machine-actions.ts",
        "components/layout/SettingsLayout.tsx",
      ].flatMap((path) => {
        // views/machine-actions.ts exists from Q-1074 on.
        try {
          return [
            [
              resolve(root, "src", path),
              git("show", `${baseline}:apps/web/src/${path}`),
            ],
          ];
        } catch {
          return [];
        }
      })
    : [],
);
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c511-unknown-fixture",
      enforce: "pre",
      load(id) {
        return historical.get(id.split("?")[0]);
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c511")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c511",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c511-unknown-fixture.tsx"></script></body></html>',
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
  await mkdir(output);
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
  const run = (fn, ...args) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const until = async (expression, ms = 15000) => {
    const end = Date.now() + ms;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, `Timed out: ${expression}`);
      await delay(25);
    }
  };
  const has = (text) =>
    `document.body.textContent.includes(${JSON.stringify(text)})`;
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
  const open = async (path, ready, theme) => {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c511${path}`,
    });
    await until(ready);
    await run((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await settle();
  };
  const click = async (scope, name) => {
    await until(
      `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].some((b) => (b.getAttribute("aria-label") ?? b.textContent.trim()) === ${JSON.stringify(name)})`,
    );
    await run(
      (scope, name) => {
        const button = [...document.querySelectorAll(`${scope} button`)].find(
          (b) =>
            (b.getAttribute("aria-label") ?? b.textContent.trim()) === name,
        );
        button.click();
        requestAnimationFrame(() => document.activeElement?.blur());
      },
      scope,
      name,
    );
  };
  const drawer = async (scene, theme) => {
    await open(
      `/?scene=${scene}#/p/p-1/settings`,
      "!!document.querySelector('[data-settings-content]')",
      theme,
    );
    await click("nav[aria-label='设置分栏']", "机器");
    await click("table[aria-label='机器列表']", "本机");
    await until(has("项目绑定"));
    await settle();
  };
  const measure = () =>
    run(() => {
      const box = (e) => {
        if (!e) return null;
        const s = getComputedStyle(e),
          b = e.getBoundingClientRect();
        return {
          text: e.textContent.trim().slice(0, 40),
          font: `${s.fontSize}/${s.lineHeight} ${s.fontWeight}`,
          color: s.color,
          x: Math.round(b.left * 10) / 10,
          y: Math.round(b.top * 10) / 10,
          w: Math.round(b.width * 10) / 10,
          h: Math.round(b.height * 10) / 10,
        };
      };
      const sheet = document.querySelector(".drawer, [data-ui='sheet']")
        ? document.querySelector("[role=dialog]")
        : null;
      const dialogs = [...document.querySelectorAll("[role=dialog]")];
      const confirm = dialogs.find(
        (d) => d.querySelector("h2")?.textContent === "仍要重新检查？",
      );
      const d = dialogs.find((x) => x !== confirm) ?? sheet;
      const r = d?.getBoundingClientRect();
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        drawer: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null,
        drawerScrollWidth: d?.scrollWidth,
        drawerClientWidth: d?.clientWidth,
        innerOverflow: d
          ? [...d.querySelectorAll("*")]
              .filter((e) => e.getBoundingClientRect().right > r.right + 0.5)
              .slice(0, 5)
              .map(box)
          : [],
        title: box(d?.querySelector("h2")),
        actions: [...(d?.querySelectorAll(".drawer-actions button") ?? [])].map(
          (b) => ({
            ...box(b),
            label: b.getAttribute("aria-label") ?? b.textContent.trim(),
            ariaDisabled: b.getAttribute("aria-disabled"),
          }),
        ),
        feedback: [...document.querySelectorAll(".request-feedback")]
          .filter((t) => t.textContent.trim())
          .map((t) => ({ ...box(t), role: t.getAttribute("role") })),
        confirm: confirm
          ? {
              box: box(confirm),
              title: box(confirm.querySelector("h2")),
              description: box(confirm.querySelector("p")),
              buttons: [...confirm.querySelectorAll("button")].map(box),
            }
          : null,
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
      await open(
        "/#/p/p-1/cards?view=list",
        "!!document.querySelector('table, .card-list')",
        theme,
      );
      const cards = await shot(`cards-${suffix}`);
      const scene = async (name) => {
        await settle();
        const data = await shot(`${name}-${suffix}`);
        results[name] = await measure();
        pairs.push({ name, width, theme, left: cards, right: data });
      };
      // Drawer before any write (unchanged reference).
      await drawer("lost", theme);
      await scene("drawer");
      // Lost check reply.
      await click("[role=dialog]", "立即检查");
      // A baseline before Q-1048 says the check did not start.
      await until(`${has("检查没有开始")} || ${has("上次检查请求结果未知")}`);
      await scene("lost-check");
      if (await evaluate(has("仍要重新检查"))) {
        await click("[role=dialog]", "仍要重新检查");
        await until(
          has("上次请求结果未知，再次检查可能让这台机器多检查一次。"),
        );
        await scene("confirm-again");
      }
      // Lost drain reply, still at the old state.
      await drawer("lost", theme);
      await click("[role=dialog]", "排空");
      await until(`${has("未能排空")} || ${has("排空结果未知")}`);
      await scene("lost-drain");
      // Lost check reply beside another project's running check.
      await drawer("running", theme);
      await click("[role=dialog]", "立即检查");
      await until(`${has("正在检查：SSH")} || ${has("这台机器正在检查：SSH")}`);
      await scene("lost-running");
      // Q-1076: B followed in a reopened drawer, then A's late start reply.
      for (const [name, fail] of [
        ["stale-reply", false],
        ["verify-failed", true],
      ]) {
        await drawer("stale", theme);
        await click("[role=dialog]", "立即检查");
        await run(() => {
          window.__c511.b = true;
        });
        await click("[role=dialog]", "关闭抽屉");
        await until("!document.querySelector('[role=dialog]')");
        await click("table[aria-label='机器列表']", "本机");
        await until(has("正在检查：SSH"));
        await run((fail) => {
          window.__c511.fail = fail;
          window.__c511.releaseA();
        }, fail);
        if (fail && !baseline) await until(has("未能确认正在进行的检查"));
        else await delay(400);
        await scene(name);
      }
      // Q-1083 R4: A seen passed in a reopened drawer, then its late reply.
      await drawer("r4", theme);
      await click("[role=dialog]", "立即检查");
      await run(() => {
        window.__c511.aDone = true;
      });
      await click("[role=dialog]", "关闭抽屉");
      await until("!document.querySelector('[role=dialog]')");
      await click("table[aria-label='机器列表']", "本机");
      await until(has("项目绑定"));
      await run(() => window.__c511.releaseA());
      await until(`${has("检查通过")} || ${has("未能读取检查进度")}`);
      await scene("r4-late-reply");
      // Q-1083 P1: A fails, the reread takes up B.
      await drawer("p1", theme);
      await click("[role=dialog]", "立即检查");
      await run(() => {
        window.__c511.b = true;
      });
      // Before Q-1083 A's failure covers B's progress, so wait for either.
      await until(`${has("正在检查：MCP")} || ${has("检查未通过：SSH")}`);
      await delay(1500);
      await scene("p1-next-check");
      // Q-1085 (attachment-8243): A, then B; A fails; B passes; A's reply.
      const reopenDrawer = async () => {
        await click("[role=dialog]", "关闭抽屉");
        await until("!document.querySelector('[role=dialog]')");
        await click("table[aria-label='机器列表']", "本机");
        await until(has("项目绑定"));
      };
      await drawer("p1c", theme);
      await click("[role=dialog]", "立即检查");
      await run(() => {
        window.__c511.read = "a";
      });
      await reopenDrawer();
      await until(has("正在检查：SSH"));
      await delay(1500); // A's progress read is out (poll interval 1 s)
      await run(() => {
        window.__c511.read = "b";
      });
      await reopenDrawer();
      await until(has("正在检查：MCP"));
      await delay(1500); // B's progress read is out too
      await run(() => window.__c511.failA());
      await delay(300);
      await run(() => {
        window.__c511.read = "bdone";
        window.__c511.passB();
      });
      await delay(1500);
      await run(() => window.__c511.releaseA());
      await until(`${has("检查未通过：SSH")} || ${has("检查通过")}`);
      await delay(400);
      await scene("p1c-late-answer");
      cases.push({ width, theme, results });
    }
  await send("Emulation.setDeviceMetricsOverride", {
    width: 2 * 1440 + 16,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: "about:blank" });
  await until("location.href === 'about:blank'");
  const images = (fn, ...args) =>
    run(
      async (fn, ...args) => {
        const load = (src) =>
          new Promise((r) => {
            const img = new Image();
            img.onload = () => r(img);
            img.src = `data:image/png;base64,${src}`;
          });
        const imgs = await Promise.all(args.slice(0, 2).map(load));
        return new Function("imgs", "extra", fn)(imgs, args[2]);
      },
      fn,
      ...args,
    );
  for (const { name, width, theme, left, right } of pairs) {
    const png = await images(
      `const [l, r] = imgs; const c = document.createElement("canvas");
       c.width = extra * 2 + 16; c.height = Math.max(l.height, r.height);
       const x = c.getContext("2d"); x.fillStyle = "#888"; x.fillRect(0, 0, c.width, c.height);
       x.drawImage(l, 0, 0); x.drawImage(r, extra + 16, 0);
       return c.toDataURL("image/png").split(",")[1];`,
      left,
      right,
      width,
    );
    await writeFile(
      resolve(output, `side-by-side-cards-${name}-${width}-${theme}.png`),
      Buffer.from(png, "base64"),
    );
  }
  const diffs = {};
  if (before)
    for (const name of Object.keys(shots)) {
      let old;
      try {
        old = (await readFile(resolve(before, name))).toString("base64");
      } catch {
        diffs[name] = "new scene";
        continue;
      }
      diffs[name] = await images(
        `const [a, b] = imgs; if (a.width !== b.width || a.height !== b.height) return "size";
         const px = (img) => { const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
           const x = c.getContext("2d"); x.drawImage(img, 0, 0); return x.getImageData(0, 0, img.width, img.height).data; };
         const [p, q] = [px(a), px(b)]; let n = 0;
         for (let i = 0; i < p.length; i += 4) if (p[i] !== q[i] || p[i+1] !== q[i+1] || p[i+2] !== q[i+2] || p[i+3] !== q[i+3]) n++;
         return n;`,
        old,
        shots[name],
      );
    }
  assert.deepEqual(browser.errors, []);
  for (const { results } of cases)
    for (const [name, m] of Object.entries(results)) {
      assert(m.scrollWidth <= m.innerWidth, `${name}: page overflows`);
      assert.deepEqual(m.innerOverflow, [], `${name}: drawer overflows`);
    }
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
      "test-support/c511-unknown-fixture.tsx: src/testing/machines-fixture.ts (3 synthetic machines, 2 projects), one capacity record, settings-panels-data.ts; every machine write reply lost in the page (TypeError); fixed clock 2026-01-01T00:00Z; no backend, host or production data, not production scale",
    cases,
    pixelDiffAgainstBefore: before ? diffs : null,
  };
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    `C-511 Q-1048 ${report.stage}: ${Object.keys(shots).length} shots`,
  );
} finally {
  await browser?.close();
  await server.close();
}
