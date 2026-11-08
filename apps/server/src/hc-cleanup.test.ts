import { expect, test } from "vitest";
import { runCleanupSteps } from "../test-support/hc.js";

test("cleanup runs every step and reports all failures with the session and socket", async () => {
  const ran: string[] = [];
  await expect(
    runCleanupSteps({
      session: "fixture-session",
      socket: "/tmp/fixture.sock",
      steps: [
        {
          label: "stop herdr-core",
          run: () => {
            ran.push("stop");
            throw new Error("core still alive");
          },
        },
        {
          label: "close server",
          run: () => {
            ran.push("server");
            throw new Error("server busy");
          },
        },
        {
          label: "remove temporary directory",
          run: () => {
            ran.push("remove");
          },
        },
      ],
    }),
  ).rejects.toThrow(
    /Cleanup failed for herdr session fixture-session \(socket \/tmp\/fixture\.sock\):\n- stop herdr-core: core still alive\n- close server: server busy/,
  );
  expect(ran).toEqual(["stop", "server", "remove"]);
});
