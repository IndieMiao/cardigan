"""Synthetic protocol and platform tests: never consult a real signing account."""
import hashlib
import io
import json
import os
from pathlib import Path
import plistlib
import signal
import sqlite3
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import warnings
from unittest.mock import patch
import zipfile

HELPERS = Path(__file__).resolve().parents[3] / 'deploy' / 'mobile-signing'
sys.path.insert(0, str(HELPERS))
from archives import inspect_zip
from common import SCOPE, SigningFailure, canonical, digest, directory, scope
import host
import platforms
import worker


def save(path, data):
    path.write_bytes(data.encode() if isinstance(data,str) else data)
    path.chmod(0o600)
    return path


# Members rejected in a real Godot APK; AAPT2 resource path shortening emits them.
AAPT2_SHORTENED = ('res/-8.xml', 'res/-B.png', 'res/-N.png', 'res/-p.png')
# Shortened names differing only in case, from the same APK (C-593).
CASE_ONLY = (('res/9n.9.png', 'res/9N.9.png'), ('res/Bt.png', 'res/BT.png'), ('res/bL.xml', 'res/Bl.xml'))
# Member names only (no bytes) of the rejected Godot APK, sensen-godot attachment-62
# (sha256 23751ada6f987c077a04be1206b0db9f5077f7dde8ce13c92da7749f62bbde37), exported by
# the host with ZipFile.infolist() orig_filename in archive order and attached to C-593
# as attachment-8919 (c593-member-names.json, sha256 35a6914f0e3759db...ce50dcb).
# Stored one name per line; no name contains a line break.
GODOT_APK_NAMES = Path(__file__).resolve().parent/'fixtures'/'mobile-signing'/'attachment-62-member-names.txt'
GODOT_APK_NAMES_SHA256 = '4f3e9e304a47cf84c1d479542d74e84232798e12d94986d4d51e05ba08212471'
GODOT_APK_MEMBERS, GODOT_APK_CASE_PAIRS = 6317, 19


def godot_apk_names():
    data = GODOT_APK_NAMES.read_bytes()
    assert hashlib.sha256(data).hexdigest() == GODOT_APK_NAMES_SHA256
    return data.decode().splitlines()


