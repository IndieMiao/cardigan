import { createReadStream, writeFileSync, writeSync } from "node:fs";

// CDP pipe stub for interrupt tests: navigation never completes, without CPU work.
process.on("SIGTERM", () => {
  writeFileSync(process.env.LOAD_TEST_CLOSED, "closed");
  process.exit(0);
});
const input = createReadStream("", { fd: 3, autoClose: false });
// If a regression kills the owner before cleanup, do not leave the stub alive.
input.on("end", () => process.exit(0));
input.setEncoding("utf8");
let buffer = "";
input.on("data", (data) => {
  buffer += data;
  while (buffer.includes("\0")) {
    const end = buffer.indexOf("\0");
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.method === "Runtime.evaluate") {
      writeFileSync(process.env.LOAD_TEST_READY, "ready");
      if (process.env.LOAD_TEST_COMPLETE === "1")
        writeSync(
          4,
          `${JSON.stringify({
            id: message.id,
            result: {
              result: {
                value: {
                  ready: 10,
                  focused: true,
                  fontsReady: 12,
                  sse: [{ duration: 2 }],
                  resources: [],
                },
              },
            },
          })}\0`,
        );
      continue;
    }
    const result =
      message.method === "Target.createTarget"
        ? { targetId: "fixture" }
        : message.method === "Target.attachToTarget"
          ? { sessionId: "fixture" }
          : {};
    writeSync(4, `${JSON.stringify({ id: message.id, result })}\0`);
  }
});
