// C-531 evidence: run-ring avatars on the board, a card's work items and the
// execution view. Synthetic fixture only; prints where it wrote its files.
// Usage: CHROMIUM_PATH=... node test-support/c531-capture.mjs <output-dir>
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "c531-evidence");
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c531-fixture",
      enforce: "pre",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c531")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c531",
              `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c531-fixture.tsx"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
const routes = {
  board: "cards?view=board",
  detail: "cards/C-2",
  execution: "execution",
};
const results = [];
let browser;
try {
  await mkdir(output, { recursive: true });
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
  const version = await send("Browser.getVersion");
  const run = (fn, ...args) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const until = async (expression) => {
    const end = Date.now() + 20000;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(50);
    }
  };
  const settle = () =>
    run(async () => {
      document.activeElement?.blur();
      window.scrollTo(0, 0);
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
    });
  // Pin every running orbit to the same moment so captures are repeatable.
  const seek = (ms) =>
    run((ms) => {
      for (const a of document.getAnimations()) {
        a.pause();
        a.currentTime = ms;
      }
    }, ms);
  const open = async (mode, width, theme, motion = "no-preference", forced) => {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-color-scheme", value: theme },
        { name: "prefers-reduced-motion", value: motion },
        { name: "forced-colors", value: forced ? "active" : "none" },
      ],
    });
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c531#/p/p-1/${routes[mode]}`,
    });
    await until(
      mode === "board"
        ? "document.querySelectorAll('.board-card').length === 7"
        : mode === "detail"
          ? "!!document.querySelector('.work-item')"
          : "!!document.querySelector('.execution-row, .execution-card')",
    );
    await evaluate("document.fonts.ready.then(() => true)");
    if (mode === "detail") {
      await run(() =>
        [...document.querySelectorAll("button, [role=tab], a")]
          .find((e) => e.textContent.trim().startsWith("工作项"))
          .click(),
      );
      await until(
        "!!document.querySelector('.work-item')?.getClientRects().length",
      );
    }
    if (mode === "detail")
      await run(() => {
        for (const d of document.querySelectorAll(".work-item details"))
          d.open = true;
        document.querySelector(".work-item")?.scrollIntoView();
      });
    await settle();
    await delay(250);
  };
  const measure = () =>
    run(() => {
      const box = (e) => {
        const r = e.getBoundingClientRect();
        return {
          x: +r.x.toFixed(2),
          y: +r.y.toFixed(2),
          w: +r.width.toFixed(2),
          h: +r.height.toFixed(2),
        };
      };
      const names = [
        ...document.querySelectorAll(
          ".employee-owners > *, .work-item .employee-trigger, .execution-employee .employee-trigger, .execution-card-head .employee-trigger",
        ),
      ]
        .filter((e) => e.getClientRects().length)
        .map((e) => {
          const label = e.getAttribute("aria-labelledby");
          return label
            ? document.getElementById(label)?.textContent
            : e.getAttribute("aria-label");
        });
      const rings = [...document.querySelectorAll("[data-run]")]
        .filter((e) => e.getClientRects().length)
        .map((e) => ({
          state: e.dataset.run,
          slot: box(e),
          face: box(e.querySelector(".employee-avatar")),
          track: getComputedStyle(e.firstElementChild, "::before")
            .borderTopColor,
          trackWidth: getComputedStyle(e.firstElementChild, "::before")
            .borderTopWidth,
          dash: getComputedStyle(e.firstElementChild).borderTopStyle,
          dashColor: getComputedStyle(e.firstElementChild).borderTopColor,
          arc: getComputedStyle(e.firstElementChild, "::after").display,
        }));
      const owners = [
        ...document.querySelectorAll(".board-card .employee-owners"),
      ]
        .filter((e) => e.getClientRects().length)
        .map((e) => ({
          group: box(e),
          slots: [...e.children].map(box),
        }));
      const meta = [...document.querySelectorAll(".board-card-meta")].map(
        (e) => box(e).h,
      );
      // C-531: expanded work items — item tops and each paragraph's height.
      const workItems = [...document.querySelectorAll(".work-item")]
        .filter((e) => e.getClientRects().length)
        .map((e) => ({
          id: e.id,
          top: box(e).y,
          h: box(e).h,
          lines: [...e.querySelectorAll("details > p")].map((p) => box(p).h),
          // Same paragraphs with the owner box hidden: the row without it.
          bare: [...e.querySelectorAll("details > p")].map((p) => {
            const owner = p.firstElementChild?.querySelector(
              ".employee-identity",
            )
              ? p.firstElementChild
              : null;
            if (owner) owner.style.display = "none";
            const h = box(p).h;
            if (owner) owner.style.display = "";
            return h;
          }),
        }));
      const badge = document.querySelector(".board-card-badge");
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        cards: [...document.querySelectorAll(".board-card")].map((e) => box(e)),
        meta,
        badge: badge && {
          font: getComputedStyle(badge).fontSize,
          line: getComputedStyle(badge).lineHeight,
        },
        owners,
        rings,
        workItems,
        names,
        animations: document
          .getAnimations()
          .map((a) => `${a.animationName}@${a.effect?.pseudoElement ?? ""}`),
        willChange: [...document.querySelectorAll("*")].filter(
          (e) => getComputedStyle(e).willChange !== "auto",
        ).length,
      };
    });
  const shot = async (name, clip) => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      ...(clip ? { clip } : {}),
    });
    await writeFile(resolve(output, name), Buffer.from(data, "base64"));
  };

  for (const mode of ["board", "detail", "execution"])
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"]) {
        await open(mode, width, theme);
        await seek(600);
        const name = `${mode}-${width}-${theme}.png`;
        const metrics = await measure();
        assert(!metrics.overflow, `${name}: page overflows`);
        await shot(name);
        results.push({ name, ...metrics });
        console.log(`Captured ${name}`);
      }

  // Narrow board: scroll the lanes (not the page) to the ringed cards.
  for (const theme of ["light", "dark"]) {
    await open("board", 390, theme);
    await run(() => {
      const card = document.querySelectorAll(".board-card")[2];
      const lanes = card.closest(".board-card").parentElement;
      let scroller = lanes;
      while (scroller && scroller.scrollWidth <= scroller.clientWidth)
        scroller = scroller.parentElement;
      scroller.scrollLeft +=
        card.getBoundingClientRect().left -
        scroller.getBoundingClientRect().left -
        12;
    });
    await seek(600);
    const name = `board-390-${theme}-lane.png`;
    const metrics = await measure();
    assert(!metrics.overflow, `${name}: page overflows`);
    await shot(name);
    results.push({ name, ...metrics });
    console.log(`Captured ${name}`);
  }

  // Fallbacks: system reduced motion and forced colors stop the orbit.
  for (const [name, motion, forced] of [
    ["board-1440-light-reduced.png", "reduce", false],
    ["board-1440-dark-reduced.png", "reduce", false],
    ["board-1440-light-forced.png", "no-preference", true],
  ]) {
    await open(
      "board",
      1440,
      name.includes("dark") ? "dark" : "light",
      motion,
      forced,
    );
    const metrics = await measure();
    await shot(name);
    results.push({ name, ...metrics });
    console.log(`Captured ${name}`);
  }

  // Hover: the profile card shows the same "姓名，状态" string.
  await open("board", 1440, "light");
  await seek(600);
  const target = await run(() => {
    const e = document.querySelector("[data-run=running]").closest("button");
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...target });
  await until("!!document.querySelector('.employee-card')");
  await delay(200);
  const hover = await run(() =>
    [...document.querySelectorAll(".employee-card p")].map(
      (p) => p.textContent,
    ),
  );
  await shot("board-1440-light-hover.png");
  results.push({ name: "board-1440-light-hover.png", hover });
  console.log("Captured board-1440-light-hover.png");

  // Recording: the real CSS animation, seeked frame by frame (10 fps, 2.8 s),
  // then a free-running check that it advances without any script.
  for (const theme of ["light", "dark"]) {
    await open("board", 1440, theme);
    const clip = await run(() => {
      const r = document
        .querySelector("[data-run=running]")
        .closest(".employee-owners")
        .getBoundingClientRect();
      return {
        x: r.x - 6,
        y: r.y - 6,
        width: r.width + 12,
        height: r.height + 12,
      };
    });
    await mkdir(resolve(output, `frames-${theme}`), { recursive: true });
    for (let i = 0; i < 28; i++) {
      await seek(i * 100);
      await shot(`frames-${theme}/${String(i).padStart(2, "0")}.png`, {
        ...clip,
        scale: 8,
      });
    }
  }
  await open("board", 1440, "light");
  const free = [];
  for (let i = 0; i < 3; i++) {
    free.push(
      await run(() => {
        const e = document.querySelector("[data-run=running] > span");
        return [
          Math.round(performance.now()),
          getComputedStyle(e, "::after").transform,
        ];
      }),
    );
    await delay(400);
  }
  results.push({ name: "free-running", samples: free });
  assert.deepEqual(browser.errors, []);
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify({ browser: version, cases: results }, null, 2)}\n`,
  );
  console.log(`Wrote ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
