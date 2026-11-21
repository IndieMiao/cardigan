"""Exercise the wire format and root write policy without real accounts or sudo."""
import base64
import sys
import stat
from types import SimpleNamespace
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

    def bootstrap_guard(self, name, args, metadata, platform='Linux', acl_path=None):
        source = (DEPLOY / name).read_text().split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
        paths = []
        def lookup(p):
            paths.append(str(p))
            uid, mode, links = metadata[str(p)]
            return SimpleNamespace(st_uid=uid, st_mode=mode, st_nlink=links)
        def mac_acl(argv, **kwargs):
            return b'drwx------ root' + (b'\n 0: user:fixture allow write' if argv[-1] == acl_path else b'\n 0: group:everyone deny delete')
        with (patch.object(sys,'argv',['-', *args]), patch.object(Path,'lstat',lookup),
              patch.object(os,'geteuid',return_value=1001), patch.object(os,'listxattr',side_effect=lambda p, **_: ['system.posix_acl_default'] if str(p)==acl_path else []),
              patch('platform.system',return_value=platform), patch.object(subprocess,'check_output',side_effect=mac_acl)):
            exec(compile(source, name, 'exec'), {})
        return paths

    def test_root_bootstrap_denies_effective_writers_before_authorization(self):
        script = 'enroll-helper-worker.sh'
        doc = (DEPLOY/script).read_text()
        self.assertLess(doc.index('guard "f:$staged"'),doc.index('ln "$staged" "$policy"'))
        self.assertLess(doc.index('guard "d:$b/state"'),doc.index('guard "f:$staged"'))
        data = {'/':(0,0o40755,2),'/opt':(0,0o40755,2),'/opt/entry':(0,0o100500,1)}
        for platform in ('Linux','Darwin'):
            self.bootstrap_guard(script,['f:/opt/entry'],data,platform)
            for p in data:
                with self.subTest(os=platform,path=p), self.assertRaises(SystemExit):
                    self.bootstrap_guard(script,['f:/opt/entry'],data,platform,p)
        for bad in [(0,0o100520,1),(1001,0o100500,1),(0,stat.S_IFLNK|0o777,1),(0,0o100500,2)]:
            with self.assertRaises(SystemExit):
                self.bootstrap_guard(script,['f:/opt/entry'],dict(data, **{'/opt/entry':bad}))

    def test_controller_validates_all_existing_material_before_key_tools(self):
        script='enroll-helper-controller.sh'; src=(DEPLOY/script).read_text()
        self.assertLess(src.index("<<'PY'"), src.index('openssl genpkey'))
        args=['/config','identity']; data={'/':(0,0o40755,2),'/config':(1001,0o40700,2)}
        for suffix in ('','.pending','.pending.pub','.signer.pem'):
            data['/config/identity'+suffix]=(1001,0o100600,1)
        self.bootstrap_guard(script,args,data)
        for p, facts in [('/config',(1001,0o40755,2)),('/config',(0,0o40700,2)),('/',(0,0o40777,2)),('/config/identity.pending',(1001,0o100644,1)),('/config/identity.signer.pem',(1001,stat.S_IFLNK|0o777,1)),('/config/identity.pending.pub',(1001,0o100644,2))]:
            with self.subTest(path=p), self.assertRaises(SystemExit):
                self.bootstrap_guard(script,args,dict(data, **{p:facts}))
        with self.assertRaises(SystemExit): self.bootstrap_guard(script,args,data,acl_path='/config')

    def test_timeout_discards_only_its_own_staging_directory(self):
        target = self.root / 'libexec'; target.mkdir()
        backup = self.root / 'backup'; backup.mkdir()
        def timeout(*_): api['timed_out'](None, None)
        with patch.dict(api['update'].__globals__, {'read_installed':lambda *_:b'old'}), patch.object(os,'fchown'), patch.object(os,'replace',side_effect=timeout):
            with self.assertRaises(TimeoutError): api['update'](self.files,target,os.getgid(),backup,lambda _:True,lambda _:None)
        self.assertEqual(list(target.iterdir()),[])
        self.assertTrue(all((backup/n).read_bytes()==b'old' for n in NAMES))

    def test_caller_boundary_and_fixed_policy(self):
        for uid, user in [(501, 'worker'), (501,'cardigan_updater'), (0,'worker'), (0,'agent')]:
            with patch.object(os,'geteuid',return_value=uid), patch.dict(os.environ,SUDO_USER=user):
                with self.assertRaises(ValueError): api['main']()
        script=(DEPLOY / 'enroll-helper-worker.sh').read_text()
        self.assertIn('NOPASSWD: NOSETENV: %s/upgrade ""',script)
        self.assertIn('restrict,command="/usr/bin/sudo -n -- %s/upgrade"',script)


if __name__ == '__main__': unittest.main()
