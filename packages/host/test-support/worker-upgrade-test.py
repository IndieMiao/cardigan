"""Exercise the wire format and root write policy without real accounts or sudo."""
import base64
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest
from unittest.mock import patch

DEPLOY = Path(__file__).resolve().parents[3] / 'deploy'
api = runpy.run_path(str(DEPLOY / 'upgrade-worker-helpers.py'))
NAMES = api['NAMES']


class EntryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.files = {name: b'not executable Python\n' for name in NAMES}
        self.meta = dict(kind='cardigan-helper-v1', project='sample', issued=100, digests={
            n: api['digest'](f) for n, f in self.files.items()})
        self.bundle = dict(signature='AA==', manifest=json.dumps(self.meta), files={
            n: base64.b64encode(f).decode() for n, f in self.files.items()})

    def unpack(self, verify=lambda *_: None, previous=0):
        return api['unpack'](json.dumps(self.bundle).encode(), 'sample', verify, 100, previous)

    def test_signed_manifest_requires_pinned_key(self):
        def run(*args, data=None):
            return subprocess.run(['/usr/bin/openssl', *args], input=data, capture_output=True, check=True).stdout
        key, pub = self.root / 'test.key', self.root / 'test.pub'
        run('genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', key)
        run('pkey', '-in', key, '-pubout', '-out', pub)
        signature = run('dgst', '-sha256', '-sign', key, data=self.bundle['manifest'].encode())
        self.bundle['signature'] = base64.b64encode(signature).decode()
        def verify(m, s):
            api['verify_release'](self.root, pub, m, s)
        self.assertEqual(self.unpack(verify)[1], self.files)
        self.meta['issued'] += 1
        self.bundle['manifest'] = json.dumps(self.meta)
        with self.assertRaises(subprocess.CalledProcessError):
            self.unpack(verify)

    def test_exact_names_digest_and_replay(self):
        for name in ('unlisted', '../other', '/absolute'):
            self.bundle['files'][name] = ''
            with self.assertRaises(ValueError): self.unpack()
            del self.bundle['files'][name]
        with self.assertRaises(ValueError): self.unpack(previous=100)
        self.bundle['files'][NAMES[0]] = 'AAAA'
        with self.assertRaises(ValueError): self.unpack()

    def test_installed_symlink_refused_before_any_write(self):
        target = self.root / NAMES[0]
        target.symlink_to(self.root / 'absent')
        with self.assertRaises(OSError): api['read_installed'](target, 0, lambda _: True)

    def test_backups_and_postcheck_never_load_file_contents(self):
        old = b'old fixture'
        target = self.root / 'libexec'; target.mkdir()
        backup = self.root / 'backup'; backup.mkdir()
        for name in NAMES: (target / name).write_bytes(old); (target / name).chmod(0o750)
        # Substitute ownership only; actual filesystem operations, modes, nofollow and checks remain.
        original = os.fstat
        def root_stat(fd):
            fields = list(original(fd)); fields[4] = 0
            return os.stat_result(fields)
        checks = []
        with patch.object(os, 'fstat', root_stat), patch.object(os, 'fchown'):
            result = api['update'](self.files, target, os.getgid(), backup, lambda _: True, checks.append)
        self.assertEqual(checks, [old, self.files[NAMES[2]]])
        for n in NAMES:
            self.assertEqual(result[n], api['digest'](old))
            self.assertEqual((backup / n).read_bytes(), old)
            self.assertEqual((target / n).read_bytes(), self.files[n])

    def test_caller_boundary_and_fixed_policy(self):
        for uid, user in [(501, 'worker'), (501,'cardigan_updater'), (0,'worker'), (0,'agent')]:
            with patch.object(os,'geteuid',return_value=uid), patch.dict(os.environ,SUDO_USER=user):
                with self.assertRaises(ValueError): api['main']()
        script=(DEPLOY / 'enroll-helper-worker.sh').read_text()
        self.assertIn('NOPASSWD: NOSETENV: %s/upgrade ""',script)
        self.assertIn('restrict,command="/usr/bin/sudo -n -- %s/upgrade"',script)


if __name__ == '__main__': unittest.main()
