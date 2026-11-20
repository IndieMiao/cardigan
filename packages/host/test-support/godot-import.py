"""Synthetic import contracts; real Git worktrees, no Godot SDK or devices."""
import importlib.util
import io
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('helper', Path(__file__).resolve().parents[3] / 'deploy/godot-import.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class FakeImport:
    def __init__(self, version='synthetic', fail=0):
        self.version = version
        self.fail = fail
        self.inputs = []

    def __call__(self, *args, capture=False):
        if args == ('--version',):
            return subprocess.CompletedProcess([], 0, stdout=self.version + '\n')
        assert args[0:2] == ('--headless', '--path') and args[3:] == ('--import',)
        cache = Path(args[2]) / '.godot'
        imported = cache / 'imported'
        imported.mkdir(parents=True, exist_ok=True)
        self.inputs.append({f.name: f.read_bytes() for f in imported.iterdir()})
        (imported / 'sample.ctex').write_bytes(b'asset')
        (cache / 'editor-only.cfg').touch()
        if self.fail:
            self.fail -= 1
            raise subprocess.CalledProcessError(3, list(args))


class SnapshotTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name).resolve()
        self.repo = self.base / 'repo'
        self.repo.mkdir()
        self.git('init', '-q')
        (self.repo / 'project.godot').touch()
        self.git('add', '.')
        self.commit()
        self.seed = self.base / 'read-only.zip'
        self.i = 0

    def git(self, *args):
        subprocess.run(['git', *args], cwd=self.repo, check=True, stdout=subprocess.DEVNULL)

    def commit(self):
        self.git('-c', 'user.name=Test', '-c', 'user.email=synthetic@example.invalid',
                 'commit', '-qm', 'seed')

    def tree(self):
        self.i += 1
        root = self.base / f'tree-{self.i}'
        self.git('worktree', 'add', '-q', '--detach', str(root), 'HEAD')
        return root

    def seed_sha(self):
        return helper.digest(io.BytesIO(self.seed.read_bytes()))

    def make_seed(self):
        helper.prepare(self.tree(), FakeImport(), self.seed, seed=True)
        return self.seed_sha()

    def test_two_tasks_and_seed_are_independent(self):
        sha = self.make_seed()
        with zipfile.ZipFile(self.seed) as z:
            self.assertEqual(z.namelist(), ['sample.ctex'])
        for _ in range(2):
            root, run = self.tree(), FakeImport()
            helper.prepare(root, run, self.seed, sha)
            self.assertEqual(run.inputs, [{'sample.ctex': b'asset'}])
            (root / '.godot/imported/sample.ctex').write_bytes(b'task-only')
            self.assertEqual(self.seed_sha(), sha)
        self.assertFalse((self.repo / '.godot').exists())

    def test_incompatible_or_corrupt_snapshot_is_cold(self):
        sha = self.make_seed()
        def cold(run=None, digest=sha):
            run = run or FakeImport()
            helper.prepare(self.tree(), run, self.seed, digest)
            self.assertEqual(run.inputs, [{}])
        cold(FakeImport(version='other'))
        with zipfile.ZipFile(self.seed, 'a') as z:
            z.writestr('../outside', b'bad')
        cold(digest=self.seed_sha())  # Even after one valid entry was restored.
        self.assertFalse(any(self.base.rglob('outside')))
        cold()  # Original digest no longer matches.
        self.seed.write_bytes(b'not a zip')
        cold(digest=self.seed_sha())
        self.seed.unlink()
        cold()
        sha = self.make_seed()
        (self.repo / 'new').touch()
        self.git('add', 'new')
        self.commit()
        cold(digest=sha)

    def test_only_seeded_failure_retries_once_from_empty(self):
        sha = self.make_seed()
        for failures in (1, 2):
            run = FakeImport(fail=failures)
            if failures == 2:
                with self.assertRaises(subprocess.CalledProcessError):
                    helper.prepare(self.tree(), run, self.seed, sha)
            else:
                helper.prepare(self.tree(), run, self.seed, sha)
            self.assertEqual(run.inputs, [{'sample.ctex': b'asset'}, {}])
        run = FakeImport(fail=1)
        with self.assertRaises(subprocess.CalledProcessError):
            helper.prepare(self.tree(), run)
        self.assertEqual(run.inputs, [{}])

    def test_never_overwrite_existing_tree_or_link(self):
        root, run = self.tree(), FakeImport()
        target = self.base / 'untouched'
        target.mkdir()
        (target / 'keep').touch()
        (root / '.godot').symlink_to(target)
        with self.assertRaises(ValueError):
            helper.prepare(root, run)
        self.assertTrue((target / 'keep').exists())
        self.assertEqual(run.inputs, [])
        with self.assertRaises(ValueError):
            helper.prepare(self.repo, run)

    @unittest.skipUnless(sys.platform == 'darwin', 'requires real macOS sandbox')
    def test_offline_boundary(self):
        # Controlled ephemeral listener, never the default adb port or a device.
        with socket.socket() as listener:
            listener.bind(('localhost', 0))
            listener.listen()
            port = listener.getsockname()[1]
            adb = self.base / 'adb'
            shutil.copy('/bin/echo', adb)
            helper.offline(Path(sys.executable), str(self.base))('-c', '''
import errno, os, socket, subprocess, sys
assert os.environ['ADB_SERVER_SOCKET'] == 'localfilesystem:/dev/null'
with socket.socket() as s:
    assert s.connect_ex(('localhost', int(sys.argv[1]))) in (errno.EPERM, errno.EACCES)
try: subprocess.run([sys.argv[2]], check=True)
except PermissionError: pass
else: raise AssertionError('adb was executable')
''', str(port), str(adb))


if __name__ == '__main__':
    unittest.main()
