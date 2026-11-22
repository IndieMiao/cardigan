"""Synthetic filesystem and mocked ownership/installer only; never run sudo or touch a real worker."""
from pathlib import Path
import hashlib
import io
import os
import runpy
import tarfile
import tempfile
import unittest
from unittest import mock


module = runpy.run_path(str(Path(__file__).resolve().parents[3] / 'deploy/manual-worker-upgrade.py'))
upgrade = module['upgrade_files']
names = module['HELPERS']
tools = module['TOOLS']
digest = module['digest']


def installed(path):
    return digest(path) if path.exists() else None


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
        (self.release / 'agent-tools').mkdir()
        for n in tools:
            (self.release / n).write_text('new-' + n)
        # Mirror unpack()'s modes for this archive of non-executable files.
        self.release.chmod(0o755)
        for entry in self.release.rglob('*'):
            entry.chmod(0o755 if entry.is_dir() else 0o644)
        (self.live / 'previous').write_text('leave-intact')
        self.cfg = {'project': 'sample', 'rev': 'c' * 40, 'manifest': {
            p.relative_to(self.release).as_posix(): digest(p) for p in self.release.rglob('*') if p.is_file()}}
        self.backup = self.root / ('deploy.bak-' + 'c' * 12 + '-' + hashlib.sha256(b'sample').hexdigest()[:20])
        owner = self.root.stat()
        # Root ownership of the tools directory is covered by test_tool_directory_requires_root.
        m = mock.patch.dict(upgrade.__globals__, DEPLOY_OWNER=(owner.st_uid, owner.st_gid),
                            tool_directory=lambda lib, gid: (lib / 'agent-tools').mkdir(exist_ok=True),
                            migrate_bootstrap=lambda release, project: self.migrated.append(project))
        self.migrated = []
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
        upgrade(self.work, self.release, self.live, self.lib, 123, self.cfg, installed, installer, lambda _: True)

    def test_tool_directory_requires_root(self):
        with self.assertRaisesRegex(ValueError, 'unsafe_agent_tools_directory'):
            module['tool_directory'](self.lib, 123)

    def test_enrolled_v1_entry_is_migrated_to_the_verified_release(self):
        boot = self.root / 'cardigan-helper-upgrade'
        tagged = boot.with_name(boot.name + '-' + hashlib.sha256(b'sample').hexdigest()[:20])
        files = module['BOOTSTRAP_FILES']
        for d, project in ((boot, 'other'), (tagged, 'sample')):
            d.mkdir(mode=0o700)
            (d / 'project').write_text(project + '\n')
            for n in files:
                (d / n).write_text('v1-' + n)
                (self.release / n).write_text('v2-' + n)
        real, real_fstat = Path.lstat, os.fstat
        def root_owned(s):
            return os.stat_result((s.st_mode, s.st_ino, s.st_dev, s.st_nlink, 0, 0, *tuple(s)[6:]))
        with mock.patch.object(Path, 'lstat', lambda path: root_owned(real(path))), \
                mock.patch('os.fstat', lambda fd: root_owned(real_fstat(fd))):
            module['migrate_bootstrap'](self.release, 'sample', boot)
            for n in files:
                self.assertEqual((tagged / n).read_text(), 'v2-' + n)
                self.assertEqual((tagged / n).stat().st_mode & 0o777, 0o400)
                self.assertEqual((boot / n).read_text(), 'v1-' + n)  # Another project's entry.
            # C-599: a tagged entry naming another project is never rewritten.
            (tagged / 'project').write_text('other\n')
            for n in files:
                (tagged / n).chmod(0o600)
                (tagged / n).write_text('v1-' + n)
            out = io.StringIO()
            with mock.patch('sys.stdout', out):
                module['migrate_bootstrap'](self.release, 'sample', boot)
            self.assertEqual([(tagged / n).read_text() for n in files], ['v1-' + n for n in files])
            self.assertNotIn('迁移', out.getvalue())
            # The project file is never followed through a link.
            (tagged / 'project').unlink()
            (tagged / 'project').symlink_to(boot / 'project')
            with self.assertRaises(OSError):
                module['migrate_bootstrap'](self.release, 'sample', boot)
            (tagged / 'project').unlink()
            (tagged / 'project').write_text('sample\n')
            tagged.chmod(0o755)
            with self.assertRaisesRegex(ValueError, 'unsafe_helper_upgrade_entry'):
                module['migrate_bootstrap'](self.release, 'sample', boot)

    def test_linux(self):
        self.run_upgrade('linux')
        self.assertEqual(self.migrated, ['sample'])
        for n in tools:
            self.assertEqual(digest(self.lib / n), self.cfg['manifest'][n])
            self.assertEqual((self.lib / n).stat().st_mode & 0o777, 0o750)
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
            upgrade(self.work, self.release, self.live, other, 124, self.cfg, installed, lambda _: None, lambda _: True)
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
                upgrade(self.work, self.release, self.live, lib, 124, self.cfg, installed, lambda _: None, lambda _: True)
        self.assertEqual({p.relative_to(self.live).as_posix(): digest(p) for p in self.live.rglob('*') if p.is_file()}, self.cfg['manifest'])
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

    def test_nested_executable_agent_tools_ship_with_the_release(self):
        # C-595: the unchanged template ships the prebuilt agent tools in a nested,
        # executable directory, verified against the manifest like every release file.
        source = Path(__file__).resolve().parents[3] / 'deploy' / 'agent-tools'
        tools = ('download-attachment.mjs', 'upload-evidence.mjs')
        staged = self.root / 'staged' / 'deploy'
        (staged / 'agent-tools').mkdir(parents=True)
        for name in tools:
            (staged / 'agent-tools' / name).write_bytes((source / name).read_bytes())
            (staged / 'agent-tools' / name).chmod(0o755)
        for n in names:
            (staged / n).write_text('new-' + n)
        manifest = {p.relative_to(staged).as_posix(): digest(p) for p in staged.rglob('*') if p.is_file()}
        archive = self.root / 'deploy.tar.gz'
        with tarfile.open(archive, 'w:gz') as tar:
            tar.add(staged, arcname='deploy')
        dest = self.root / 'unpacked'
        dest.mkdir()
        module['unpack'](archive, dest, manifest)
        self.cfg.update(manifest=manifest, os='darwin')
        upgrade(self.work, dest / 'deploy', self.live, self.lib, 123, self.cfg, installed, lambda _: None, lambda _: True)
        for name in tools:
            path = self.live / 'agent-tools' / name
            self.assertEqual(digest(path), manifest['agent-tools/' + name])
            self.assertEqual(path.stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.backup / 'previous').read_text(), 'leave-intact')


if __name__ == '__main__':
    unittest.main()
