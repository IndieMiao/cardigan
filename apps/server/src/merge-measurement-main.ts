import { executionOwner } from "@cardigan/host";
import {
  createOfflineMeasurement,
  measurementArtifactDigest,
  wireMeasurementSignals,
} from "./merge-measurement.js";

// A separate executable: importing server/index/bin would start unrelated loops.
const args = process.argv.slice(2);
if (
  args.length < 1 ||
  args[0] !== "--offline-demo" ||
  args.length > 3 ||
  (args[1] !== undefined && !["1", "2", "3"].includes(args[1])) ||
  (args[2] !== undefined && args[2] !== "--hold")
) {
  process.stderr.write(
    "Use --offline-demo [1|2|3] [--hold]. Real execution refused: approved candidates, original target/lock binding and check drain/fence are not available.\n",
  );
  process.exitCode = 2;
} else {
  const slots = Number(args[1] ?? "1") as 1 | 2 | 3;
  const session = await createOfflineMeasurement({
    slots,
    hold: args[2] === "--hold",
    onNotice: (message) => process.stderr.write(`${message}\n`),
  });
  const detach = wireMeasurementSignals(() => session.stop());
  process.stdout.write(
    `${JSON.stringify({
      mode: "offline-only",
      pid: process.pid,
      owner: executionOwner(process.pid),
      artifact_sha256: await measurementArtifactDigest(),
      evidence: session.root,
      manifest_sha256: session.manifestSha256,
    })}\n`,
  );
  try {
    await session.start();
    const report = await session.close();
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report?.exit_code ?? 1;
  } finally {
    detach();
  }
}
