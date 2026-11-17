async (page) => {
  const dir = "__OUTPUT__";
  const base = "http://127.0.0.1:5411/docs/design/c411/index.html";
  const results = [];
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  for (const variant of ["before", "a", "b"]) {
    for (const theme of ["light", "dark"]) {
      for (const width of [1440, 390]) {
        await page.setViewportSize({
          width,
          height: width === 1440 ? 900 : 844,
        });
        await page.emulateMedia({ colorScheme: theme });
        for (const view of [
          "board",
          "list",
          "detail",
          ...(variant === "before" ? [] : ["legend"]),
        ]) {
          const name = `${variant}-${theme}-${width}-${view}`;
          await page.goto(
            `${base}?variant=${variant}&theme=${theme}&view=${view}`,
          );
          await page.locator("main").waitFor();
          await page.evaluate(async () => {
            await document.fonts.ready;
          });
          await page.screenshot({ path: `${dir}/${name}.png`, scale: "css" });
          const measure = await page.evaluate(() => {
            const box = (e) => {
              const r = e.getBoundingClientRect();
              return { x: r.x, y: r.y, w: r.width, h: r.height };
            };
            const style = getComputedStyle(document.documentElement);
            const marks = [...document.querySelectorAll(".template-marker")];
            return {
              viewport: [innerWidth, innerHeight],
              documentWidth: document.documentElement.scrollWidth,
              markers: marks.map((e) => ({
                name: e.getAttribute("aria-label"),
                ...box(e),
                visual: box(e.querySelector(".marker-ink")),
                glyph: box(e.querySelector("svg")),
                color: getComputedStyle(e).color,
              })),
              nestedInteractive:
                document.querySelectorAll("a button, button a").length,
              bodyColor: getComputedStyle(document.body).color,
              tokens: Object.fromEntries(
                [
                  "--text",
                  "--text-muted",
                  "--surface",
                  "--bg",
                  "--focus",
                  "--template-ink",
                  "--surface-muted",
                  "--id-card-fg",
                  "--id-card-bg",
                ].map((k) => [k, style.getPropertyValue(k).trim()]),
              ),
              cards: [...document.querySelectorAll(".board-card")].map(box),
              rows: [...document.querySelectorAll(".design-row")].map(box),
              header: box(document.querySelector(".study-header")),
              title: document.querySelector(".detail-title")
                ? box(document.querySelector(".detail-title"))
                : null,
              fontLoaded: [...document.fonts].some(
                (f) =>
                  f.family === "Noto Sans SC Variable" && f.status === "loaded",
              ),
            };
          });
          if (
            measure.documentWidth > width ||
            measure.nestedInteractive ||
            measure.markers.some((m) => m.w < 44 || m.h < 44)
          )
            throw new Error(`Geometry failed: ${name}`);
          results.push({ name, ...measure });
          if (view === "list" || view === "legend")
            await page.screenshot({
              path: `${dir}/${name}-full.png`,
              fullPage: true,
              scale: "css",
            });
          if (view === "board") {
            await page.locator(".design-board").evaluate((e) => {
              e.scrollLeft = e.scrollWidth;
            });
            await page.screenshot({
              path: `${dir}/${name}-end.png`,
              scale: "css",
            });
          }
        }
      }
    }
  }
  return {
    source:
      "C-411 fixed synthetic fixture; seed c411-template-v1; 10 cards, non-production scale",
    results,
    errors,
  };
};
