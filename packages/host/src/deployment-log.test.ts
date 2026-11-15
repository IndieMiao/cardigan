import { expect, test } from "vitest";
import { DeploymentBuildLog, DeploymentServerReady } from "./deployment-log.js";

test("build summaries never forward secrets, environment dumps, paths or arbitrary log text", () => {
  const log = new DeploymentBuildLog();
  const secret = "private-value-can-cross-chunks";
  const text = `PATH=/private/bin\nTOKEN=${secret}\nAuthorization: Bearer ${secret}\n-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----\n/private/${secret}.ts(1): error TS6305: ${secret}\n`;
  for (let i = 0; i < text.length; i += 7) log.append(text.slice(i, i + 7));
  expect(log.finish("build", 1)).toBe("TypeScript TS6305\nbuild: exit 1");
});

test("only the last 20 diagnostic codes survive chunk boundaries and an unterminated line", () => {
  const log = new DeploymentBuildLog();
  const text = [
    "error TS123: ignored; error TS123456: ignored",
    ...Array.from(
      { length: 25 },
      (_, i) => `TOKEN=synthetic-${i} error TS${10000 + i}: private text`,
    ),
  ].join("\r\n");
  for (let i = 0; i < text.length; i += 3) log.append(text.slice(i, i + 3));
  expect(log.finish("install", null)).toBe(
    [
      ...Array.from({ length: 20 }, (_, i) => `TypeScript TS${10005 + i}`),
      "install: exit unknown",
    ].join("\n"),
  );
});

const ready = JSON.stringify({
  ready: true,
  deployment_fence: 1,
  url: "http://127.0.0.1:3004",
  web_url: "http://localhost:7781",
});
test("ready survives large chunks, split records and oversized surrounding lines", () => {
  const parser = new DeploymentServerReady([3004, 7781]);
  expect(
    parser.append(Buffer.from(`${ready}\n${"noise".repeat(20000)}\n`)),
  ).toBe(true);
  expect(parser.append(Buffer.from("x".repeat(100000)))).toBe(false);
  expect(parser.append(Buffer.from(`${ready}\n`))).toBe(false); // Part of the oversized line.
  expect(parser.append(Buffer.from(ready.slice(0, 20)))).toBe(false);
  expect(parser.append(Buffer.from(`${ready.slice(20)}\n`))).toBe(true);
  expect(parser.append(Buffer.from(`${ready.replace("3004", "3005")}\n`))).toBe(
    false,
  );
  expect(
    parser.append(
      Buffer.from(
        `${ready.replace('"deployment_fence":1', '"deployment_fence":0')}\n`,
      ),
    ),
  ).toBe(false);
});

test("dual readiness requires the matching role and protocol; background needs no listener", () => {
  const web = new DeploymentServerReady([3004, 7781], "web");
  const background = new DeploymentServerReady([3004, 7781], "background");
  const webReady = { ...JSON.parse(ready), deployment_fence: 2, role: "web" };
  const bgReady = { ready: true, deployment_fence: 2, role: "background" };
  const append = (parser: DeploymentServerReady, data: unknown) =>
    parser.append(Buffer.from(`${JSON.stringify(data)}\n`));
  expect(append(web, JSON.parse(ready))).toBe(false);
  expect(append(web, bgReady)).toBe(false);
  expect(append(background, webReady)).toBe(false);
  expect(append(background, { ...bgReady, deployment_fence: 1 })).toBe(false);
  expect(
    append(web, { ...webReady, web_url: "http://example.invalid:7781" }),
  ).toBe(false);
  expect(append(web, webReady)).toBe(true);
  expect(append(background, bgReady)).toBe(true);
});
