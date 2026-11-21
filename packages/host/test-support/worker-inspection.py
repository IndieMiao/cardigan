"""No production homes, worker accounts, terminals, credentials or processes."""
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

probe = runpy.run_path(str(Path(__file__).resolve().parents[3] / 'deploy/inspect-worker.py'))


class CollectorTest(unittest.TestCase):
    def test_hc_fixed_protocol(self):
        labels = dict(cardigan='1', project='test', assignment='A-1', run='R-8')
        t = dict(labels=labels, address='t2', state='live', pid=None, created_ms=15)
        # Use a short synthetic socket path even when the runner TMPDIR is long.
        with tempfile.TemporaryDirectory() as raw, socket.socket(socket.AF_UNIX) as server:
            root = Path(raw).resolve()
            sockdir = root / '.local/state/herdr-core/s'
            sockdir.mkdir(parents=True)
            old = os.getcwd()
            os.chdir(root)
            self.addCleanup(os.chdir, old)
            path = Path('.local/state/herdr-core/s/s.sock')
            server.bind(str(path)); server.listen(1); server.settimeout(2)
            requests = []

            def serve():
                with server.accept()[0] as conn, conn.makefile('rb') as f:
                    for line in f:
                        q = json.loads(line); requests.append((q['method'], q['params']))
                        result = {'hello':dict(generation=1, framed=False),
                                  'terminal.list':{'terminals':[dict(t, labels={}), dict(t,address='peer/t1'), t]},
                                  'terminal.get':t, 'terminal.read':{'text':'old\n'*30+'sk-sensitivecontent\n-----BEGIN PRIVATE KEY-----\nsecretMaterial\nsecrets.env\nWorking (esc to interrupt)'}}[q['method']]
                        conn.sendall((json.dumps(dict(jsonrpc='2.0', id=q['id'], result=result))+'\n').encode())
            thread = threading.Thread(target=serve, daemon=True); thread.start()
            # Use the relative socket name only for connect; collector still checks absolute canonical path/owner.
            connect = socket.socket.connect
            with patch.object(socket.socket,'connect',lambda s,p:connect(s,os.path.relpath(p,root))):
                rows,pids = probe['terminals'](root,'s',labels,None)
            thread.join(2); self.assertFalse(thread.is_alive()); self.assertFalse(pids)
            self.assertEqual([m for m,_ in requests],['hello','terminal.list','terminal.read','terminal.get'])
            self.assertEqual(requests[2][1],{'terminal':'t2','lines':0}); self.assertEqual(rows[0]['screen'],['[redacted]']*11+['working'])
            os.chdir(old)

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
                        user='worker',gid=3333,terminal=None,harness='codex',legacy=False,launch_run='R-1',
                        helpers=[str(folder/'published'),None,None],process=None)
            user=SimpleNamespace(pw_name='worker',pw_gid=3333,pw_dir=root)
            with patch.dict(probe['main'].__globals__, native={'isolation_groups':lambda *x:None,'process_groups':lambda:[]}), \
                    patch('pwd.getpwuid',return_value=user), patch('grp.getgrgid',return_value=SimpleNamespace(gr_name='worker')), \
                    patch('os.geteuid',return_value=3333), patch('os.getuid',return_value=3333), patch('os.getegid',return_value=3333):
                evidence=probe['main'](conf)
                self.assertEqual(evidence['markers'],['identity','published']); self.assertIsNone(evidence['terminals']); self.assertIsNone(evidence['processes'])
                self.assertEqual(evidence['helpers'][0],__import__('hashlib').sha256(b'').hexdigest()); self.assertGreater(evidence['free_bytes'],0)
                self.assertEqual(evidence['events'],[dict(type='response_item',time='2026-01-01T00:00:00Z')]); self.assertNotIn('private',json.dumps(evidence))
                wrong=probe['main'](dict(conf,target='changed'));self.assertIsNone(wrong['markers']);self.assertIsNone(wrong['events'])

    def test_process(self):
        child=MagicMock(); child.__enter__.return_value=child
        child.stdout=io.BytesIO(f'{os.getuid()} 44 01:02 2.5 /bin/codex resume --model secret-name --token private'.encode())
        with patch('subprocess.Popen',return_value=child) as call:
            self.assertEqual(probe['process'](44),[dict(pid=44,elapsed='01:02',cpu=2.5,command='codex resume --model [redacted] [redacted]')]); self.assertEqual(call.call_args.args[0][0],'/bin/ps')

if __name__=='__main__':
    unittest.main()
