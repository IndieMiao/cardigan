import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { chromium } from "./chromium.mjs";

async function logoutSession(origin, cookie) {
  let response;
  try {
    response = await fetch(`${origin}/api/logout`, {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body: "{}",
    });
  } catch {
    // Do not print transport errors: they may contain request credentials.
    throw new Error(
      "Workbench session cleanup failed (network error); the session may still be active.",
    );
  }
  if (!response.ok)
    throw new Error(
      `Workbench session cleanup failed (HTTP ${response.status}); the session may still be active.`,
    );
}

const { values } = parseArgs({
  options: {
    local: { type: "boolean" },
    url: { type: "string" },
    project: { type: "string" },
    samples: { type: "string", default: "3" },
    latency: { type: "string", default: "0" },
    kbps: { type: "string", default: "0" },
    json: { type: "string" },
  },
});
const samples = Number(values.samples);
if (!Number.isInteger(samples) || samples < 1 || samples > 10)
  throw new Error("samples must be between 1 and 10");
if (!values.local && (!values.url || !values.project))
  throw new Error("Use --local or --url <origin> --project <id>");
for (const name of ["latency", "kbps"])
  if (!Number.isFinite(Number(values[name])) || Number(values[name]) < 0)
    throw new Error(`${name} must be a nonnegative number`);
const fixture = values.local
  ? await (
      await import("../../server/test-support/load-fixture.mjs")
    ).loadFixture()
  : undefined;
const origin = new URL(fixture?.url ?? values.url).origin;
const project = fixture?.project ?? values.project;
let browser;
let remoteCookie;
const reports = [];
try {
  browser = await chromium();
  await browser.send("Network.enable");
  if (fixture) {
    await browser.send("Network.setCookie", {
      name: "cardigan_session",
      value: fixture.token,
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
    });
  } else {
    // Read credentials only from the caller's environment; never print them.
    const password = process.env.WORKBENCH_PASSWORD;
    if (!password) throw new Error("Set WORKBENCH_PASSWORD for remote login");
    const response = await fetch(`${origin}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) throw new Error(`Login failed (${response.status})`);
    const cookie = response.headers.getSetCookie()[0]?.split(";")[0];
    if (!cookie) throw new Error("Login did not return a session");
    remoteCookie = cookie;
    const index = cookie.indexOf("=");
    await browser.send("Network.setCookie", {
      name: cookie.slice(0, index),
      value: cookie.slice(index + 1),
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
      secure: origin.startsWith("https:"),
    });
  }
  await browser.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const latency = Number(values.latency),
    kbps = Number(values.kbps);
  if (latency || kbps)
    await browser.send("Network.emulateNetworkConditions", {
      offline: false,
      latency,
      downloadThroughput: kbps ? (kbps * 1000) / 8 : -1,
      uploadThroughput: kbps ? (kbps * 1000) / 8 : -1,
    });
  await browser.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
    performance.setResourceTimingBufferSize(2000);
    window.loadMetrics = { sse: [] };
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(...args) {
        const start = performance.now();
        super(...args);
        this.addEventListener('open', () => window.loadMetrics.sse.push({
          start, duration: performance.now() - start
        }));
      }
    };
    const observer = new MutationObserver(() => {
      const board = document.querySelector('.board[aria-label="看板"]');
      const search = document.querySelector('input[type="search"]');
      if (!board || !search) return;
      observer.disconnect();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        search.focus();
        window.loadMetrics.ready = performance.now();
        window.loadMetrics.focused = document.activeElement === search;
      }));
    });
    observer.observe(document, { childList: true, subtree: true });
  `,
  });
  for (let sample = 1; sample <= samples; sample++) {
    for (const cache of ["cold", "warm"]) {
      await browser.send("Page.navigate", { url: "about:blank" });
      if (cache === "cold") await browser.send("Network.clearBrowserCache");
      await browser.send("Page.navigate", {
        url: `${origin}/#/p/${encodeURIComponent(project)}/cards`,
      });
      const result = await browser.evaluate(`new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { clearInterval(timer); reject(new Error('Board/SSE did not become ready')); }, 25000);
        const timer = setInterval(async () => {
          if (!window.loadMetrics?.ready || !window.loadMetrics.sse.length) return;
          clearInterval(timer);
          await document.fonts.ready;
          clearTimeout(timeout);
          resolve({ ...window.loadMetrics, fontsReady: performance.now(),
            paints: performance.getEntriesByType('paint').map(p => ({ name: p.name, start: p.startTime })),
            resources: performance.getEntriesByType('resource').map(r => ({
              path: new URL(r.name).pathname, start: r.startTime,
              ms: r.duration, bytes: r.encodedBodySize, transfer: r.transferSize,
              decoded: r.decodedBodySize, initiator: r.initiatorType,
              status: r.responseStatus
            }))
          });
        }, 50);
      })`);
      if (
        !result.focused ||
        browser.errors.length ||
        result.resources.some((r) => r.status >= 400)
      )
        throw new Error("Page failed; inspect the selected origin and project");
      reports.push({ sample, cache, ...result });
    }
  }
  const median = (values) => {
    const sorted = values.toSorted((a, b) => a - b);
    return +(sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(1);
  };
  const rows = [];
  for (const cache of ["cold", "warm"]) {
    const group = reports.filter((r) => r.cache === cache);
    for (const [name, pick] of [
      ["board interactive", (r) => r.ready],
      ["fonts ready", (r) => r.fontsReady],
      ["SSE open", (r) => r.sse[0].duration],
    ])
      rows.push({ cache, resource: name, ms: median(group.map(pick)) });
    const resources = group
      .flatMap((r) => r.resources)
      .filter(
        (r) => /\.(js|css|woff2?)$/.test(r.path) || r.path.startsWith("/api/"),
      );
    for (const path of new Set(resources.map((r) => r.path))) {
      const requests = resources.filter((r) => r.path === path);
      rows.push({
        cache,
        resource: path,
        calls_per_load: +(requests.length / samples).toFixed(1),
        ms: median(requests.map((r) => r.ms)),
        body_B: median(requests.map((r) => r.bytes)),
        transfer_B_per_load: Math.round(
          requests.reduce((sum, r) => sum + r.transfer, 0) / samples,
        ),
      });
    }
  }
  const result = {
    mode: fixture ? "synthetic-local" : "remote",
    latency: Number(values.latency),
    kbps: Number(values.kbps),
    reports,
  };
  console.log(
    `${result.mode}; ${samples} samples; median ms; latency ${result.latency} ms; ${result.kbps || "unlimited"} kbps`,
  );
  console.table(rows);
  if (values.json)
    await writeFile(values.json, `${JSON.stringify(result, null, 2)}\n`);
} finally {
  try {
    await browser?.close();
  } finally {
    try {
      if (remoteCookie) await logoutSession(origin, remoteCookie);
    } finally {
      await fixture?.close();
    }
  }
}
