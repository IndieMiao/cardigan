"""Import contracts in real Git worktrees; optionally use a real macOS Godot."""
import contextlib
import importlib.util
import io
import os
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

    def test_separate_git_dir_is_not_a_linked_worktree(self):
        self.git('init', '-q', '--separate-git-dir', str(self.base / 'metadata'))
        self.assertTrue((self.repo / '.git').is_file())
        def never_run(*args, **kwargs):
            self.fail('must reject the primary checkout before starting Godot')
        with self.assertRaises(ValueError):
            helper.prepare(self.repo, never_run)
        self.assertFalse((self.repo / '.godot').exists())
        # A linked task checkout from that very same repository is legitimate.
        run = FakeImport()
        helper.prepare(self.tree(), run)
        self.assertEqual(run.inputs, [{}])

    def test_failed_pack_can_be_retried_without_overwriting(self):
        root = self.tree()
        helper.prepare(root, FakeImport())
        cache = root / '.godot'
        bad = cache / 'imported' / 'unsupported'
        bad.mkdir()
        with self.assertRaises(ValueError):
            helper.pack(cache, self.seed, {})
        self.assertFalse(self.seed.exists())
        bad.rmdir()
        sha = helper.pack(cache, self.seed, {})
        with self.assertRaises(FileExistsError):
            helper.pack(cache, self.seed, {'changed': True})
        self.assertEqual(self.seed_sha(), sha)

    @unittest.skipUnless(os.environ.get('CARDIGAN_TEST_GODOT'), 'set absolute path to real macOS Godot 4')
    def test_godot_loads_resource_and_scene_in_both_trees(self):
        engine = Path(os.environ['CARDIGAN_TEST_GODOT'])
        shutil.copytree(Path(__file__).with_name('godot-fixture'), self.repo, dirs_exist_ok=True)
        self.git('add', '.')
        self.commit()
        seed, cold, restored = self.tree(), self.tree(), self.tree()
        with tempfile.TemporaryDirectory() as home:
            helper.prepare(seed, helper.offline(engine, home), self.seed, seed=True)
        manifests = []
        for root in (cold, restored):
            with tempfile.TemporaryDirectory() as home, contextlib.redirect_stdout(io.StringIO()) as output:
                run = helper.offline(engine, home)
                if root == restored:
                    helper.prepare(root, run, self.seed, self.seed_sha())
                    self.assertIn('import=restored', output.getvalue().splitlines())
                else:
                    helper.prepare(root, run)
                    self.assertIn('import=cold', output.getvalue().splitlines())
                imported = root / '.godot/imported'
                manifest = {p.relative_to(imported) for p in imported.rglob('*') if p.is_file()}
                self.assertTrue(any(p.suffix == '.ctex' for p in manifest))
                manifests.append(manifest)
                result = run('--headless', '--path', str(root), '--quit-after', '30',
                             '--script', 'res://probe.gd', capture=True)
                self.assertIn('SCENE_AND_TEXTURE_OK', result.stdout.splitlines())
        self.assertEqual(*manifests)

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
