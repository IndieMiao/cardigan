import { expect, test } from "vitest";
import { DeploymentBuildLog } from "./deployment-log.js";

test("build summaries never forward secrets, environment dumps, paths or arbitrary log text", () => {
  const log = new DeploymentBuildLog();
  const secret = "private-value-can-cross-chunks";
  const text = `PATH=/private/bin\nTOKEN=${secret}\nAuthorization: Bearer ${secret}\n-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----\n/private/${secret}.ts(1): error TS6305: ${secret}\n`;
  for (let i = 0; i < text.length; i += 7) log.append(text.slice(i, i + 7));
  expect(log.finish("build", 1)).toBe("TypeScript TS6305\nbuild: exit 1");
});
