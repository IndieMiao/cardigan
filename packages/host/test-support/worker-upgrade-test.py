"""Exercise the wire format and root write policy without real accounts or sudo."""
import base64
import contextlib
import io
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
# Entries already enrolled before C-595 keep this exact v1 copy.
legacy_api = runpy.run_path(str(Path(__file__).with_name('upgrade-worker-helpers-v1.py')))
NAMES = api['NAMES']
TOOLS = api['TOOLS']


class EntryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.files = {name: b'not executable Python\n' for name in NAMES}
        self.files.update({name: b'#!/usr/bin/env node\n' + name.encode() for name in TOOLS})
        self.bundle = self.signed('cardigan-helper-v2', self.files)

    def signed(self, kind, files):
        self.meta = dict(kind=kind, project='sample', issued=100, digests={
            n: api['digest'](f) for n, f in files.items()})
        return dict(signature='AA==', manifest=json.dumps(self.meta), files={
            n: base64.b64encode(f).decode() for n, f in files.items()})

    def unpack(self, verify=lambda *_: None, previous=0, entry=api):
        return entry['unpack'](json.dumps(self.bundle).encode(), 'sample', verify, 100, previous)

    def test_protocol_versions_never_cross(self):
        # A v2 bundle is refused whole by an entry enrolled before C-595, so the
        # controller retries the unchanged v1 bundle; v2 entries refuse v1 bundles.
        with self.assertRaises(ValueError): self.unpack(entry=legacy_api)
        helpers = {n: self.files[n] for n in NAMES}
        self.bundle = self.signed('cardigan-helper-v1', helpers)
        self.assertEqual(self.unpack(entry=legacy_api)[1], helpers)
        with self.assertRaises(ValueError): self.unpack()
        self.bundle = self.signed('cardigan-helper-v2', helpers)
        with self.assertRaises(ValueError): self.unpack()

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

    def test_tool_directory_must_be_root_owned_and_unlinked(self):
        target = self.root / 'libexec'; target.mkdir()
        (target / 'agent-tools').symlink_to(self.root)
        with self.assertRaises(OSError): api['tool_directory'](target, os.getgid(), lambda _: True)
        (target / 'agent-tools').unlink(); (target / 'agent-tools').mkdir(mode=0o770)
        with self.assertRaises(ValueError): api['tool_directory'](target, os.getgid(), lambda _: True)

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
            fields = list(original(fd)); fields[4:6] = [0, os.getgid()]
            return os.stat_result(fields)
        checks = []
        with patch.object(os, 'fstat', root_stat), patch.object(os, 'fchown'):
            result = api['update'](self.files, target, os.getgid(), backup, lambda _: True, checks.append)
        self.assertEqual(checks, [old, self.files[NAMES[2]]])
        for n in NAMES:
            self.assertEqual(result[n], api['digest'](old))
            self.assertEqual((backup / n).read_bytes(), old)
            self.assertEqual((target / n).read_bytes(), self.files[n])
        # First v2 install: no previous tools, root-owned group read-only copies.
        self.assertEqual(stat.S_IMODE((target / 'agent-tools').stat().st_mode), 0o750)
        for n in TOOLS:
            self.assertIsNone(result[n])
            self.assertEqual((target / n).read_bytes(), self.files[n])
            self.assertEqual(stat.S_IMODE((target / n).stat().st_mode), 0o750)
        # A later release backs the previous tools up before replacing them.
        newer = {n: data + b'2' for n, data in self.files.items()}
        second = backup / 'second'; second.mkdir()
        with patch.object(os, 'fstat', root_stat), patch.object(os, 'fchown'):
            result = api['update'](newer, target, os.getgid(), second, lambda _: True, lambda _: None)
        for n in TOOLS:
            self.assertEqual(result[n], api['digest'](self.files[n]))
            self.assertEqual((second / n.replace('/', '-')).read_bytes(), self.files[n])
            self.assertEqual((target / n).read_bytes(), newer[n])

    def test_inventory_checks_all_but_writes_only_one_binding(self):
        m = runpy.run_path(str(DEPLOY / 'install-macos-worker.py'))
        registry = m['main'].__globals__
        (self.root / 'worker.json').write_text('{"project":"one", "uid":1, "timeout_ms":10}')
        other = self.root / 'worker-two.json'
        other.write_text('{"project":"two", "uid":2, "timeout_ms":10}')
        def read(path): return json.loads(path.read_bytes())
        def preflight(cfg, system): return SimpleNamespace(pw_uid=cfg['uid']), self.root / cfg['project']
        def invoke(system, *args):
            with patch.object(sys, 'argv', ['installer', *args]): m['main'](system)
        for system in ('Darwin', 'Linux'):
            with patch.dict(registry, CONFIG_DIR={system:self.root}, protected=lambda _: None,
                            trusted_json=read, preflight=preflight), patch.dict(registry, apply=unittest.mock.Mock()):
                log = io.StringIO()
                with contextlib.redirect_stdout(log):
                    invoke(system, '--check')
                    self.assertEqual({json.loads(l)['project'] for l in log.getvalue().splitlines()}, {'one','two'})
                    with self.assertRaises(ValueError): invoke(system, '--apply')
                    bad = self.root / 'worker-broken.json'; bad.write_text('{')
                    with self.assertRaises(ValueError): invoke(system, '--check')
                    reports = [json.loads(l) for l in log.getvalue().splitlines()[2:]]
                    self.assertEqual([r.get('config') for r in reports if r['installation']=='failed'], [bad.name])
                    self.assertEqual({r['project']: r['installation'] for r in reports},
                                     {'one':'checked', 'two':'checked', 'broken':'failed'})
                    invoke(system, '--project', 'two', '--apply')
                    self.assertEqual(registry['apply'].call_args.args[1], self.root / 'two')
                    bad.unlink()
                    duplicate = self.root / 'worker-one.json'; duplicate.write_text('{"project":"one"}')
                    with self.assertRaises(ValueError): invoke(system, '--project', 'one', '--apply')
                    duplicate.write_text('{"project":"two"}')  # No fallback to worker.json.
                    with self.assertRaises(ValueError): invoke(system, '--project', 'one', '--apply')
                    registry['apply'].assert_called_once()
                    duplicate.unlink()

    def test_project_principal_and_signed_target_cannot_be_substituted(self):
        legacy = api['LEGACY']
        tag = api['digest'](b'sample')[:20]
        boot = legacy.with_name(legacy.name + '-' + tag)
        self.assertEqual(api['enrollment'](legacy, 'first'), 'cardigan_updater')
        self.assertEqual(api['enrollment'](boot, 'sample'), 'cgu_' + tag)
        with self.assertRaises(ValueError): api['enrollment'](boot, 'first')
        with self.assertRaises(ValueError):
            api['unpack'](json.dumps(self.bundle).encode(), 'first', lambda *_: None, 100, 0)

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
              patch.object(os,'geteuid',return_value=1001), patch.object(os,'listxattr',create=True,side_effect=lambda p, **_: ['system.posix_acl_default'] if str(p)==acl_path else []),
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
        def tools(t, *_):
            (t / 'agent-tools').mkdir()
            return t / 'agent-tools'
        with patch.dict(api['update'].__globals__, {'read_installed':lambda *_:b'old', 'tool_directory':tools}), patch.object(os,'fchown'), patch.object(os,'replace',side_effect=timeout):
            with self.assertRaises(TimeoutError): api['update'](self.files,target,os.getgid(),backup,lambda _:True,lambda _:None)
        self.assertEqual(list(target.iterdir()),[target / 'agent-tools'])
        self.assertEqual(list((target / 'agent-tools').iterdir()),[])
        self.assertTrue(all((backup/n).read_bytes()==b'old' for n in NAMES))

    def test_main_authorization_order_and_exact_binding(self):
        from unittest.mock import Mock
        from contextlib import ExitStack
        legacy = self.root / 'cardigan-helper-upgrade'
        project = 'second'
        tag = api['digest'](project.encode())[:20]
        named = legacy.with_name(legacy.name + '-' + tag)
        user = 'cgu_' + tag
        # stage reached: 0 = before reading pin, 1 = before installer,
        # 2 = rejected after selecting config, 3 = proceeds to account validation.
        cases = [
            (legacy, project, api['USER'], 'worker.json', 3),
            (named, project, user, 'worker-second.json', 3),
            (self.root / 'elsewhere' / named.name, project, user, 'worker-second.json', 0),
            (named.with_name('other-' + tag), project, user, 'worker-second.json', 0),
            (named, 'first', user, 'worker-first.json', 1),
            (legacy, project, user, 'worker.json', 1),
            (named, project, api['USER'], 'worker-second.json', 1),
            (named, project, 'cgu_' + api['digest'](b'first')[:20], 'worker-second.json', 1),
            (legacy, project, api['USER'], 'worker-second.json', 2),
            (named, project, user, 'worker.json', 2),
        ]
        class AccountCheck(Exception): pass
        for boot, pin, caller, filename, stage in cases:
            with self.subTest(boot=boot,pin=pin,caller=caller,filename=filename), ExitStack() as st:
                enter = st.enter_context
                read = enter(patch.object(Path, 'read_text', autospec=True, return_value=pin + '\n'))
                choose = Mock(return_value=(self.root / filename, {'project':pin,'account':'fixture'}))
                load = enter(patch('runpy.run_path', side_effect=[{}, {'select_binding':choose,'binding_inventory':lambda _:[]}]))
                lookup = enter(patch('pwd.getpwnam', side_effect=AccountCheck))
                enter(patch.dict(api['main'].__globals__, BOOT=boot, LEGACY=legacy))
                enter(patch.dict(os.environ, SUDO_USER=caller)); enter(patch.object(sys,'argv',['upgrade']))
                enter(patch.object(os,'geteuid',return_value=0))
                for func in ('os.chdir','os.umask','signal.signal','signal.alarm'): enter(patch(func))
                with self.assertRaises(AccountCheck if stage == 3 else ValueError): api['main']()
                if stage > 0: read.assert_called_once_with(boot / 'project')
                else: read.assert_not_called()
                self.assertEqual(load.call_count, 2 if stage >= 2 else 0)
                if stage >= 2: choose.assert_called_once_with([], pin)
                self.assertEqual(lookup.call_count, int(stage == 3))

    def test_caller_boundary_and_fixed_policy(self):
        for argv, uid in [(['upgrade'],501), (['upgrade','extra'],0)]:
            with patch.object(sys,'argv',argv), patch.object(os,'geteuid',return_value=uid), patch.object(Path,'read_text') as pin:
                with self.assertRaises(ValueError): api['main']()
                pin.assert_not_called()
        script=(DEPLOY / 'enroll-helper-worker.sh').read_text()
        self.assertIn('NOPASSWD: NOSETENV: %s/upgrade ""',script)
        self.assertIn('restrict,command="/usr/bin/sudo -n -- %s/upgrade"',script)


if __name__ == '__main__': unittest.main()
