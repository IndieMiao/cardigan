async (page) => {
  const base = "http://127.0.0.1:5411/docs/design/c411/index.html";
  const checks = [];
  for (const variant of ["a", "b"])
    for (const theme of ["light", "dark"])
      for (const width of [1440, 390])
        for (const view of ["board", "list", "detail"]) {
          await page.setViewportSize({
            width,
            height: width === 1440 ? 900 : 844,
          });
          await page.emulateMedia({ colorScheme: theme });
          await page.goto(
            `${base}?variant=${variant}&theme=${theme}&view=${view}`,
          );
          const marker = page.locator(".template-marker").first();
          const label = await marker.getAttribute("aria-label");
          await marker.hover();
          await page
            .getByRole("tooltip", { name: label, exact: true })
            .waitFor();
          await page.mouse.move(0, 0);
          await marker.focus();
          await page.keyboard.press("Tab");
          await page.keyboard.press("Shift+Tab");
          const focus = await marker.evaluate((e) => ({
            visible: e.matches(":focus-visible"),
            outline: getComputedStyle(e).outlineWidth,
            offset: getComputedStyle(e).outlineOffset,
          }));
          await page
            .getByRole("tooltip", { name: label, exact: true })
            .waitFor();
          await page.keyboard.press("Escape");
          if (await page.getByRole("tooltip").count())
            throw Error("Escape did not close");
          const url = page.url();
          await page.keyboard.press("Enter");
          await page
            .getByRole("tooltip", { name: label, exact: true })
            .waitFor();
          if (page.url() !== url) throw Error("Marker navigated");
          await page.locator("h1").click();
          if (await page.getByRole("tooltip").count())
            throw Error("Outside did not close");
          await marker.dispatchEvent("pointerdown", {
            pointerType: "touch",
            bubbles: true,
          });
          await marker.click();
          await page
            .getByRole("tooltip", { name: label, exact: true })
            .waitFor();
          const rect = await page.getByRole("tooltip").boundingBox();
          if (rect.x < 0 || rect.x + rect.width > width || !focus.visible)
            throw Error("Focus or tooltip geometry failed");
          checks.push({
            variant,
            theme,
            width,
            view,
            label,
            focus,
            hover: true,
            escape: true,
            enter: true,
            outside: true,
            pointerSimulation: true,
            tooltip: rect,
          });
        }
  for (const variant of ["a", "b"])
    for (const card of [0, 1, 8, 9]) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.goto(
        `${base}?variant=${variant}&theme=dark&view=detail&card=${card}`,
      );
      const marker = page.locator(".template-marker");
      await marker.click();
      const tip = await page.getByRole("tooltip").boundingBox();
      if (tip.x < 0 || tip.x + tip.width > 390)
        throw Error("Long tooltip overflow");
      await page.screenshot({
        path: `__OUTPUT__/${variant}-dark-390-detail-${card}-tip.png`,
        scale: "css",
      });
      checks.push({
        variant,
        card,
        edge: true,
        tooltip: tip,
        label: await marker.getAttribute("aria-label"),
      });
    }
  return { checks, physicalTouch: false, screenReader: false };
};
