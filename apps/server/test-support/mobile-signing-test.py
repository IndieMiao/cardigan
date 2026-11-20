"""Synthetic protocol and platform tests: never consult a real signing account."""
import hashlib
import io
import json
import os
from pathlib import Path
import plistlib
import sqlite3
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import zipfile

HELPERS = Path(__file__).resolve().parents[3] / 'deploy' / 'mobile-signing'
sys.path.insert(0, str(HELPERS))
from archives import inspect_zip
from common import SCOPE, canonical, digest, directory, scope
import host
import platforms


def save(path, data):
    path.write_bytes(data.encode() if isinstance(data,str) else data)
    path.chmod(0o600)
    return path


class Signing(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.host = directory(self.root,'control'); self.worker=directory(self.root,'signer')
        self.db=host.ledger(self.host); self.addCleanup(self.db.close)
        self.candidate=self.host/'candidate'
        with zipfile.ZipFile(self.candidate,'w') as z:
            z.writestr('AndroidManifest.xml',b'fixture')
        self.candidate.chmod(0o600)
        self.spec={'id':'1'*32,'version':'test-v1','app':'test.fixture','build':'job-1','commit':'b'*40,
                   'sha256':digest(self.candidate),'expires':int(time.time())+600,'platform':'android',
                   'project':'example','machine':'worker','run':'R-1','card':'C-1','assignment':'A-1','worker_uid':os.getuid()+1}
        self.ctx={k:self.spec[k] for k in SCOPE}; self.calls=0
        route={k:self.spec[k] for k in ('project','machine','platform','version','app')}
        save(self.host/'routes.json',canonical([{**route,'peer':'fixture'}]))
        def program(name,body):
            p=save(self.worker/name,'#!/usr/bin/python3\n'+body); p.chmod(0o700); return str(p)
        config={**route,'cert_sha256':'a'*64,'alias':'fixture',
                'aapt2':program('fixture-aapt','print("test.fixture")'),
                'apksigner':program('fixture-signer','''import sys, pathlib, shutil
p=pathlib.Path(__file__).with_name('uses')
if sys.argv[1]=='sign':
    with p.open('a') as f: f.write('used\\n')
    assert sys.argv[3].endswith('keystore') and '--out' in sys.argv
    shutil.copyfile(sys.argv[-1],sys.argv[sys.argv.index('--out')+1])
    with open(sys.argv[sys.argv.index('--out')+1],'ab') as f: f.write(b'fixture-signed')
else: print('Signer #1 certificate SHA-256 digest: '+'a'*64)
''')}
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

    @unittest.skipIf(os.getuid()==0,'real worker refuses to use a root signing identity')
    def test_once_reconcile_then_export(self):
        rid=self.spec['id']; out=self.host/'outputs'/rid
        # Simulate an unavailable success journal after worker signing, before host release.
        self.db.execute("CREATE TRIGGER interrupt BEFORE UPDATE OF output ON grants BEGIN SELECT RAISE(ABORT,'fixture'); END")
        with self.assertRaises(sqlite3.DatabaseError): self.call()
        with self.assertRaises(ValueError): host.checked_output(self.db,rid,out)
        self.db.execute('DROP TRIGGER interrupt')
        self.assertEqual(self.call(),(rid,digest(out))); self.assertEqual(self.calls,2)
        self.assertEqual(self.call(),(rid,digest(out))); self.assertEqual(self.calls,2)
        self.assertEqual((self.worker/'uses').read_text(),'used\n')
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
        self.assertEqual((self.worker/'uses').read_text(),'used\n')

    def test_unsafe_archive_members_are_refused(self):
        for name,mode in [('../other',0),('/other',0),('ok/link',0o120777),('a\\b',0),('x/Foo',0)]:
            with self.subTest(name=name):
                with zipfile.ZipFile(self.candidate,'w') as z:
                    z.writestr('x/foo',b'first'); i=zipfile.ZipInfo(name);i.external_attr=mode<<16;z.writestr(i,b'fixture')
                with self.assertRaises(ValueError): inspect_zip(self.candidate)
        with patch('archives.LIMIT',1),self.assertRaises(ValueError): inspect_zip(self.candidate)


class DeviceArchive(unittest.TestCase):
    def test_nested_signatures_and_lock_even_on_denial(self):
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
                self.assertEqual([Path(a[-1]).name for a in calls if '--sign' in a],['Game.framework','Game.app']); self.assertIn('lock-keychain',calls[-1]); self.assertIn('--deep',sum(calls,[]))
                with zipfile.ZipFile(out) as z:self.assertIn(app+'embedded.mobileprovision',z.namelist())
                profile['Entitlements']={}
                with self.assertRaises(KeyError):platforms.ios(c,src,tmp/'refused',directory(tmp,'refused-work'))
                self.assertIn('lock-keychain',calls[-1]); self.assertFalse((tmp/'refused').exists())
                with zipfile.ZipFile(src,'a') as z:z.writestr(app+'unknown',binary(6,2))
                with self.assertRaises(ValueError):platforms.ios(c,src,tmp/'refused',directory(tmp,'bad-target'))
                self.assertIn('lock-keychain',calls[-1])


if __name__=='__main__':
    os.umask(0o077); unittest.main()
