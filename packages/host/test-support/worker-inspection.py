"""No production homes, worker accounts, terminals, credentials or processes."""
import contextlib
import io
import json
import os
from pathlib import Path
import re
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
    def test_legacy_loopback_layout_is_distinct_from_project_worker(self):
        user = SimpleNamespace(pw_name='agent', pw_gid=2001, pw_dir='/var/lib/cardigan-agent')
        def info(uid, gid, mode):
            return SimpleNamespace(st_uid=uid, st_gid=gid, st_mode=mode, st_nlink=1)
        c = dict(local=True, platform='linux', gid=2002, root='/worker')
        with contextlib.ExitStack() as stack:
            for name, number in [('getgid', 2001), ('getegid', 2001), ('getuid', 3000), ('getgroups', [2001, 2002])]:
                stack.enter_context(patch('os.' + name, return_value=number))
            stack.enter_context(patch('grp.getgrgid', side_effect=lambda g: SimpleNamespace(gr_name={2001:'agent', 2002:'cardigan-share'}[g])))
            stack.enter_context(patch.dict(probe['managed_loopback_account'].__globals__, directory=contextlib.nullcontext))
            stack.enter_context(patch('os.fstat', side_effect=lambda fd: info(0,2001,0o750) if fd == user.pw_dir else info(4000,2002,0o2750)))
            marker = stack.enter_context(patch('os.stat', return_value=info(0,2001,0o100600)))
            probe['managed_loopback_account'](c,user)
            for invalid in [dict(c, local=False), dict(c, platform='darwin')]:
                with self.assertRaises(ValueError): probe['managed_loopback_account'](invalid,user)
            marker.return_value = info(3000,2001,0o100600)
            with self.assertRaises(ValueError): probe['managed_loopback_account'](c,user)

    def test_retirement_projection_of_bound_loopback_socket(self):
        binding = dict(project='fixture', assignment='A-1', launch_run='R-4', generation='launch',
                       session='fixture', terminal='t2', local=True, platform='linux')
        labels = dict(cardigan='1', project='fixture', assignment='A-1', run='R-4', generation='launch')
        terminal = dict(address='t2', labels=labels, pid=123, state='live', created_ms=42, text='never exported')
        def rpc(method, params):
            self.assertEqual((method, params), ('terminal.get', dict(terminal='t2')))
            return terminal
        account = MagicMock()
        with contextlib.ExitStack() as stack:
            for name in ('getuid','geteuid'): stack.enter_context(patch('os.' + name, return_value=1001))
            stack.enter_context(patch('pwd.getpwuid',return_value=SimpleNamespace(pw_dir='/unused')))
            stack.enter_context(patch('platform.system',return_value='Linux'))
            ps = stack.enter_context(patch('os.stat',return_value=SimpleNamespace(st_uid=1001)))
            stack.enter_context(patch.dict(probe['retirement_terminal'].__globals__,
                managed_loopback_account=account, core_rpc=lambda *args: contextlib.nullcontext(rpc)))
            read = lambda: probe['retirement_terminal'](binding)
            self.assertNotIn('text', read()); account.assert_called_once(); ps.assert_called_once_with('/proc/123')
            for key in labels:
                with patch.dict(labels,{key:'changed'}), self.assertRaises(ValueError): read()
            with patch.dict(terminal, pid=None), self.assertRaises(ValueError): read()
            with patch.dict(terminal, address='t3'), self.assertRaises(ValueError): read()
            with patch.dict(terminal,status=dict(state='working')): self.assertEqual(read()['status']['state'], 'blocked')
            ps.return_value=SimpleNamespace(st_uid=2)
            with self.assertRaises(ValueError): read()
            with patch.dict(terminal,state='finished',pid=None): self.assertEqual(read()['state'], 'finished')

    def hc_fixture(self, system, change=None, launch=False):
        labels = dict(cardigan='1', project='test', assignment='A-1', run='R-8')
        t = dict(labels=labels, address='t2', state='live', pid=None, created_ms=15, foreground={'pid':42})
        if launch:
            t['pid'] = 42
        if change == 'no_candidates':
            t.update(state='finished', foreground=None)
        elif change == 'partial':
            t['pid'] = 43
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
            def sample(p):
                if change in ('unavailable', 'partial') and p == 42:
                    raise OSError('synthetic unavailable sample')
                return [{'pid':p}]
            def identity(_, pid, *args):
                if change == 'unverified':
                    return None
                return dict(birth, start=101 if change == 'birth' and sampler.called else 100)
            sampler = MagicMock(side_effect=sample)
            stack.enter_context(patch.dict(probe['terminals'].__globals__, native={'identity': identity}, process=sampler))
            usage = MagicMock(return_value=dict(source='process', cpu_ms=1, memory_bytes=2, elapsed_ms=3))
            stack.enter_context(patch.dict(probe['terminal_launch'].__globals__, resources=usage))
            rows,pids = probe['terminals'](root,'s',labels,None,system,launch)
            thread.join(2); self.assertFalse(thread.is_alive())
            methods = ['hello','terminal.list'] + ([] if change == 'no_candidates' else ['terminal.get'])
            self.assertEqual([m for m,_ in requests], methods + ['terminal.read','terminal.get'])
            self.assertEqual(requests[-2][1],{'terminal':'t2','lines':0})
            if change != 'exit':
                self.assertEqual(rows[0]['screen'],['[redacted]']*11+['working'])
                # C-849: no status from hc is named, not a failed read; a
                # finished terminal has no activity to name.
                self.assertEqual(rows[0].get('_activity'), None if change == 'no_candidates' else 'activity_not_reported')
            if launch:
                # C-806: the failed launch's own tail, bounded; the CLI's resources.
                self.assertEqual(rows[0]['launch'], dict(state='live', tail=['old']*18+['secret material','Working (esc to interrupt)'],
                                                         resources=usage.return_value))
                usage.assert_called_once_with(42, system)
            elif change != 'exit':
                self.assertNotIn('launch', rows[0])
            expected = {None: [{'pid':42}], 'partial': [{'pid':43}], 'no_candidates': []}
            self.assertEqual(pids, expected.get(change))
            if change == 'unavailable':
                sampler.assert_called_once_with(42)

    def test_hc_fixed_protocol_and_birth_fence(self):
        for system in ['linux','darwin']:
            for change in [None,'foreground','exit','birth','unavailable','unverified','partial','no_candidates']:
                with self.subTest(system=system,change=change): self.hc_fixture(system,change)
            with self.subTest(system=system,launch=True): self.hc_fixture(system,None,True)

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
                    patch('os.geteuid',return_value=3333), patch('os.getuid',return_value=3333), patch('os.getegid',return_value=3333), \
                    patch.dict(os.environ, XDG_RUNTIME_DIR=str(root/'no-runtime')):
                evidence=probe['main'](conf)
                # C-746: each null names its failed read (no core socket, no
                # registered CLI); a present field carries no reason.
                self.assertEqual(evidence['unavailable'], dict(terminals='core_socket_missing', processes='no_registered_process'))
                self.assertEqual(probe['main'](dict(conf, live=False))['unavailable'], {})
                self.assertEqual(probe['main'](dict(conf, harness=None))['unavailable']['events'], 'harness_unknown')
                self.assertEqual(probe['main'](dict(conf, local=True))['unavailable']['events'], 'session_not_published')
                self.assertEqual(evidence['markers'],['identity','published']); self.assertIsNone(evidence['terminals']); self.assertIsNone(evidence['processes'])
                self.assertEqual(evidence['helpers'][0],__import__('hashlib').sha256(b'').hexdigest()); self.assertGreater(evidence['free_bytes'],0)
                self.assertEqual(evidence['events'],[dict(type='response_item',time='2026-01-01T00:00:00Z')]); self.assertNotIn('private',json.dumps(evidence))
                wrong=probe['main'](dict(conf,target='changed'));self.assertIsNone(wrong['markers']);self.assertIsNone(wrong['events'])
                self.assertEqual(wrong['unavailable']['events'], 'launch_markers_unreadable')

                # Journal fallback also distinguishes an unreadable saved PID
                # from an hc observation with no candidates.
                saved = dict(machine='pin', terminal=generation, uid=3333, pid=42, process_group=42, start='one')
                no_sample = MagicMock(side_effect=OSError('synthetic unavailable sample'))
                primitives = dict(project_account=lambda _: None, identity=lambda *args: saved)
                with patch.dict(probe['main'].__globals__, native=primitives, terminals=lambda *args: ([], []), process=no_sample):
                    empty = probe['main'](conf)
                    self.assertEqual(empty['processes'], [])
                    # The core answered but holds no row for this terminal.
                    self.assertEqual(empty['unavailable'], dict(terminals='terminal_not_registered'))
                    unconfirmed = probe['main'](dict(conf, process=saved))
                    self.assertIsNone(unconfirmed['processes'])
                    self.assertEqual(unconfirmed['unavailable']['processes'], 'process_unconfirmed')
                    no_sample.assert_called_once_with(42)
                for birth, reason in [(None, 'process_identity_unreadable'), (dict(saved, start='two'), 'process_identity_changed')]:
                    changed = dict(primitives, identity=lambda *args, b=birth: b)
                    with patch.dict(probe['main'].__globals__, native=changed, terminals=lambda *args: ([], None)):
                        result = probe['main'](dict(conf, process=saved))
                        self.assertIsNone(result['processes'])
                        self.assertEqual(result['unavailable'], dict(terminals='terminal_unconfirmed', processes=reason))
                with patch.dict(probe['main'].__globals__, native=primitives, terminals=lambda *args: ([], [])):
                    self.assertEqual(probe['main'](dict(conf, process=dict(saved, terminal='other')))['unavailable'],
                                     dict(terminals='terminal_not_registered'))

    def test_owner_session_lists_enrolled_cli_and_names_absent_activity(self):
        # C-849: on a macOS worker hc reports only the idle owner (the
        # terminal's own program). The journaled CLI receipt, re-proved by
        # its birth identity, is listed with it; a live terminal without
        # activity names why instead of leaving a bare null.
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw).resolve()
            generation = 'b' * 32
            folder = root/'runs/fixture/A-1/generations'/generation
            folder.mkdir(parents=True)
            (folder/'identity').write_text(json.dumps(dict(version=1,assignment='A-1',project='fixture',run='R-1',target='pin',generation=generation)))
            (folder/'published').touch()
            conf = dict(root=str(root),project='fixture',assignment='A-1',generation=generation,session='s',target='pin',
                        user='worker',gid=3333,terminal='t2',harness='claude-code',local=False,live=True,platform='darwin',launch_run='R-1',
                        helpers=[None,None,None],process=None)
            user=SimpleNamespace(pw_name='worker',pw_gid=3333,pw_dir=root)
            saved = dict(machine='pin', terminal=generation, uid=3333, pid=54997, process_group=54989, start='one')
            owner = dict(pid=54989, elapsed='10:00', cpu=0.0, command='python3 [redacted] -c [redacted] [redacted]')
            cli = dict(pid=54997, elapsed='09:59', cpu=0.0, command='claude [redacted] [redacted] [redacted] [redacted]')
            row = dict(address='t2', state='live', activity=None, screen=[], _activity='activity_not_reported')
            primitives = dict(project_account=lambda _: None, identity=lambda *args: saved)
            with patch('platform.system',return_value='Darwin'), patch('pwd.getpwuid',return_value=user), patch('grp.getgrgid',return_value=SimpleNamespace(gr_name='worker')), \
                    patch('os.geteuid',return_value=3333), patch('os.getuid',return_value=3333), patch('os.getegid',return_value=3333), \
                    patch.dict(probe['main'].__globals__, native=primitives, terminals=lambda *args: ([dict(row)], [owner]),
                               process=lambda pid: [cli] if pid == 54997 else []):
                idle = probe['main'](dict(conf, process=saved))
                self.assertEqual(idle['processes'], [owner, cli])
                self.assertEqual(idle['terminals'], [dict(address='t2', state='live', activity=None, screen=[])])
                self.assertEqual(idle['unavailable'], dict(activity='activity_not_reported', events='transcript_unreadable'))
                # Without the receipt only the owner is visible, as before.
                self.assertEqual(probe['main'](conf)['processes'], [owner])

    def test_unavailable_reasons_are_bounded_codes(self):
        # C-746: a failed read maps to a fixed code; no message text crosses.
        reasons = probe['unavailable']
        self.assertEqual(reasons(FileNotFoundError('/private/path')), 'core_socket_missing')
        self.assertEqual(reasons(ConnectionRefusedError()), 'core_not_listening')
        self.assertEqual(reasons(socket.timeout()), 'core_timeout')
        self.assertEqual(reasons(PermissionError()), 'permission_denied')
        self.assertEqual(reasons(OSError('other')), 'core_unreachable')
        self.assertEqual(reasons(KeyError('result')), 'core_reply_incomplete')
        self.assertEqual(reasons(ValueError('secret')), 'core_reply_invalid')
        self.assertEqual(reasons(probe['Unavailable']('core_error')), 'core_error')
        self.assertIsInstance(probe['Unavailable']('x'), ValueError)
        # An error reply (e.g. an address the core no longer knows) is named.
        with tempfile.TemporaryDirectory() as raw, socket.socket(socket.AF_UNIX) as server, contextlib.ExitStack() as stack:
            root = Path(raw).resolve(); path = Path('herdr-core/s.sock'); (root/path.parent).mkdir(parents=True)
            old = os.getcwd(); os.chdir(root); stack.callback(os.chdir, old)
            server.bind(str(path)); server.listen(1); server.settimeout(2)
            def serve():
                with server.accept()[0] as conn, conn.makefile('rb') as f:
                    for line in f:
                        q = json.loads(line)
                        reply = dict(jsonrpc='2.0', id=q['id'], **({'result': dict(generation=1, framed=False)} if q['method'] == 'hello'
                                                                  else {'error': dict(code=-32000, message='no such terminal')}))
                        conn.sendall((json.dumps(reply)+'\n').encode())
            threading.Thread(target=serve, daemon=True).start()
            connect = socket.socket.connect
            stack.enter_context(patch.object(socket.socket,'connect',lambda s,p:connect(s,os.path.relpath(p,root))))
            stack.enter_context(patch.dict(os.environ, XDG_RUNTIME_DIR=str(root)))
            with probe['core_rpc'](root, 's', 'linux') as rpc, self.assertRaises(probe['Unavailable']) as raised:
                rpc('terminal.get', dict(terminal='t86'))
            self.assertEqual(raised.exception.code, 'core_error')

    def test_local_replacement_does_not_inherit_assignment_log(self):
        with tempfile.TemporaryDirectory() as raw, contextlib.ExitStack() as stack:
            root = Path(raw).resolve()
            replacement = 'cad0f00d-aaaa-4bbb-8000-aaaaaaaaaaaa'
            user = SimpleNamespace(pw_name='worker', pw_gid=3333, pw_dir=root)
            for name in ('getuid', 'geteuid', 'getegid'):
                stack.enter_context(patch('os.' + name, return_value=3333))
            stack.enter_context(patch('platform.system', return_value='Linux'))
            stack.enter_context(patch('pwd.getpwuid', return_value=user))
            stack.enter_context(patch('grp.getgrgid', return_value=SimpleNamespace(gr_name='worker')))
            conf = dict(root=str(root), project='fixture', assignment='A-1', local=True, generation=replacement,
                        launch_run='R-2', terminal='t2', session='s', target='pin', user='worker', gid=3333,
                        harness='codex', live=True, platform='linux', helpers=[], process=None)
            terminals = [{'address': 't2', 'state': 'live', 'screen': ['idle']}]
            processes = [dict(pid=42, elapsed='00:03', cpu=0.5, command='codex')]
            def observe(home, session, labels, pinned, system, launch=False):
                self.assertFalse(launch)
                self.assertEqual(labels, dict(cardigan='1', project='fixture', assignment='A-1', run='R-2', generation=replacement))
                self.assertEqual(pinned, 't2')
                return terminals, processes
            stack.enter_context(patch.dict(probe['main'].__globals__, native={'project_account': lambda _: None}, terminals=observe))
            # R-1 left the only (and thus newest) transcript. R-2 has a new
            # terminal and UUID, but has not created a transcript of its own.
            logs = root/'runs/fixture/A-1/codex/sessions'; logs.mkdir(parents=True)
            old = logs/'old.jsonl'
            history = b'{"type":"event_msg","timestamp":"2026-11-01T00:00:01Z"}\n'
            old.write_bytes(history)
            read_logs = MagicMock(wraps=probe['log_events'])
            with patch.dict(probe['main'].__globals__, log_events=read_logs):
                evidence = probe['main'](conf)
                self.assertIsNone(evidence['events'])
                read_logs.assert_not_called()
            self.assertEqual(evidence['terminals'], terminals)
            self.assertEqual(evidence['processes'], processes)
            self.assertIsNone(evidence['markers'])
            self.assertEqual(old.read_bytes(), history)

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

    # C-806: a failed launch's evidence is bounded and redacted on the worker.
    TOKEN = 'cdg_' + 'Zx9' * 14

    def test_redaction_removes_tokens_and_credential_paths(self):
        tail = probe['redacted_tail']('\n'.join([
            'cardigan: token file is missing: /worker/runs/fixture/A-1/token',
            '. /worker/runs/fixture/A-1/secrets.env failed; ssh -i ~/.ssh/id_ed25519 host',
            'Authorization: Bearer ' + self.TOKEN,
            'MCP_TOKEN=' + self.TOKEN + ' api_key: "hunter2"',
            'X-Cardigan-Session ' + 'aB3' * 8 + ' url https://user:pw@example.invalid/x https://example.invalid/mcp?sig=abc',
            '-----BEGIN OPENSSH PRIVATE KEY----- abc -----END OPENSSH PRIVATE KEY-----',
            'Error: MCP server "card" connection failed: ECONNREFUSED 127.0.0.1:3004',
            '\x1b[31m' + 'x' * 500,
        ]))
        text = '\n'.join(tail)
        for leaked in [self.TOKEN, 'hunter2', '/worker/runs', 'secrets.env', 'id_ed25519', 'aB3aB3', 'user:pw', 'sig=abc', 'OPENSSH PRIVATE KEY----- abc']:
            self.assertNotIn(leaked, text)
        self.assertIn('Error: MCP server "card" connection failed: ECONNREFUSED 127.0.0.1:3004', tail)
        self.assertIn('https://example.invalid/mcp', text)
        self.assertTrue(all(len(line) <= 200 and '\x1b' not in line for line in tail))
        many = probe['redacted_tail']('\n'.join('line %d %s' % (i, 'y' * 150) for i in range(300)))
        self.assertLessEqual(len('\n'.join(many).encode()), 2048)
        self.assertTrue(many[-1].startswith('line 299'))

    def write_log(self, folder, stamp, *messages):
        folder.mkdir(parents=True, exist_ok=True)
        lines = [json.dumps({key: text, 'timestamp': '2026-01-01T00:00:00Z', 'sessionId': 'ignored'}) for key, text in messages]
        (folder / (stamp + '.jsonl')).write_text('\n'.join(lines) + '\n')

    def test_mcp_connection_results_from_claude_logs(self):
        with tempfile.TemporaryDirectory() as raw:
            home = Path(raw).resolve()
            worktree = Path('/worker/worktrees/fixture/A-1')
            cache = home / '.cache/claude-cli-nodejs' / '-worker-worktrees-fixture-A-1'
            # Before this launch: never reported for it.
            self.write_log(cache / 'mcp-logs-card', '2026-01-01T00-00-00-000Z', ('debug', 'Successfully connected (transport: http) in 9ms'))
            self.write_log(cache / 'mcp-logs-card', '2026-01-01T01-00-01-000Z',
                           ('debug', 'Starting connection with timeout of 30000ms'),
                           ('debug', 'HTTP Connection failed after 36ms: ECONNREFUSED: Unable to connect (Authorization: Bearer ' + self.TOKEN + ')'),
                           ('error', 'TypeError: ECONNREFUSED\n    at /$bunfs/root/chunk.js:9:5836'))
            self.write_log(cache / 'mcp-logs-playwright', '2026-01-01T01-00-02-000Z',
                           ('debug', 'version negotiation probe timed out; reconnecting'),
                           ('debug', 'Successfully connected (transport: stdio) in 812ms'))
            self.write_log(cache / 'mcp-logs-slow', '2026-01-01T01-00-02-000Z', ('debug', 'Starting connection with timeout of 30000ms'))
            (cache / 'mcp-logs-linked').symlink_to(cache / 'mcp-logs-card', target_is_directory=True)
            since = 1767229200000  # 2026-01-01T01:00:00Z
            servers = probe['mcp_servers'](home, 'linux', [worktree, Path('/worker/runs/fixture/A-1')], since)
            self.assertEqual([s['name'] for s in servers], ['card', 'playwright', 'slow'])
            card, playwright, slow = servers
            self.assertEqual(card['status'], 'failed')
            self.assertIn('ECONNREFUSED', card['error'])
            self.assertNotIn(self.TOKEN, json.dumps(servers))
            self.assertEqual(playwright, dict(name='playwright', status='connected', transport='stdio', elapsed_ms=812))
            self.assertEqual(slow, dict(name='slow', status='pending'))
            self.assertEqual(probe['mcp_servers'](home, 'linux', [worktree], since + 10 ** 7), [])
            # No log folder for any candidate: searched nothing.
            self.assertEqual(probe['mcp_servers'](home, 'linux', [Path('/other')], since), [])
            darwin = home / 'Library/Caches/claude-cli-nodejs' / '-worker-worktrees-fixture-A-1'
            self.write_log(darwin / 'mcp-logs-card', '2026-01-01T01-00-03-000Z', ('debug', 'Successfully connected (transport: http) in 5ms'))
            self.assertEqual(probe['mcp_servers'](home, 'darwin', [worktree], since)[0]['status'], 'connected')

    def test_process_and_scope_resources(self):
        child = MagicMock(); child.__enter__.return_value = child
        child.stdout = io.BytesIO(f'{os.getuid()} 00:00:00.80 107520 03:02'.encode())
        with tempfile.TemporaryDirectory() as raw, patch('subprocess.Popen', return_value=child):
            scope = Path(raw)
            (scope / 'cpu.stat').write_text('usage_usec 812345\nuser_usec 1\n')
            (scope / 'memory.current').write_text('110100480\n')
            (scope / 'memory.peak').write_text('120000000\n')
            cgroup = io.BytesIO(b'0::/user.slice/user-1.slice/user@1.service/app.slice/cardigan-session-k2-abc.scope\n')
            opened = []
            def fake_directory(path):
                opened.append(path)
                return probe['directory'](str(scope))
            with patch('builtins.open', return_value=cgroup), patch.dict(probe['session_scope'].__globals__, directory=fake_directory):
                self.assertEqual(probe['resources'](42, 'linux'),
                                 dict(source='scope', cpu_ms=812, memory_bytes=110100480, memory_peak_bytes=120000000, elapsed_ms=182000))
            self.assertEqual(opened, ['/sys/fs/cgroup/user.slice/user-1.slice/user@1.service/app.slice/cardigan-session-k2-abc.scope'])
        child.stdout = io.BytesIO(f'{os.getuid()} 1-02:00:01 2048 01:00:00'.encode())
        with patch('subprocess.Popen', return_value=child):
            self.assertEqual(probe['resources'](42, 'darwin'),
                             dict(source='process', cpu_ms=93601000, memory_bytes=2097152, elapsed_ms=3600000))
        with patch('builtins.open', return_value=io.BytesIO(b'0::/user.slice/other.scope\n')):
            self.assertIsNone(probe['session_scope'](42))

    def test_failed_launch_evidence_in_collector_output(self):
        # A simulated failure: card unreachable, CLI exited with code 1.
        with tempfile.TemporaryDirectory() as raw, contextlib.ExitStack() as stack:
            root = Path(raw).resolve()
            user = SimpleNamespace(pw_name='worker', pw_gid=3333, pw_dir=root)
            for name in ('getuid', 'geteuid', 'getegid'):
                stack.enter_context(patch('os.' + name, return_value=3333))
            stack.enter_context(patch('platform.system', return_value='Linux'))
            stack.enter_context(patch('pwd.getpwuid', return_value=user))
            stack.enter_context(patch('grp.getgrgid', return_value=SimpleNamespace(gr_name='worker')))
            cache = root / '.cache/claude-cli-nodejs' / re.sub(r'[^A-Za-z0-9]', '-', str(root / 'worktrees/fixture/A-1'))
            self.write_log(cache / 'mcp-logs-card', '2026-01-01T01-00-01-000Z', ('debug', 'HTTP Connection failed after 3ms: ECONNREFUSED'))
            launch = dict(state='finished', exit_code=1, exit_reason='exited', tail=['Error: boom'])
            rows = [{'address': 't2', 'state': 'finished', 'activity': None, 'screen': [], 'launch': launch}]
            stack.enter_context(patch.dict(probe['main'].__globals__, native={'project_account': lambda _: None},
                                           terminals=lambda *args: (rows, [])))
            conf = dict(root=str(root), project='fixture', assignment='A-1', local=False, generation='a' * 32,
                        launch_run='R-2', terminal='t2', session='s', target='pin', user='worker', gid=3333,
                        harness='claude-code', live=True, platform='linux', helpers=[], process=None,
                        launch=dict(since_ms=1767229200000))
            evidence = probe['main'](conf)
            self.assertEqual(evidence['launch']['terminal'], launch)
            self.assertEqual(evidence['launch']['mcp'], [dict(name='card', status='failed', error='HTTP Connection failed after 3ms: ECONNREFUSED')])
            self.assertEqual(evidence['launch']['unavailable'], {})
            self.assertNotIn('launch', evidence['terminals'][0])
            self.assertNotIn('launch', probe['main'](dict(conf, launch=None)))
            gone = probe['main'](dict(conf, live=False, harness='codex'))['launch']
            self.assertEqual(gone, dict(terminal=None, mcp=None, unavailable=dict(mcp='harness_unsupported', terminal='run_not_current')))
            # C-823: a Run that no longer holds the session: its own terminal,
            # found only by its run label (no generation or pinned address).
            asked = []
            def own(*args):
                asked.append(args)
                return [dict(rows[0], launch=launch)], []
            probe['main'].__globals__['terminals'] = own
            stale = dict(conf, live=False, launch=dict(since_ms=1767229200000, run='R-1'))
            evidence = probe['main'](stale)
            self.assertEqual(evidence['launch']['terminal'], launch)
            self.assertEqual(evidence['launch']['mcp'][0]['status'], 'failed')
            self.assertEqual(evidence['launch']['unavailable'], {})
            self.assertIsNone(evidence['terminals'])
            (home, session, labels, pinned, system, flag), = asked
            self.assertEqual((session, labels, pinned, flag),
                             ('s', dict(cardigan='1', project='fixture', assignment='A-1', run='R-1'), None, True))
            probe['main'].__globals__['terminals'] = lambda *args: ([], [])
            self.assertEqual(probe['main'](stale)['launch']['unavailable'], dict(terminal='terminal_not_registered'))
            def missing(*args):
                raise FileNotFoundError()
            probe['main'].__globals__['terminals'] = missing
            self.assertEqual(probe['main'](stale)['launch']['unavailable'], dict(terminal='core_socket_missing'))
            bad = dict(stale, launch=dict(since_ms=1767229200000, run='R-1; rm'))
            self.assertEqual(probe['main'](bad)['launch']['unavailable'], dict(terminal='run_not_current'))

if __name__=='__main__':
    unittest.main()
