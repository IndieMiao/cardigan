import { spawn } from "node:child_process";
import { once } from "node:events";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";

// A single-file synthetic storage backend for the orchestration test. The
// retained writer really has a writable FD; the kernel, not the mock Runtime,
// decides whether a late write lands. This isn't an ext4 hardware test.
export async function syntheticSealedVolume() {
  const storage = spawn("python3", [
    "-IB",
    "-c",
    `
import fcntl, os, sys
fd = os.memfd_create('fixture', os.MFD_ALLOW_SEALING)
os.write(fd, b'original')
print(f'/proc/{os.getpid()}/fd/{fd}', flush=True)
if sys.stdin.readline() == 'seal\\n':
    fcntl.fcntl(fd, fcntl.F_ADD_SEALS, fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL)
    print('sealed', flush=True)
sys.stdin.read()
`,
  ]);
  const exit = once(storage, "exit");
  const lines = createInterface({ input: storage.stdout })[
    Symbol.asyncIterator
  ]();
  try {
    const writer = await open((await lines.next()).value, "r+");
    return {
      async seal() {
        storage.stdin.write("seal\n");
        if ((await lines.next()).value !== "sealed")
          throw new Error("fixture did not seal");
      },
      write: () => writer.write("late", 0),
      async close() {
        storage.stdin.end();
        await writer.close();
        await exit;
      },
    };
  } catch (error) {
    storage.stdin.end();
    await exit;
    throw error;
  }
}