class Signing(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.host = directory(self.root,'control'); self.worker=directory(self.root,'signer')
        self.db=host.ledger(self.host); self.addCleanup(self.db.close)
        self.candidate=self.host/'candidate'
        with zipfile.ZipFile(self.candidate,'w') as z:
            z.writestr('AndroidManifest.xml',b'fixture')
            z.writestr('assets/.godot/', b'')
            z.writestr('assets/.godot/imported/icon.ctex', b'fixture')
            z.writestr('assets/.import', b'fixture')
            for name in AAPT2_SHORTENED:
                z.writestr(name, b'fixture')
            for pair in CASE_ONLY:
                for name in pair:
                    z.writestr(name, name.encode())
        self.candidate.chmod(0o600)
        self.spec={'id':'1'*32,'version':'test-v1','app':'test.fixture','build':'job-1','commit':'b'*40,
                   'sha256':digest(self.candidate),'expires':int(time.time())+600,'platform':'android',
                   'project':'example','machine':'worker','run':'R-1','card':'C-1','assignment':'A-1','worker_uid':os.getuid()+1}
        self.ctx={k:self.spec[k] for k in SCOPE}; self.calls=0
        route={k:self.spec[k] for k in ('project','machine','platform','version','app')}
        save(self.host/'routes.json',canonical([{**route,'peer':'fixture'}]))
        def program(name,body):
            p=save(self.worker/name,'#!/usr/bin/python3\n'+body); p.chmod(0o700); return str(p)
        fingerprint=hashlib.sha256(b'fixture-public').hexdigest()
        config={**route,'cert_sha256':fingerprint,'alias':'fixture',
                'keytool':program('fixture-keytool', '''import sys, pathlib
assert sys.argv[1]=='-exportcert' and sys.argv[2]=='-keystore' and sys.argv[4:7]==['-alias','fixture','-storepass:file']
assert pathlib.Path(sys.argv[3]).read_text()=='private-fixture-marker'
sys.stdout.buffer.write(b'fixture-public')'''),
                'aapt2':program('fixture-aapt','print("test.fixture")'),
                'apksigner':program('fixture-signer','''import sys, pathlib, shutil
p=pathlib.Path(__file__).with_name('uses')
if sys.argv[1]=='sign':
    with p.open('a') as f: f.write('used\\n')
    assert pathlib.Path(sys.argv[3]).read_text()=='private-fixture-marker' and '--out' in sys.argv
    shutil.copyfile(sys.argv[-1],sys.argv[sys.argv.index('--out')+1])
    with open(sys.argv[sys.argv.index('--out')+1],'ab') as f: f.write(b'fixture-signed')
else: print('Signer #1 certificate SHA-256 digest: '+'FINGERPRINT')
'''.replace('FINGERPRINT',fingerprint))}
        for field in ('keystore','store_password_file','key_password_file'):
            config[field]=str(save(self.worker/field,'private-fixture-marker'))
        self.policy=save(self.worker/'identity.json',canonical(config))
        host.register(self.host,self.db,self.spec,self.candidate)
        host.approve(self.host,self.db,self.spec)

    def dial(self,root,peer):
        self.assertEqual(peer,'fixture'); self.calls+=1
        return subprocess.Popen([sys.executable,'-IB',str(HELPERS/'worker.py'),str(self.worker)],
                                stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                                cwd=self.worker,env={'PATH':'/usr/bin:/bin','LC_ALL':'C'})

    def call(self,ctx=None,fence=lambda:None):
        return host.request(self.host,self.db,ctx or self.ctx,fence,self.dial)

    def shown_receipt(self):
        output = subprocess.check_output([sys.executable, '-IB', str(HELPERS/'host.py'),
                                          str(self.host), 'show', self.spec['id']])
        return json.loads(output)['worker_receipt']

    @unittest.skipIf(os.getuid()==0,'real worker refuses to use a root signing identity')
    def test_once_reconcile_then_export(self):
        rid=self.spec['id']; out=self.host/'outputs'/rid
        # Simulate an unavailable success journal after worker signing, before host release.
        self.db.execute("CREATE TRIGGER interrupt BEFORE UPDATE OF output ON grants BEGIN SELECT RAISE(ABORT,'fixture'); END")
        with self.assertRaises(sqlite3.DatabaseError): self.call()
        with self.assertRaises(ValueError): host.checked_output(self.db,rid,out)
        self.db.execute('DROP TRIGGER interrupt')
        # C-601: a claimed request first asks the signer's receipt (read-only), then looks it up.
        self.assertEqual(self.call(),(rid,digest(out))); self.assertEqual(self.calls,3)
        self.assertEqual(self.call(),(rid,digest(out))); self.assertEqual(self.calls,3)
        self.assertEqual((self.worker/'uses').read_text(),'used\n')
        self.assertEqual(self.shown_receipt(), {'state':'signed','sha256':digest(out)})
        self.assertNotEqual(digest(out),self.spec['sha256'])
        rows=''.join(self.db.iterdump()); self.assertNotIn('private-fixture-marker',rows)
        for k in ('run','machine','project','card','build','commit','sha256','version'): self.assertIn(self.spec[k],rows)
        save(out,'changed')
        with self.assertRaises(ValueError): self.call()

    def test_no_authority_or_input_substitution(self):
        for k in SCOPE:
            with self.subTest(k=k),self.assertRaises(ValueError):
                self.call({**self.ctx,k: self.ctx[k]+1 if k=='worker_uid' else 'other'})
        with self.assertRaises(ValueError): self.call({**self.ctx,'path':'other'})
        self.assertEqual(self.calls,0)
        save(self.host/'inputs'/self.spec['id'],'changed')
        with self.assertRaises(Exception): self.call()
        self.assertFalse((self.worker/'uses').exists())

    def test_same_signing_uid_and_stale_run_denied(self):
        def run_stopped(): raise ValueError('expired Run')
        with self.assertRaises(ValueError): self.call(fence=run_stopped)
        self.assertFalse((self.worker/'uses').exists())
        self.assertEqual(self.db.execute('SELECT state,output FROM grants').fetchone(),('pending',None))
        self.db.execute('DELETE FROM grants')
        if os.getuid():
            spec={**self.spec,'worker_uid':os.getuid(),'id':'2'*32}
            host.register(self.host,self.db,spec,self.candidate)
            host.approve(self.host,self.db,spec)
            with self.assertRaises(ValueError): self.call({**self.ctx,'worker_uid':os.getuid()})
            self.assertFalse((self.worker/'uses').exists())

    def test_unapproved_or_different_candidate_cannot_dispatch(self):
        self.db.execute('DELETE FROM grants')
        host.register(self.host,self.db,self.spec,self.candidate)
        with self.assertRaises(ValueError): self.call()
        for k,v in [('sha256','d'*64),('build','another'),('commit','c'*40),('app','other.app'),('run','R-2')]:
            with self.subTest(k=k),self.assertRaises(ValueError):
                host.approve(self.host,self.db,{**self.spec,k:v})
        self.assertEqual(self.calls,0)

    def test_audit_and_grant_gate_before_contact(self):
        self.db.execute("CREATE TRIGGER deny BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'fixture'); END")
        with self.assertRaises(sqlite3.DatabaseError): self.call()
        self.assertEqual(self.calls,0); self.db.execute('DROP TRIGGER deny')
        with patch('common.time.time',return_value=self.spec['expires']):
            with self.assertRaises(ValueError): self.call()
        save(self.host/'routes.json','[]')
        with self.assertRaises(ValueError): self.call()
        self.db.execute('UPDATE grants SET revoked=1')
        with self.assertRaises(ValueError): self.call()
        self.assertEqual(self.calls,0)

    @unittest.skipIf(os.getuid()==0,'real worker refuses root')
    def test_wrong_certificate_fails_no_output(self):
        cfg=json.loads(self.policy.read_bytes()); cfg['cert_sha256']='b'*64; save(self.policy,canonical(cfg))
        with self.assertRaises(ValueError): self.call()
        self.assertEqual(self.db.execute('SELECT state,output FROM grants').fetchone(),('failed',None))
        with self.assertRaises(ValueError): self.call()
        self.assertFalse((self.worker/'uses').exists())
        self.assertEqual(self.shown_receipt(), {'state':'failed','sha256':None,'failure_category':'signing_failed'})

    @unittest.skipIf(os.getuid()==0,'real worker refuses root')
    def test_public_cert_pass_still_checks_signed_output(self):
        cfg=json.loads(self.policy.read_bytes()); tool=Path(cfg['apksigner'])
        tool.write_text(tool.read_text().replace(cfg['cert_sha256'],'0'*64))
        with self.assertRaises(ValueError): self.call()
        self.assertEqual((self.worker/'uses').read_text(),'used\n')
        self.assertEqual(self.db.execute('SELECT state,output FROM grants').fetchone(),('failed',None))
        self.assertEqual(self.shown_receipt(), {'state':'failed','sha256':None,'failure_category':'apksigner_failed'})

    @unittest.skipIf(os.getuid()==0,'real worker refuses root')
    def test_failure_details_survive_disconnect_and_old_lookup(self):
        cfg = json.loads(self.policy.read_bytes())
        Path(cfg['aapt2']).write_text('#!/bin/sh\necho private-fixture-marker\n')
        self.db.execute("CREATE TRIGGER lost BEFORE UPDATE OF state ON grants WHEN NEW.state='failed' "
                        "BEGIN SELECT RAISE(ABORT,'fixture'); END")
        with self.assertRaises(sqlite3.DatabaseError): self.call()
        rid = self.spec['id']
        self.assertIsNone(self.shown_receipt())
        self.db.execute('DROP TRIGGER lost')
        # Legacy host compares the entire failed header, even on lookup.
        msg = canonical({'mode':'lookup','grant':self.spec,'size':0}).encode() + b'\ncommit\n'
        with self.dial(self.host, 'fixture') as proc:
            reply, _ = proc.communicate(msg)
        self.assertEqual(reply, b'ready\n{"status":"failed"}\n')
        expected = {'state':'failed','sha256':None,'failure_category':'package_mismatch'}
        self.assertEqual(host.reconcile(self.db,self.host,rid,self.dial), expected)
        self.assertEqual(self.shown_receipt(), expected)
        self.assertFalse((self.worker/'uses').exists())
        from contextlib import closing
        with closing(sqlite3.connect(self.worker/'audit.sqlite')) as db:
            self.assertNotIn('private-fixture-marker', ''.join(db.iterdump()))
            # Historical receipts have no detail table; an unrecognised peer value is not public either.
            db.execute("UPDATE failure_categories SET category='private-fixture-marker'")
            old = {'state':'failed','sha256':None}
            db.commit()
            self.assertEqual(worker.receipt(self.worker,self.spec), old)
            db.execute('DROP TABLE failure_categories')
            self.assertEqual(worker.receipt(self.worker,self.spec), old)
        self.assertNotIn('private-fixture-marker', ''.join(self.db.iterdump()))

    @unittest.skipIf(os.getuid()==0,'real worker refuses root')
    def test_delayed_pending_reconcile_keeps_failed_receipt(self):
        from concurrent.futures import ThreadPoolExecutor
        from contextlib import closing, contextmanager
        from threading import Event

        cfg = json.loads(self.policy.read_bytes())
        Path(cfg['aapt2']).write_text('#!/bin/sh\necho different.package\n')
        ready, resume = Event(), Event()

        @contextmanager
        def delayed_reply(root, peer):
            with self.dial(root, peer) as proc:
                yield proc
            # The receipt was read during the signer's ready/commit handshake.
            ready.set()
            self.assertTrue(resume.wait(5))

        def reconcile():
            with closing(host.ledger(self.host)) as observer:
                return host.reconcile(observer, self.host, self.spec['id'], delayed_reply)

        expected = {'state':'failed','sha256':None,'failure_category':'package_mismatch'}
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = None
            def fence():
                nonlocal future
                future = pool.submit(reconcile)
                self.assertTrue(ready.wait(5))
            try:
                with self.assertRaises(ValueError): self.call(fence=fence)
                self.assertEqual(self.shown_receipt(), expected)
            finally:
                resume.set()
            self.assertEqual(future.result(), expected)
        self.assertEqual(self.shown_receipt(), expected)
        self.assertEqual(self.db.execute('SELECT state,output FROM grants').fetchone(), ('failed', None))
        self.assertFalse((self.worker/'uses').exists())

    @unittest.skipIf(os.getuid()==0,'real worker refuses root')
    def test_failed_first_audit_preserves_one_dispatch(self):
        self.db.execute("CREATE TRIGGER deny BEFORE INSERT ON events WHEN NEW.action='request' BEGIN SELECT RAISE(ABORT,'fixture'); END")
        with self.assertRaises(sqlite3.DatabaseError): self.call()
        self.assertEqual(self.calls,0)
        self.assertEqual(self.db.execute('SELECT state FROM grants').fetchone(),('approved',))
        self.db.execute('DROP TRIGGER deny'); self.call(); self.call()
        self.assertEqual(self.calls,1); self.assertEqual((self.worker/'uses').read_text(),'used\n')

    @unittest.skipIf(os.getuid()==0,'real worker refuses root')
    def test_expired_or_revoked_receipt_only(self):
        rid=self.spec['id']
        self.db.execute("CREATE TRIGGER interrupt BEFORE UPDATE OF output ON grants BEGIN SELECT RAISE(ABORT,'fixture'); END")
        with self.assertRaises(sqlite3.DatabaseError): self.call()
        self.db.execute('DROP TRIGGER interrupt')
        with patch('common.time.time',return_value=self.spec['expires']+1):
            with self.assertRaises(ValueError): self.call()
            receipt=host.reconcile(self.db,self.host,rid,self.dial)
            self.assertEqual(receipt,{'state':'signed','sha256':digest(self.worker/'outputs'/rid)})
            self.assertEqual(self.db.execute('SELECT state,output FROM grants').fetchone(),('peer_signed',None))
            with self.assertRaises(ValueError): host.release_authority(self.host,self.db,rid,self.ctx)
        self.db.execute('UPDATE grants SET revoked=1'); self.policy.unlink()
        # Historical journal does not need live signing material or an enabled route.
        save(self.host/'routes.json','[]')
        self.assertEqual(receipt,host.reconcile(self.db,self.host,rid,self.dial))
        with self.assertRaises(ValueError): self.call()
        self.assertEqual((self.worker/'uses').read_text(),'used\n')

    def actions(self):
        return [a for (a,) in self.db.execute('SELECT action FROM events WHERE request=? ORDER BY rowid',(self.spec['id'],))]

    def test_budget_scales_with_input_size_and_private_limits(self):
        # C-598: 334 MB at the default 512 KiB/s each way, plus ten minutes for signing.
        self.assertEqual(host.budget(self.host, 0), 600)
        self.assertEqual(host.budget(self.host, 334_000_000), 600 + 1275)
        self.assertEqual(host.budget(self.host, 512*1024 + 1), 603)
        save(self.host/'limits.json', canonical({'bytes_per_second': 128*1024}))
        self.assertEqual(host.budget(self.host, 334_000_000), 600 + 5097)
        save(self.host/'limits.json', canonical({'base_seconds': 60, 'bytes_per_second': 16*1024}))
        self.assertEqual(host.budget(self.host, 16*1024), 62)
        for bad in ({'base_seconds': 59}, {'bytes_per_second': 1}, {'base_seconds': 86401},
                    {'base_seconds': 600.5}, {'base_seconds': True}, {'other': 1}, []):
            save(self.host/'limits.json', canonical(bad))
            with self.assertRaises(ValueError): host.budget(self.host, 1)
        save(self.host/'limits.json', canonical({})); (self.host/'limits.json').chmod(0o644)
        with self.assertRaises(ValueError): host.budget(self.host, 1)
        (self.host/'limits.json').unlink(); (self.host/'limits.json').symlink_to(self.host/'routes.json')
        with self.assertRaises(ValueError): host.budget(self.host, 1)

    @unittest.skipIf(os.getuid()==0,'real worker refuses root')
    def test_own_deadline_records_timed_out(self):
        reported = []
        with patch('host.budget', return_value=1):
            with self.assertRaises(host.Stopped):
                host.request(self.host, self.db, self.ctx, lambda: time.sleep(3), self.dial,
                             accepted=lambda *a: reported.append(a))
        self.assertEqual(reported, [(self.spec['id'], 1, 'sign')])
        self.assertEqual(self.actions(), ['registered', 'approved', 'request', 'timed_out'])
        self.assertEqual(self.db.execute('SELECT state,output FROM grants').fetchone(), ('pending', None))
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))
        self.assertFalse((self.worker/'uses').exists())

    @unittest.skipIf(os.getuid()==0,'real worker refuses root')
    def test_killed_after_peer_signed_same_run_retrieves(self):
        # C-598: the server helper is terminated after the signer finished but
        # before the output reached the control host. The next request of the
        # same Run, after an operator reconcile, fetches the stored bytes by lookup.
        rid = self.spec['id']; reads = []
        real_line = host.line
        def interrupted_line(stream):
            data = real_line(stream); reads.append(data)
            if data.startswith(b'{"sha256"'):
                os.kill(os.getpid(), signal.SIGTERM)
                time.sleep(1)
            return data
        previous = signal.signal(signal.SIGTERM, host.stop('interrupted'))
        try:
            with patch('host.line', interrupted_line):
                with self.assertRaises(host.Stopped): self.call()
        finally:
            signal.signal(signal.SIGTERM, previous)
        self.assertEqual(self.actions(), ['registered','approved','request','dispatch','interrupted'])
        self.assertFalse((self.host/'outputs'/rid).exists())
        self.assertEqual(host.reconcile(self.db,self.host,rid,self.dial)['state'], 'signed')
        self.assertEqual(self.db.execute('SELECT state FROM grants').fetchone(), ('peer_signed',))
        # A lookup never reads the local input copy; without it the budget is the largest output.
        (self.host/'inputs'/rid).unlink()
        reported = []
        result = host.request(self.host, self.db, self.ctx, lambda: None, self.dial,
                              accepted=lambda *a: reported.append(a))
        out = self.host/'outputs'/rid
        self.assertEqual(result, (rid, digest(out)))
        self.assertEqual(digest(out), digest(self.worker/'outputs'/rid))
        self.assertEqual(reported[0], (rid, host.budget(self.host, host.LIMIT), 'lookup'))
        self.assertEqual(self.actions()[-4:], ['receipt_signed','lookup','reconcile','signed'])
        self.assertEqual((self.worker/'uses').read_text(), 'used\n')
        self.assertEqual(host.request(self.host, self.db, self.ctx, lambda: None, self.dial,
                                      accepted=lambda *a: reported.append(a)), result)
        self.assertEqual(reported[-1][::2], (rid, 'stored')); self.assertEqual(self.calls, 3)

    def worker_receipt(self, **kw):
        return worker.receipt(self.worker, self.spec, **kw)

    @unittest.skipIf(os.getuid()==0,'real worker refuses root')
    def test_transfer_cut_off_resumes_same_number_and_signs_once(self):
        # C-601: the server restarted while the input was on its way. The signer
        # never got a commit, so the same Run resends the same number and signs once.
        rid = self.spec['id']; real = host.transfer; procs = []
        def dial(root, peer):
            procs.append(self.dial(root, peer)); return procs[-1]
        def cut_off(src, dst, size):
            if dst is None or len(procs) != 1:
                return real(src, dst, size)
            dst.write(src.read(size // 2)); dst.close()
            self.assertNotEqual(procs[0].wait(timeout=10), 0)
            raise host.Stopped('interrupted')
        with patch('host.transfer', cut_off), self.assertRaises(host.Stopped):
            host.request(self.host, self.db, self.ctx, lambda: None, dial)
        self.assertEqual(self.actions(), ['registered','approved','request','interrupted'])
        self.assertEqual(self.db.execute('SELECT state,output FROM grants').fetchone(), ('pending', None))
        self.assertEqual(self.worker_receipt(dispatch_states=True), {'state':'received','sha256':None})
        # Old control hosts only know pending for a request that has not finished.
        self.assertEqual(self.worker_receipt(), {'state':'pending','sha256':None})
        reported = []
        result = host.request(self.host, self.db, self.ctx, lambda: None, dial,
                              accepted=lambda *a: reported.append(a))
        out = self.host/'outputs'/rid
        self.assertEqual(result, (rid, digest(out)))
        self.assertEqual(digest(out), digest(self.worker/'outputs'/rid))
        self.assertEqual(reported, [(rid, host.budget(self.host, self.candidate.stat().st_size), 'resume')])
        self.assertEqual(self.actions()[-3:], ['resume','dispatch','signed'])
        self.assertEqual(len(procs), 3)  # cut-off attempt, receipt query, resend
        self.assertEqual((self.worker/'uses').read_text(), 'used\n')
        self.assertEqual(self.call(), result); self.assertEqual(self.calls, 3)

    @unittest.skipIf(os.getuid()==0,'real worker refuses root')
    def test_fence_lost_before_commit_resumes(self):
        # The helper never passed the fence (old server gone): nothing was dispatched.
        def gone(): raise BrokenPipeError()
        with self.assertRaises(BrokenPipeError): self.call(fence=gone)
        self.assertEqual(self.worker_receipt(dispatch_states=True)['state'], 'received')
        self.assertEqual(self.call()[0], self.spec['id'])
        self.assertEqual(self.actions()[-5:], ['request','not_released','resume','dispatch','signed'])
        self.assertEqual((self.worker/'uses').read_text(), 'used\n')

    @unittest.skipIf(os.getuid()==0,'real worker refuses root')
    def test_cut_off_after_commit_is_looked_up_not_resent(self):
        # C-601: committed, signed, the result lost on the way back. No operator
        # reconcile: the same Run's next call looks the stored output up.
        rid = self.spec['id']; real_line = host.line
        def lost(stream):
            data = real_line(stream)
            if data.startswith(b'{"sha256"'): raise host.Stopped('interrupted')
            return data
        with patch('host.line', lost), self.assertRaises(host.Stopped): self.call()
        self.assertEqual(self.worker_receipt(dispatch_states=True)['state'], 'signed')
        self.assertEqual(self.call(), (rid, digest(self.host/'outputs'/rid)))
        self.assertEqual(self.actions()[2:], ['request','dispatch','interrupted','lookup','reconcile','signed'])
        self.assertEqual((self.worker/'uses').read_text(), 'used\n')

    @unittest.skipIf(os.getuid()==0,'real worker refuses root')
    def test_committed_or_busy_request_is_never_resent(self):
        import fcntl
        from contextlib import closing
        def gone(): raise BrokenPipeError()
        with self.assertRaises(BrokenPipeError): self.call(fence=gone)
        # Another connection still holds the signer (e.g. the old helper is ending):
        # the resend is refused by the serial lock, then accepted once it is free.
        with (self.worker/'serial.lock').open('ab') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            with self.assertRaises(ValueError): self.call()
        self.assertEqual(self.actions()[-2:], ['resume','not_released'])
        # The signer took the commit and stopped before a result (crash while signing,
        # or an old signer whose pending is ambiguous): from here on lookup only.
        with closing(sqlite3.connect(self.worker/'audit.sqlite')) as db:
            db.execute("UPDATE receipts SET state='pending'"); db.commit()
        calls = self.calls
        with self.assertRaises(ValueError): self.call()
        self.assertEqual(self.actions()[-3:], ['lookup','reconcile','not_released'])
        self.assertEqual(self.calls, calls + 2)  # receipt query, lookup; no input sent
        data = self.candidate.read_bytes()
        src = io.BytesIO(canonical({'grant':self.spec,'mode':'sign','size':len(data)}).encode()+b'\n'+data+b'commit\n')
        dst = io.BytesIO()
        with self.assertRaises(ValueError): worker.serve(self.worker, src, dst)
        self.assertEqual(dst.getvalue(), b'')
        self.assertFalse((self.worker/'uses').exists())
        # Another grant under the same number is not a resend either.
        with closing(sqlite3.connect(self.worker/'audit.sqlite')) as db:
            db.execute("UPDATE receipts SET state='received'"); db.commit()
        other = {**self.spec, 'build': 'job-2'}
        src = io.BytesIO(canonical({'grant':other,'mode':'sign','size':len(data)}).encode()+b'\n'+data+b'commit\n')
        with self.assertRaises(ValueError): worker.serve(self.worker, src, io.BytesIO())
        with self.assertRaises(ValueError): worker.receipt(self.worker, other, dispatch_states=True)
        self.assertFalse((self.worker/'uses').exists())

    def test_receipt_states_for_new_and_old_hosts(self):
        absent = {'state':'absent','sha256':None}
        self.assertEqual(self.worker_receipt(dispatch_states=True), absent)  # no journal yet
        with self.assertRaises(Exception): self.worker_receipt()
        directory(self.worker, 'outputs')
        with sqlite3.connect(self.worker/'audit.sqlite') as db:
            db.execute('CREATE TABLE receipts(id TEXT PRIMARY KEY, spec TEXT, state TEXT, sha TEXT)')
        self.assertEqual(self.worker_receipt(dispatch_states=True), absent)
        with self.assertRaises(ValueError): self.worker_receipt()
        src = io.BytesIO(canonical({'grant':self.spec,'mode':'receipt','size':0,'dispatch_states':True}).encode()+b'\n')
        dst = io.BytesIO(); worker.serve(self.worker, src, dst)
        self.assertEqual(json.loads(dst.getvalue()), absent)

    def test_main_reports_acceptance_then_fences(self):
        out = directory(self.host,'outputs')/self.spec['id']
        save(out, 'signed-fixture')
        self.db.execute("UPDATE grants SET state='signed',output=?", (digest(out),))
        proc = subprocess.Popen([sys.executable, '-IB', str(HELPERS/'host.py'), str(self.host), 'request'],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        with proc:
            proc.stdin.write(canonical(self.ctx).encode()+b'\n'); proc.stdin.flush()
            self.assertEqual(proc.stdout.readline(), f'accepted {self.spec["id"]} 600 stored\n'.encode())
            self.assertEqual(proc.stdout.readline(), b'ready\n')
            proc.stdin.write(b'commit\n'); proc.stdin.close()
            self.assertEqual(proc.stdout.read(), f'{self.spec["id"]} {digest(out)}\n'.encode())
        self.assertEqual(proc.returncode, 0)

    def test_check_revalidates_a_remembered_receipt(self):
        rid = self.spec['id']
        out = directory(self.host,'outputs')/rid
        save(out, 'signed-fixture')
        def check(identity=self.ctx):
            return subprocess.run([sys.executable, '-IB', str(HELPERS/'host.py'), str(self.host), 'check', rid],
                                  input=canonical(identity).encode()+b'\n', capture_output=True)
        self.assertNotEqual(check().returncode, 0)  # approved, not signed
        self.db.execute("UPDATE grants SET state='signed',output=?", (digest(out),))
        done = check()
        self.assertEqual((done.returncode, done.stdout), (0, f'{rid} {digest(out)}\n'.encode()))
        self.assertNotEqual(check({**self.ctx, 'run': 'R-2'}).returncode, 0)
        events = self.actions()
        self.db.execute('UPDATE grants SET revoked=1')
        self.assertNotEqual(check().returncode, 0)
        self.db.execute('UPDATE grants SET revoked=0')
        with sqlite3.connect(self.host/'audit.sqlite') as db:
            db.execute('UPDATE grants SET spec=?', (canonical({**self.spec, 'expires': 1}),))
        self.assertNotEqual(check().returncode, 0)
        self.assertEqual(self.actions(), events)  # read-only: no audit rows, no bytes

    @unittest.skipUnless(os.path.exists('/usr/bin/ssh'), 'helper dials the fixed OpenSSH client')
    def test_terminated_helper_records_interrupted(self):
        proc = subprocess.Popen([sys.executable, '-IB', str(HELPERS/'host.py'), str(self.host), 'request'],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        with proc:
            # Approved but routed to a peer this fixture never answers: block before ready.
            save(self.host/'ssh.conf', 'Host fixture\n  ProxyCommand /bin/sleep 30\n')
            proc.stdin.write(canonical(self.ctx).encode()+b'\n'); proc.stdin.flush()
            self.assertTrue(proc.stdout.readline().startswith(f'accepted {self.spec["id"]} '.encode()))
            proc.terminate()
            self.assertNotEqual(proc.wait(timeout=10), 0)
        self.assertEqual(self.actions()[-2:], ['request', 'interrupted'])

    @unittest.skipUnless(os.path.exists('/usr/bin/ssh'), 'helper dials the fixed OpenSSH client')
    def test_orphaned_helper_interrupts_itself(self):
        # C-601: the server exits while its helper waits on the signer. The helper
        # notices it was orphaned, records interrupted and frees the connection.
        save(self.host/'ssh.conf', 'Host fixture\n  ProxyCommand /bin/sleep 30\n')
        parent = subprocess.run([sys.executable, '-IB', '-c', '''import subprocess, sys
p = subprocess.Popen([sys.executable, '-IB', sys.argv[1], sys.argv[2], 'request'],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
p.stdin.write(sys.stdin.buffer.readline()); p.stdin.flush()
sys.stdout.buffer.write(p.stdout.readline())''', str(HELPERS/'host.py'), str(self.host)],
            input=canonical(self.ctx).encode()+b'\n', capture_output=True, timeout=10)
        self.assertTrue(parent.stdout.startswith(f'accepted {self.spec["id"]} '.encode()))
        for _ in range(100):
            if self.actions()[-1:] == ['interrupted']: break
            time.sleep(0.1)
        self.assertEqual(self.actions()[-2:], ['request', 'interrupted'])
        self.assertEqual(self.db.execute('SELECT state FROM grants').fetchone(), ('pending',))

    @unittest.skipIf(os.getuid()==0,'real worker refuses root')
    def test_worker_historical_receipt_is_metadata_only(self):
        # Seed an already expired historical worker record; do not rely on the host's clock.
        expired = {**self.spec, 'expires': 1}
        sha = '8' * 64
        with sqlite3.connect(self.worker/'audit.sqlite') as db:
            db.execute('CREATE TABLE receipts(id TEXT PRIMARY KEY, spec TEXT, state TEXT, sha TEXT)')
            db.execute('INSERT INTO receipts VALUES(?,?,?,?)',(expired['id'],canonical(expired),'signed',sha))
        for mode in ('receipt','sign','lookup'):
            src=io.BytesIO(canonical({'mode':mode,'size':0,'grant':expired}).encode()+b'\n')
            dst=io.BytesIO()
            if mode == 'receipt':
                worker.serve(self.worker,src,dst)
                self.assertEqual(json.loads(dst.getvalue()),{'state':'signed','sha256':sha})
            else:
                with self.assertRaises(ValueError): worker.serve(self.worker,src,dst)
                self.assertEqual(dst.getvalue(),b'')
        self.assertFalse((self.worker/'uses').exists())

    @unittest.skipIf(os.getuid()==0,'real worker refuses root')
    def test_ios_pre_adapter_exits_all_lock_once(self):
        self.spec.update(platform='ios'); cfg={**json.loads(self.policy.read_bytes()),'platform':'ios'}
        data=self.candidate.read_bytes()
        for n,case in enumerate(('digest','disconnect','expiry','rotation','lock_failure')):
            with self.subTest(case=case):
                self.spec['id']=format(n+10,'032x'); save(self.policy,canonical(cfg))
                msg=canonical({'grant':self.spec,'mode':'sign','size':len(data)}).encode()+b'\n'
                src=io.BytesIO(msg+(b'X'*len(data) if case=='digest' else data)+(b'' if case=='disconnect' else b'commit\n'))
                class Reply(io.BytesIO):
                    def flush(inner):
                        if case=='rotation': save(self.policy,canonical({**cfg,'version':'changed'}))
                response=Reply()
                def fake_sign(_policy,_candidate,signed,_tmp): save(signed,'synthetic')
                clock=[self.spec['expires']-1,self.spec['expires']+1] if case=='expiry' else None
                from contextlib import nullcontext
                with patch('worker.lock_keychain',side_effect=ValueError if case=='lock_failure' else None) as lock, \
                     (patch('common.time.time',side_effect=clock) if clock else nullcontext()), self.assertRaises(ValueError):
                    worker.serve(self.worker,src,response,{'ios':fake_sign})
                lock.assert_called_once_with(cfg,self.worker)
                self.assertNotIn(b'sha256',response.getvalue())
                self.assertNotEqual(worker.receipt(self.worker,self.spec)['state'],'signed')

    def test_godot_paths_in_apk_but_not_ios_archive(self):
        signed = self.root/'signed.apk'
        platforms.android(json.loads(self.policy.read_bytes()), self.candidate, signed, self.root)
        with zipfile.ZipFile(signed) as z:
            self.assertEqual(z.read('assets/.godot/imported/icon.ctex'), b'fixture')
            self.assertIn('assets/.import', z.namelist())
            for name in AAPT2_SHORTENED:
                self.assertEqual(z.read(name), b'fixture')
            for pair in CASE_ONLY:
                for name in pair:
                    self.assertEqual(z.read(name), name.encode())
        tree = directory(self.root, 'tree')
        with self.assertRaises(SigningFailure) as caught: inspect_zip(self.candidate, tree)
        self.assertEqual(caught.exception.category, 'archive_member_name')
        self.assertFalse((tree/'assets/.godot').exists())

    def test_dash_segments_in_apk_but_not_ios_archive(self):
        for name in AAPT2_SHORTENED + ('-/item', 'res/-'):
            with self.subTest(name=name):
                with zipfile.ZipFile(self.candidate, 'w') as z:
                    z.writestr('AndroidManifest.xml', b'fixture'); z.writestr(name, b'fixture')
                self.assertIn(name, inspect_zip(self.candidate, apk=True))
                tree = directory(self.root, 'tree-'+hashlib.sha256(name.encode()).hexdigest()[:8])
                with self.assertRaises(SigningFailure) as caught: inspect_zip(self.candidate, tree)
                self.assertEqual(caught.exception.category, 'archive_member_name')
                self.assertFalse(tree.joinpath(*name.split('/')).exists())

    def test_case_only_names_in_apk_but_not_extracted_archives(self):
        for pair in CASE_ONLY + (('x/.Cache/other', 'x/.cache/file'), ('Res/-8.xml', 'res/-8.xml'),
                                 ('res/A', 'res/a/nested'), ('res/A/', 'res/a')):
            with self.subTest(pair=pair):
                with zipfile.ZipFile(self.candidate, 'w') as z:
                    z.writestr('AndroidManifest.xml', b'fixture')
                    for name in pair: z.writestr(name, b'' if name.endswith('/') else name.encode())
                self.assertLessEqual({n.removesuffix('/') for n in pair}, inspect_zip(self.candidate, apk=True))
                # Writing members to a tree keeps the alias rule, for APK flag or iOS archive.
                for apk in (False, True):
                    tree = directory(self.root, 'tree-%d-%s' % (apk, hashlib.sha256(repr(pair).encode()).hexdigest()[:8]))
                    with self.assertRaises(SigningFailure) as caught: inspect_zip(self.candidate, tree, apk=apk)
                    self.assertEqual(caught.exception.category, 'archive_member_name')

    def test_exact_duplicate_apk_members_still_rejected(self):
        for first, second in (('res/9n.9.png', 'res/9n.9.png'), ('res/9N.9.png', 'res/9N.9.png'),
                              ('AndroidManifest.xml', 'AndroidManifest.xml'), ('res/', 'res/'), ('res/x', 'res/x/')):
            with self.subTest(name=second):
                with zipfile.ZipFile(self.candidate, 'w') as z, warnings.catch_warnings():
                    warnings.simplefilter('ignore')  # zipfile warns on duplicate names
                    z.writestr('AndroidManifest.xml' if first != 'AndroidManifest.xml' else 'classes.dex', b'fixture')
                    z.writestr(first, b''); z.writestr(second, b'')
                with self.assertRaises(SigningFailure) as caught: inspect_zip(self.candidate, apk=True)
                self.assertEqual(caught.exception.category, 'archive_member_name')

    def test_real_godot_apk_name_list_passes_every_rule(self):
        names = godot_apk_names()
        self.assertEqual(len(names), GODOT_APK_MEMBERS)
        self.assertEqual(len(set(names)), GODOT_APK_MEMBERS)
        folded = {}
        for name in names: folded.setdefault(name.lower(), []).append(name)
        aliases = [group for group in folded.values() if len(group) > 1]
        self.assertEqual(len(aliases), GODOT_APK_CASE_PAIRS)
        self.assertTrue(all(len(group) == 2 for group in aliases))
        self.assertLessEqual({n for pair in CASE_ONLY for n in pair} | set(AAPT2_SHORTENED), set(names))
        with zipfile.ZipFile(self.candidate, 'w') as z:
            for name in names: z.writestr(name, name.encode())
        self.assertEqual(inspect_zip(self.candidate, apk=True), set(names))
        signed = self.root/'signed.apk'
        platforms.android(json.loads(self.policy.read_bytes()), self.candidate, signed, self.root)
        with zipfile.ZipFile(signed) as z:
            self.assertEqual(z.namelist(), names)
            for group in aliases:
                for name in group: self.assertEqual(z.read(name), name.encode())

    def test_apk_member_name_boundaries(self):
        for name in ('../other','assets/../x','./file','x/.','/absolute','ok//file','ok//',
                     'a\\b','x/line\nfeed','x/ctrl\x01','x/trailing.','x/trailing ',
                     'x/.cache/file/nested','x/.cache/file','x/.cache/file/',
                     '-/../x','res/-..','res/-.','res/- ','/-8.xml','res//-8.xml','res/-\x01',
                     'res/-8.xml','res/-8.xml/nested'):
            with self.subTest(name=name):
                with zipfile.ZipFile(self.candidate,'w') as z, warnings.catch_warnings():
                    warnings.simplefilter('ignore')  # zipfile warns on duplicate names
                    z.writestr('x/.cache/file',b'first'); z.writestr('res/-8.xml',b'first')
                    z.writestr(name,b'fixture')
                with self.assertRaises(SigningFailure) as caught: inspect_zip(self.candidate, apk=True)
                self.assertEqual(caught.exception.category, 'archive_member_name')

    def test_same_godot_member_requires_classic_zip(self):
        for path, zip64 in [(p, z) for p in ('assets/.godot/item', 'res/-8.xml') for z in (False, True)]:
            with self.subTest(path=path, zip64=zip64):
                with zipfile.ZipFile(self.candidate, 'w') as z:
                    z.writestr('AndroidManifest.xml', b'fixture')
                    with z.open(path, 'w', force_zip64=zip64) as member:
                        member.write(b'fixture')
                if zip64:
                    with self.assertRaises(ValueError): inspect_zip(self.candidate, apk=True)
                else:
                    self.assertIn(path, inspect_zip(self.candidate, apk=True))

    def test_apk_extra_fields_are_checked_by_tag(self):
        # An unrelated field may contain the same bytes as the ZIP64 tag.
        item = zipfile.ZipInfo('assets/.godot/item')
        for tag in (0xcafe, 0x0001):
            with self.subTest(tag=tag):
                item.extra = struct.pack('<HHQQ', tag, 16, 1, 1)
                with zipfile.ZipFile(self.candidate, 'w') as z:
                    z.writestr(item, b'x')
                if tag == 0x0001:
                    with self.assertRaises(ValueError): inspect_zip(self.candidate, apk=True)
                else:
                    self.assertIn(item.filename, inspect_zip(self.candidate, apk=True))

    def test_apk_keeps_other_archive_limits(self):
        with patch('archives.LIMIT',1), self.assertRaises(SigningFailure) as caught:
            inspect_zip(self.candidate, apk=True)
        self.assertEqual(caught.exception.category, 'archive_too_large')
        with zipfile.ZipFile(self.candidate,'a') as z:
            i=zipfile.ZipInfo('assets/.link'); i.external_attr=0o120777<<16; z.writestr(i,b'fixture')
        with self.assertRaises(ValueError): inspect_zip(self.candidate, apk=True)
        with zipfile.ZipFile(self.candidate,'w') as z:
            z.writestr('plain',b'fixture'); z.comment=b'comment'
        with self.assertRaises(ValueError): inspect_zip(self.candidate, apk=True)

    def test_hidden_signature_files_are_not_unsigned_inputs(self):
        for name in ('META-INF/KEY.SF', 'META-INF/.SF', 'META-INF/.rsa'):
            with self.subTest(name=name):
                with zipfile.ZipFile(self.candidate, 'w') as z:
                    z.writestr('AndroidManifest.xml', b'fixture'); z.writestr(name, b'fixture')
                with self.assertRaises(SigningFailure) as caught:
                    platforms.android({}, self.candidate, self.root/'unused', self.root)
                self.assertEqual(caught.exception.category, 'archive_invalid')


class DeviceArchive(unittest.TestCase):
    def test_nested_signatures_and_entitlement_denial(self):
        import datetime
        cert=b'synthetic-cert'; ident='test.fixture'; team='FIXTURE'; ent={'application-identifier':team+'.'+ident,'com.apple.developer.team-identifier':team}
        profile={'DeveloperCertificates':[cert],'TeamIdentifier':[team],'Platform':['iOS'],
                 'ExpirationDate':datetime.datetime(2099,1,1),'Entitlements':ent}
        with tempfile.TemporaryDirectory() as d:
            tmp=Path(d); profile_file=save(tmp/'profile','fixture'); e=save(tmp/'ent',plistlib.dumps(ent))
            c={'cert_sha256':hashlib.sha256(cert).hexdigest(),'app':ident,'team':team,'frameworks':{'Game.framework':'test.game'},
               'entitlements':str(e),'profile':str(profile_file),'profile_sha256':digest(profile_file),'keychain':str(save(tmp/'chain','test'))}
            src=tmp/'input.zip'; app='Game.xcarchive/Products/Applications/Game.app/'
            def binary(kind,platform): return struct.pack('<14I',0xfeedfacf,0x0100000c,0,kind,1,24,0,0,0x32,24,platform,0,0,0)
            with zipfile.ZipFile(src,'w') as z:
                z.writestr('Game.xcarchive/Info.plist',plistlib.dumps({'ApplicationProperties':{'ApplicationPath':'Applications/Game.app','CFBundleIdentifier':ident}}))
                z.writestr(app+'Info.plist',plistlib.dumps({'CFBundleExecutable':'Game','CFBundleIdentifier':ident,'CFBundlePackageType':'APPL','CFBundleSupportedPlatforms':['iPhoneOS']}))
                z.writestr(app+'Game',binary(2,2)); fw=app+'Frameworks/Game.framework/'
                z.writestr(fw+'Info.plist',plistlib.dumps({'CFBundleExecutable':'Game','CFBundleIdentifier':'test.game','CFBundlePackageType':'FMWK'})); z.writestr(fw+'Game',binary(6,2))
            calls=[]
            def tools(cwd,argv,diagnostics=False):
                args=list(map(str,argv)); calls.append(args)
                if 'cms' in args:return plistlib.dumps(profile)
                if '--verbose=4' in args:return ('TeamIdentifier='+team+'\nIdentifier='+('test.game' if args[-1].endswith('.framework') else ident)).encode()
                if any(a.startswith('--extract-certificates=') for a in args):save(cwd/'leaf0',cert)
                if '--display' in args and '--entitlements' in args:return plistlib.dumps({} if args[-1].endswith('.framework') else ent)
                return b''
            with patch('platforms.tool',tools):
                scratch=directory(tmp,'work'); out=tmp/'out.zip'; platforms.ios(c,src,out,scratch)
                self.assertEqual([Path(a[-1]).name for a in calls if '--sign' in a],['Game.framework','Game.app']); self.assertIn('--deep',sum(calls,[]))
                with zipfile.ZipFile(out) as z:self.assertIn(app+'embedded.mobileprovision',z.namelist())
                profile['Entitlements']={}
                with self.assertRaises(KeyError):platforms.ios(c,src,tmp/'refused',directory(tmp,'refused-work'))
                self.assertFalse((tmp/'refused').exists())
                with zipfile.ZipFile(src,'a') as z:z.writestr(app+'unknown',binary(6,2))
                with self.assertRaises(ValueError):platforms.ios(c,src,tmp/'refused',directory(tmp,'bad-target'))


if __name__=='__main__':
    os.umask(0o077); unittest.main()
