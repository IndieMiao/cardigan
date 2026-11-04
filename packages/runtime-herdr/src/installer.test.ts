import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";

const exec = promisify(execFile);
const script = fileURLToPath(
  new URL("../../../deploy/install-agent.py", import.meta.url),
);
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cardigan-install-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const args = () => [
  "--host-user",
  "operator",
  "--data-dir",
  join(root, "private"),
  "--agent-root",
  join(root, "agent"),
  "--dry-run",
];
const python = (code: string, rest: string[] = []) =>
  exec("python3", ["-B", "-c", code, script, ...rest], { timeout: 10000 });

test("installer dry-run is repeatable and cannot invoke subprocesses or download payloads", async () => {
  const probe = `import importlib.util,sys
spec=importlib.util.spec_from_file_location('installer',sys.argv[1]);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
def forbidden(*a,**k): raise AssertionError('dry-run performed IO')
mod.subprocess.run=forbidden;mod.urllib.request.urlopen=forbidden
sys.argv=[sys.argv[1],*sys.argv[2:]];mod.main()`;
  const first = await python(probe, args());
  expect((await python(probe, args())).stdout).toBe(first.stdout);
  expect(JSON.parse(first.stdout)).toMatchObject({
    version: "0.1.18",
    shared_group: "cardigan-agent",
    data_mode: "0700",
    parent_mode: "2750",
    assignment_directory_mode: "2770",
    credential_mode: "0660",
    changes_ssh_config: false,
  });
});

test.each(["root", "agent", "-operator", "user;command"])(
  "installer refuses unsafe host account %s",
  async (user) => {
    const input = args();
    input[1] = user;
    await expect(
      exec("python3", ["-B", script, ...input], { timeout: 10000 }),
    ).rejects.toThrow();
  },
);
test("installer refuses overlapping roots and relative or parent-traversing paths", async () => {
  for (const path of [
    "relative",
    "/tmp/../root",
    join(root, "private", "agent"),
  ]) {
    const input = args();
    input[5] = path;
    await expect(
      exec("python3", ["-B", script, ...input], { timeout: 10000 }),
    ).rejects.toThrow();
  }
});

test("archive verification precedes extraction and extracts only the regular executable", async () => {
  const probe = `import importlib.util,sys,io,tarfile,hashlib
from pathlib import Path
spec=importlib.util.spec_from_file_location('installer',sys.argv[1]);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
archive=Path(sys.argv[2])/'fixture.tar.gz'
def bundle(link=False):
 data=io.BytesIO()
 with tarfile.open(fileobj=data,mode='w:gz') as tar:
  info=tarfile.TarInfo('herdr-core')
  if link: info.type=tarfile.SYMTYPE;info.linkname='/outside'
  else: info.size=7
  tar.addfile(info,None if link else io.BytesIO(b'fixture'))
 archive.write_bytes(data.getvalue());mod.CHECKSUMS['fixture']=hashlib.sha256(data.getvalue()).hexdigest()
bundle();assert mod.payload(archive,'fixture')==b'fixture'
archive.write_bytes(b'tampered')
try: mod.payload(archive,'fixture');raise AssertionError('accepted bad checksum')
except RuntimeError as e: assert 'sha256' in str(e)
bundle(True)
try: mod.payload(archive,'fixture');raise AssertionError('accepted symlink')
except RuntimeError as e: assert 'regular' in str(e)
print('verified')`;
  expect((await python(probe, [root])).stdout.trim()).toBe("verified");
});
