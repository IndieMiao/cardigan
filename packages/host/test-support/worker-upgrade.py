"""Synthetic filesystem and mocked ownership/installer only; never run sudo or touch a real worker."""
from pathlib import Path
import hashlib
import runpy
import tarfile
import tempfile
import unittest
from unittest import mock


module = runpy.run_path(str(Path(__file__).resolve().parents[3] / 'deploy/manual-worker-upgrade.py'))
upgrade = module['upgrade_files']
names = module['HELPERS']
digest = module['digest']


class UpgradeTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.release, self.live, self.lib, self.work = [self.root / d for d in ('release', 'deploy', 'lib', 'private')]
        for d in (self.release, self.live, self.lib, self.work):
            d.mkdir()
        for n in names:
            (self.release / n).write_text('new-' + n)
            (self.lib / n).write_text('old-' + n)
        (self.release / 'extra').write_text('new-release')
        (self.live / 'previous').write_text('leave-intact')
        self.cfg = {'project': 'sample', 'rev': 'c' * 40, 'manifest': {p.name: digest(p) for p in self.release.iterdir()}}
        self.backup = self.root / ('deploy.bak-' + 'c' * 12 + '-' + hashlib.sha256(b'sample').hexdigest()[:20])
        owner = self.root.stat()
        m = mock.patch.dict(upgrade.__globals__, DEPLOY_OWNER=(owner.st_uid, owner.st_gid))
        m.start(); self.addCleanup(m.stop)
        self.calls = []
        for command in ('os.chown', 'os.fchown'):
            m = mock.patch(command)
            m.start()
            self.addCleanup(m.stop)

    def run_upgrade(self, platform, fail=False):
        self.cfg['os'] = platform
        def installer(flag):
            self.assertEqual((self.live / 'extra').read_text(), 'new-release')
            self.assertEqual((self.backup / 'previous').read_text(), 'leave-intact')
            self.calls.append(flag)
            if platform == 'linux':
                self.assertFalse((self.lib / names[0]).exists())
                self.assertEqual((self.lib / names[1]).read_text(), 'old-' + names[1])
                if flag == '--apply':
                    (self.lib / names[0]).write_bytes((self.live / names[0]).read_bytes())
            else:
                self.assertTrue(all(digest(self.lib / n) == self.cfg['manifest'][n] for n in names))
            if fail:
                raise ValueError('check_failed')
        upgrade(self.work, self.release, self.live, self.lib, 123, self.cfg, digest, installer, lambda _: True)

    def test_linux(self):
        self.run_upgrade('linux')
        self.assertEqual(self.calls, ['--check', '--apply'])
        self.assertEqual((self.work / names[0]).read_text(), 'old-' + names[0])
        self.assertTrue(all(digest(self.lib / n) == self.cfg['manifest'][n] for n in names))
        self.assertEqual((self.lib / names[1]).stat().st_mode & 0o777, 0o750)

    def test_mac(self):
        self.run_upgrade('darwin')
        self.assertEqual(self.calls, ['--check'])
        for n in names:
            self.assertEqual((self.lib / (n + '.bak-' + 'c' * 12)).read_text(), 'old-' + n)
        with self.assertRaisesRegex(ValueError, 'existing_deploy_backup'):
            self.run_upgrade('darwin')

    def test_same_release_second_binding_keeps_first_backup(self):
        self.run_upgrade('darwin')
        self.cfg['project'] = 'other'
        other = self.root / 'other-lib'; other.mkdir()
        for name in names:
            (other / name).write_text('old-other')
        original = self.live.stat().st_ino
        with mock.patch.dict(upgrade.__globals__, exchange_directories=mock.Mock(side_effect=AssertionError)):
            upgrade(self.work, self.release, self.live, other, 124, self.cfg, digest, lambda _: None, lambda _: True)
        self.assertEqual(original, self.live.stat().st_ino)
        self.assertEqual(len(list(self.root.glob('deploy.bak-*'))), 1)
        self.assertEqual((self.backup / 'previous').read_text(), 'leave-intact')
        for n in names:
            self.assertEqual((other / n).read_text(), 'new-' + n)
            self.assertEqual((self.lib / (n + '.bak-' + 'c' * 12)).read_text(), 'old-' + n)

    def test_interruption_on_either_side_of_exchange_keeps_shared_entry(self):
        with mock.patch.dict(upgrade.__globals__, exchange_directories=mock.Mock(side_effect=InterruptedError)):
            with self.assertRaises(InterruptedError):
                self.run_upgrade('darwin')
        self.assertEqual((self.live / 'previous').read_text(), 'leave-intact')
        # Another binding can stage and exchange without using the failed one's work or backups.
        self.cfg['project'] = 'other'
        lib = self.root / 'other-lib'; lib.mkdir()
        for n in names:
            (lib / n).write_text('other')
        with mock.patch.object(Path, 'rename', side_effect=InterruptedError):
            with self.assertRaises(InterruptedError):
                upgrade(self.work, self.release, self.live, lib, 124, self.cfg, digest, lambda _: None, lambda _: True)
        self.assertEqual({p.name: digest(p) for p in self.live.iterdir()}, self.cfg['manifest'])
        self.assertTrue(any((p / 'previous').is_file() for p in self.root.glob('deploy.new-*')))
        self.assertTrue(all((lib / n).read_text() == 'other' for n in names))

    def test_old_release_stage_or_backup_requires_operator(self):
        for name in ('deploy.new-', 'deploy.bak-'):
            path = self.root / (name + 'c' * 12)
            path.mkdir()
            with self.assertRaisesRegex(ValueError, 'existing_deploy_backup'):
                self.run_upgrade('darwin')
            path.rmdir()
        self.assertTrue((self.live / 'previous').is_file())

    def test_installer_check_fails(self):
        with self.assertRaisesRegex(ValueError, 'check_failed'):
            self.run_upgrade('linux', True)
        self.assertEqual(self.calls, ['--check'])
        self.assertTrue((self.work / names[0]).is_file())
        self.assertTrue((self.backup / 'previous').is_file())
        self.assertEqual((self.lib / names[1]).read_text(), 'old-' + names[1])

    def test_digest_mismatch_before_switch(self):
        (self.release / names[1]).write_text('bad')
        with self.assertRaisesRegex(ValueError, 'deploy_copy_digest'):
            self.run_upgrade('darwin')
        self.assertFalse(self.backup.exists())
        self.assertTrue((self.live / 'previous').is_file())
        self.assertEqual(self.calls, [])

    def test_archive_members_and_count(self):
        archive = self.root / 'archive'
        with tarfile.open(archive, 'w:gz') as tar:
            tar.add(self.release, arcname='deploy')
        for i, manifest in enumerate(({}, {**self.cfg['manifest'], 'missing': 'digest'}, self.cfg['manifest'])):
            dest = self.root / str(i)
            dest.mkdir()
            if i < 2:
                with self.assertRaises(ValueError):
                    module['unpack'](archive, dest, manifest)
            else:
                module['unpack'](archive, dest, manifest)
                self.assertEqual(digest(dest / 'deploy' / names[0]), manifest[names[0]])


if __name__ == '__main__':
    unittest.main()
