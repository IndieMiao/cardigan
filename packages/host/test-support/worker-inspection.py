"""No production homes, worker accounts, terminals, credentials or processes."""
import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import socket
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch, MagicMock

deploy = Path(__file__).resolve().parents[3] / 'deploy'
probe = runpy.run_path(str(deploy / 'inspect-worker.py'))
native = runpy.run_path(str(deploy / 'worker-primitives.py'))


class CollectorTest(unittest.TestCase):
    def hc_fixture(self, system, change=None):
        labels = dict(cardigan='1', project='test', assignment='A-1', run='R-8')
        t = dict(labels=labels, address='t2', state='live', pid=None, created_ms=15, foreground={'pid':42})
        snapshots = [t, {**t, **({'foreground':{'pid':43}} if change == 'foreground' else
                                {'state':'finished'} if change == 'exit' else {})}]
        with tempfile.TemporaryDirectory() as raw, socket.socket(socket.AF_UNIX) as server, contextlib.ExitStack() as stack:
            root = Path(raw).resolve()
            path = (Path('herdr-core/s.sock') if system == 'linux' else Path('.local/state/herdr-core/s/s.sock'))
            (root / path.parent).mkdir(parents=True)
            old = os.getcwd(); os.chdir(root); stack.callback(os.chdir, old)
            server.bind(str(path)); server.listen(1); server.settimeout(2)
            requests = []
            def serve():
                with server.accept()[0] as conn, conn.makefile('rb') as f:
                    for line in f:
                        q = json.loads(line); requests.append((q['method'], q['params']))
                        if q['method'] == 'terminal.get':
                            result = snapshots.pop(0)
                        else:
                            result = {'hello':dict(generation=1, framed=False),
                                      'terminal.list':{'terminals':[dict(t, labels={}), dict(t,address='peer/t1'), t]},
                                      'terminal.read':{'text':'old\n'*30+'secret material\nWorking (esc to interrupt)'}}[q['method']]
                        conn.sendall((json.dumps(dict(jsonrpc='2.0', id=q['id'], result=result))+'\n').encode())
            thread = threading.Thread(target=serve, daemon=True); thread.start()
            connect = socket.socket.connect
            stack.enter_context(patch.object(socket.socket,'connect',lambda s,p:connect(s,os.path.relpath(p,root))))
            stack.enter_context(patch.dict(os.environ, XDG_RUNTIME_DIR=str(root)))
            stack.enter_context(patch('os.getpgid',return_value=42))
            birth = dict(uid=os.getuid(),start=100)
            observations = [birth, dict(birth,start=101) if change == 'birth' else birth]
            stack.enter_context(patch.dict(probe['terminals'].__globals__,native={'identity': lambda *x: observations.pop(0)},
                                           process=lambda p:[{'pid':p}]))
            rows,pids = probe['terminals'](root,'s',labels,None,system)
            thread.join(2); self.assertFalse(thread.is_alive())
            self.assertEqual([m for m,_ in requests],['hello','terminal.list','terminal.get','terminal.read','terminal.get'])
            self.assertEqual(requests[3][1],{'terminal':'t2','lines':0})
            if change != 'exit':
                self.assertEqual(rows[0]['screen'],['[redacted]']*11+['working'])
            self.assertEqual(pids, [] if change else [{'pid':42}])

    def test_hc_fixed_protocol_and_birth_fence(self):
        for system in ['linux','darwin']:
            for change in [None,'foreground','exit','birth']:
                with self.subTest(system=system,change=change): self.hc_fixture(system,change)

    def test_transcript_metadata_no_links(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw).resolve(); logs = root/'project'; logs.mkdir()
            stamp = '2026-01-01T00:00:00Z'
            event = json.dumps(dict(timestamp=stamp,type='event_msg',payload={'encrypted_content':'sensitive'}))+'\n'
            (logs/'one.jsonl').write_text(event*12+json.dumps(dict(type='secret',timestamp='env=secret'))+'\n')
            (root/'other').write_text(event.replace('event_msg','assistant')); (logs/'two.jsonl').symlink_to(root/'other')
            (logs/'link').symlink_to(root, target_is_directory=True)
            self.assertEqual(probe['log_events'](logs),[dict(type='event_msg',time=stamp)]*8)
            (logs/'one.jsonl').unlink(); self.assertEqual(probe['log_events'](logs),[])

    def test_incomplete_log_search_is_unknown(self):
        with tempfile.TemporaryDirectory() as raw:
            logs = Path(raw).resolve(); transcript = logs/'a.jsonl'
            event = dict(type='event_msg', timestamp='2026-01-01T00:00:00Z')
            transcript.write_text(json.dumps(event)+'\n'+json.dumps(dict(event,payload='x'*140000))+'\n')
            self.assertIsNone(probe['log_events'](logs))
            with transcript.open('a') as f: f.write((json.dumps(event)+'\n')*8)
            self.assertEqual(len(probe['log_events'](logs)),8)
            for i in range(512): (logs/str(i)).touch()
            self.assertIsNone(probe['log_events'](logs))

    def test_generation_markers_and_helpers(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw).resolve()
            generation = 'a' * 32
            base = root/'runs/fixture/A-1'
            folder = base/'generations'/generation
            folder.mkdir(parents=True)
            identity = dict(version=1,assignment='A-1',project='fixture',run='R-1',target='pin',generation=generation)
            (folder/'identity').write_text(json.dumps(identity)); (folder/'published').touch()
            (folder/'revoked').symlink_to(folder/'published')
            sessions = base/'sessions'/generation/'codex/sessions'
            sessions.mkdir(parents=True); (sessions/'one.jsonl').write_text(json.dumps(dict(type='response_item',timestamp='2026-01-01T00:00:00Z',encrypted_content='private')))
            conf = dict(root=str(root),project='fixture',assignment='A-1',generation=generation,session='s',target='pin',
                        user='worker',gid=3333,terminal=None,harness='codex',local=False,live=True,platform='linux',launch_run='R-1',
                        helpers=[str(folder/'published'),None,None],process=None)
            user=SimpleNamespace(pw_name='worker',pw_gid=3333,pw_dir=root)
            with patch.dict(probe['main'].__globals__, native={'project_account':lambda r:self.assertEqual(r['project'],'fixture')}), \
                    patch('platform.system',return_value='Linux'), patch('pwd.getpwuid',return_value=user), patch('grp.getgrgid',return_value=SimpleNamespace(gr_name='worker')), \
                    patch('os.geteuid',return_value=3333), patch('os.getuid',return_value=3333), patch('os.getegid',return_value=3333):
                evidence=probe['main'](conf)
                self.assertEqual(evidence['markers'],['identity','published']); self.assertIsNone(evidence['terminals']); self.assertIsNone(evidence['processes'])
                self.assertEqual(evidence['helpers'][0],__import__('hashlib').sha256(b'').hexdigest()); self.assertGreater(evidence['free_bytes'],0)
                self.assertEqual(evidence['events'],[dict(type='response_item',time='2026-01-01T00:00:00Z')]); self.assertNotIn('private',json.dumps(evidence))
                wrong=probe['main'](dict(conf,target='changed'));self.assertIsNone(wrong['markers']);self.assertIsNone(wrong['events'])

                # Local launch UUID is an hc label only. Local CLI home is the
                # Assignment root, not the remote generations/sessions layout.
                local_logs=base/'codex/sessions'; local_logs.mkdir(parents=True)
                (local_logs/'local.jsonl').write_text(json.dumps(dict(type='assistant',timestamp='2026-01-01T00:00:00Z')))
                uid='cad0f00d-aaaa-4bbb-8000-aaaaaaaaaaaa'
                with patch.dict(probe['main'].__globals__,terminals=MagicMock(return_value=([{'address':'t2'}],[]))):
                    local=probe['main'](dict(conf,local=True,terminal='t2',generation=uid))
                    self.assertIsNone(local['markers']); self.assertEqual(local['events'][0]['type'],'assistant')
                    self.assertEqual(probe['main'].__globals__['terminals'].call_args.args[2]['generation'],uid)

    def test_account_and_claim_before_observation(self):
        user = SimpleNamespace(pw_name='worker',pw_gid=3333,pw_uid=3333,pw_dir='/test/home')
        conf = dict(user='worker',gid=3333,root='/test/root',project='fixture',assignment='A-1',generation=None,platform='linux')
        marker = MagicMock(side_effect=ValueError('isolation_claim')); terminals = MagicMock()
        for fault in ['alias','gid','group','wrong_project']:
            with self.subTest(fault=fault), contextlib.ExitStack() as stack:
                for key, val in [('getuid',3333),('geteuid',3333),('getgid',3333),('getegid',3333),('getgroups',[3333]),('getgrouplist',[3333])]:
                    stack.enter_context(patch('os.'+key,return_value=val))
                stack.enter_context(patch('platform.system',return_value='Linux'))
                stack.enter_context(patch('pwd.getpwuid',return_value=user));stack.enter_context(patch('pwd.getpwnam',return_value=user))
                peers = [SimpleNamespace(pw_name='peer',pw_uid=3333 if fault=='alias' else 999,pw_gid=3333 if fault=='gid' else 999)]
                stack.enter_context(patch('pwd.getpwall',return_value=[user,*peers]))
                stack.enter_context(patch('grp.getgrgid',return_value=SimpleNamespace(gr_name='worker',gr_mem=['peer'] if fault=='group' else [])))
                stack.enter_context(patch.dict(probe['main'].__globals__,native=native,terminals=terminals))
                # Only the clean account may advance to the project namespace check.
                stack.enter_context(patch.dict(native['project_account'].__globals__,isolation_directory=marker))
                with self.assertRaisesRegex(ValueError,'isolation_claim' if fault=='wrong_project' else 'isolation_account'):
                    probe['main'](conf)
                terminals.assert_not_called()
        marker.assert_called_once()

    def test_process(self):
        child=MagicMock(); child.__enter__.return_value=child
        child.stdout=io.BytesIO(f'{os.getuid()} 44 01:02 2.5 /bin/codex resume --model secret-name --token private'.encode())
        with patch('subprocess.Popen',return_value=child) as call:
            self.assertEqual(probe['process'](44),[dict(pid=44,elapsed='01:02',cpu=2.5,command='codex resume --model [redacted] [redacted]')]); self.assertEqual(call.call_args.args[0][0],'/bin/ps')

if __name__=='__main__':
    unittest.main()
