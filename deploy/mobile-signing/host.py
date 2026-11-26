"""Trusted control host only. No caller-supplied command, path, key reference or target."""
import os
from pathlib import Path
import secrets
import signal
import subprocess
import stat
import sys
import tempfile
import threading

sys.path.insert(0, str(Path(__file__).resolve().parent))  # reviewed release, not cwd
from common import (LIMIT, SCOPE, canonical, config, database, digest, directory, json,
                    line, manifest, persist, private_dir, private_file, re, read_failure, require,
                    save_failure, scope, send, time, transaction, transfer)


def ledger(root):
    db = database(root, '''CREATE TABLE IF NOT EXISTS grants
      (id TEXT PRIMARY KEY, scope TEXT UNIQUE NOT NULL, spec TEXT NOT NULL,
       state TEXT NOT NULL, output TEXT, revoked INTEGER NOT NULL DEFAULT 0)''')
    db.execute('CREATE TABLE IF NOT EXISTS events (at INTEGER, scope TEXT, request TEXT, action TEXT)')
    db.execute('CREATE TABLE IF NOT EXISTS dispatch_peer (id TEXT PRIMARY KEY, peer TEXT NOT NULL)')
    db.execute('CREATE TABLE IF NOT EXISTS observed (id TEXT PRIMARY KEY, state TEXT NOT NULL, sha TEXT)')
    return db


def event(db, ctx, rid, action):
    db.execute('INSERT INTO events VALUES(?,?,?,?)', (int(time.time()), ctx, rid, action))


class Stopped(Exception):
    # Ends a request with a recognizable audit action instead of a silent kill.
    def __init__(self, action):
        super().__init__('refused')
        self.action = action


def stop(action):
    def handler(_signum, _frame):
        raise Stopped(action)
    return handler


# A slow link must not cut a request short: budget both directions at a
# conservative rate. The private limits.json may override either value.
LIMITS = {'base_seconds': (600, 60, 86400), 'bytes_per_second': (512 * 1024, 16 * 1024, 1 << 30)}


def budget(root, size):
    path = root / 'limits.json'
    custom = config(path) if os.path.lexists(path) else {}
    require(type(custom) is dict and set(custom) <= set(LIMITS))
    values = {}
    for k, (default, low, high) in LIMITS.items():
        values[k] = custom.get(k, default)
        require(type(values[k]) is int and low <= values[k] <= high)
    return values['base_seconds'] + -(-2 * size // values['bytes_per_second'])


def route(root, s):
    hits = [p for p in config(root / 'routes.json') if all(p[k] == s[k] for k in ('project','machine','platform','version','app'))]
    require(len(hits) == 1 and re.fullmatch('[A-Za-z0-9][A-Za-z0-9.-]*', hits[0]['peer']))
    return hits[0]['peer']


def handoff_route(root, s):
    # C-612: the administrator marks a route whose signer runs on the worker's machine.
    hits = [p for p in config(root / 'routes.json') if all(p[k] == s[k] for k in ('project','machine','platform','version','app'))]
    return s['platform'] == 'android' and len(hits) == 1 and hits[0].get('handoff') is True


def handoff_path(value):
    # The signer names each copy randomly; only this ledger and, once released, the Run learn it.
    return (isinstance(value, str) and re.fullmatch(r'(?:/[A-Za-z0-9_.-]+)+/[0-9a-f]{32}\.apk', value, re.ASCII)
            and '/../' not in value + '/' and '/./' not in value + '/')


def handoffs(db):
    db.execute('CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, path TEXT NOT NULL, sha TEXT NOT NULL)')


def withdraw(db, root, rid, dial=None):
    """After a revocation, ask the signer to remove the same-machine copy.

    Never blocking: a revoked grant is no longer released, so its path is
    not reported again. The ledger keeps the handoff until the signer
    confirms the removal; repeating `revoke` retries, and an unreachable or
    older signer leaves the copy to the signer's periodic expiry job.
    """
    path = handed_off(db, rid, None)
    if path is None:
        return False
    row = db.execute('SELECT spec,peer FROM grants JOIN dispatch_peer USING(id) WHERE id=?', (rid,)).fetchone()
    done = False
    if row:
        try:
            p = (dial or connect)(root, row[1])
            try:
                send(p.stdin, canonical({'mode': 'withdraw', 'grant': json.loads(row[0]), 'size': 0}).encode())
                p.stdin.close()
                done = line(p.stdout) == b'withdrawn' and p.wait(timeout=10) == 0
            finally:
                hang_up(p)
        except Exception:
            done = False
    if done:
        with transaction(db):
            db.execute('DELETE FROM handoffs WHERE id=?', (rid,))
    event(db, scope(json.loads(row[0])) if row else None, rid, 'handoff_withdrawn' if done else 'handoff_withdraw_failed')
    return done


def handed_off(db, rid, sha):
    """The same-machine path the signer reported for exactly these bytes (any bytes: None), if any."""
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='handoffs'").fetchone():
        return None
    row = db.execute('SELECT path FROM handoffs WHERE id=? AND (? IS NULL OR sha=?)', (rid, sha, sha)).fetchone()
    return row[0] if row else None


def register(root, db, s, source):
    # Operator supplies a private, already registered build snapshot, not a worktree path.
    manifest(s)
    route(root, s)
    with private_file(source).open('rb') as f, tempfile.TemporaryDirectory(dir=root) as tmp:
        copy = Path(tmp) / 'input'
        with copy.open('xb') as dst:
            require(transfer(f, dst, os.fstat(f.fileno()).st_size) == s['sha256'] and not f.read(1))
        db.execute('BEGIN IMMEDIATE')
        try:
            db.execute("INSERT INTO grants(id,scope,spec,state) VALUES(?,?,?,'registered')", (s['id'], scope(s), canonical(s)))
            persist(copy, directory(root, 'inputs') / s['id'])
            event(db, scope(s), s['id'], 'registered')
            db.commit()
        except BaseException:
            db.rollback()
            raise


def approve(root, db, s):
    # Compare the whole human-reviewed manifest to the previously registered build.
    manifest(s)
    route(root,s)
    require(digest(root/'inputs'/s['id'])==s['sha256'])
    db.execute('BEGIN IMMEDIATE')
    try:
        require(db.execute("UPDATE grants SET state='approved' WHERE spec=? AND state='registered' AND NOT revoked",(canonical(s),)).rowcount==1)
        event(db,scope(s),s['id'],'approved')
        db.commit()
    except BaseException:
        db.rollback()
        raise


# C-612: a chain grant outlives any packaging Run, so signed intake and
# download never fail on its expiry.
CHAIN_TTL = 7 * 86400
DECISION = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', re.ASCII)
USABLE = ('approved', 'pending', 'peer_signed', 'signed')


def chain_grants(db):
    db.execute('CREATE TABLE IF NOT EXISTS chain_grants (id TEXT PRIMARY KEY, decision TEXT NOT NULL)')


def chain_of(db, rid):
    """The release-chain decision a grant was derived from, or None for an operator grant."""
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chain_grants'").fetchone():
        return None
    row = db.execute('SELECT decision FROM chain_grants WHERE id=?', (rid,)).fetchone()
    return row[0] if row else None


def attested(identity):
    """Split the Run scope from the control service's optional chain attestation.

    A grant derived from a release chain is used only while the control
    service, which alone can see the decision, attests that this very chain
    is still approved. It never falls back to counting as an operator grant.
    """
    require(type(identity) is dict)
    chain = identity.get('chain')
    require(chain is None or (isinstance(chain, str) and DECISION.fullmatch(chain)))
    return {k: v for k, v in identity.items() if k != 'chain'}, chain


def bound_to(root, db, s, chain):
    """A chain-derived grant: attested by the service and still on a marked test route."""
    derived = chain_of(db, s['id'])
    if derived is None:
        return
    require(derived == chain)
    hits = [r for r in config(root / 'routes.json') if all(r[k] == s[k] for k in ('project','machine','platform','version','app'))]
    require(len(hits) == 1 and hits[0].get('test_identity') is True)


def chain_grant(root, db, identity, request, source):
    """An approved release chain stands in for the operator's register + approve.

    Internal Android test candidates only. The control service passes the
    chain's bound source commit and unsigned digest, the build reference and
    the byte count; the single route for this project, machine and platform
    marked `"test_identity": true` fixes the app and credential version. The signer still checks project,
    machine, Run, digest and package name. One candidate per Run: an existing
    grant for this scope is reported, never replaced.
    """
    ctx = scope(identity)
    require(set(identity) == set(SCOPE) and identity['platform'] == 'android')
    require(type(request) is dict and set(request) == {'commit', 'build', 'sha256', 'size', 'decision'})
    require(isinstance(request['decision'], str) and DECISION.fullmatch(request['decision']))

    def known():
        # Reused only when it is this chain's own live candidate for the same
        # source commit and bytes. An operator grant, a registered but not
        # approved one, another chain's or a revoked one is `other`, never
        # recorded as this chain's approval.
        row = db.execute('SELECT id,spec,state,revoked FROM grants WHERE scope=?', (ctx,)).fetchone()
        if row:
            spec = json.loads(row[1])
            same = (not row[3] and row[2] in USABLE and chain_of(db, row[0]) == request['decision']
                    and spec['sha256'] == request['sha256'] and spec['commit'] == request['commit'])
            return row[0], 'existing' if same else 'other'
        return None

    found = known()
    if found:
        return found
    # Only a route the administrator marked as this project's internal test
    # signing identity; any other route keeps per-candidate operator approval.
    hits = [r for r in config(root / 'routes.json')
            if all(r[k] == identity[k] for k in ('project', 'machine', 'platform')) and r.get('test_identity') is True]
    require(len(hits) == 1)
    s = {**identity, 'id': secrets.token_hex(16), 'version': hits[0]['version'], 'app': hits[0]['app'],
         'build': request['build'], 'commit': request['commit'], 'sha256': request['sha256'],
         'expires': int(time.time()) + CHAIN_TTL}
    manifest(s)
    route(root, s)
    with tempfile.TemporaryDirectory(dir=root) as tmp:
        copy = Path(tmp) / 'input'
        with copy.open('xb') as dst:
            require(transfer(source, dst, request['size']) == s['sha256'] and not source.read(1))
        db.execute('BEGIN IMMEDIATE')
        try:
            found = known()  # a concurrent chain call won the scope
            if found:
                db.rollback()
                return found
            db.execute("INSERT INTO grants(id,scope,spec,state) VALUES(?,?,?,'approved')", (s['id'], ctx, canonical(s)))
            chain_grants(db)
            db.execute('INSERT INTO chain_grants VALUES(?,?)', (s['id'], request['decision']))
            persist(copy, directory(root, 'inputs') / s['id'])
            event(db, ctx, s['id'], 'chain_registered')
            event(db, ctx, s['id'], 'chain_approved')
            db.commit()
        except BaseException:
            db.rollback()
            raise
    return s['id'], 'new'


def connect(root, peer):
    # Private per-peer Host stanza pins user, host key, identity and endpoint.
    return subprocess.Popen(['/usr/bin/ssh', '-F', str(private_file(root / 'ssh.conf')), '-T',
        '-oBatchMode=yes', '-oStrictHostKeyChecking=yes', '-oIdentitiesOnly=yes', '-oForwardAgent=no',
        '-oConnectTimeout=10','-oServerAliveInterval=15','-oServerAliveCountMax=2',
        '-oClearAllForwardings=yes', '-oControlMaster=no', '-oControlPath=none', peer],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env={'PATH':'/usr/bin:/bin', 'LC_ALL':'C'}, cwd=root)


def observe(db, rid, state, sha, category=None):
    # Called under the caller's write transaction, after peer IO. A snapshot
    # of pending may arrive after another connection has recorded the outcome.
    old = db.execute('SELECT state,sha FROM observed WHERE id=?', (rid,)).fetchone()
    if old and old[0] != 'pending':
        require(state == 'pending' or old == (state, sha))
        state, sha = old
    else:
        db.execute('INSERT OR REPLACE INTO observed VALUES(?,?,?)', (rid, state, sha))
    if state == 'failed':
        save_failure(db, rid, category)
        return {'state': state, 'sha256': None, **read_failure(db, rid)}
    return {'state': state, 'sha256': sha}


def hang_up(p):
    # Bounded on every path, including a signal or deadline mid-read: never
    # wait for a silent peer before the audit event is written.
    p.kill()
    p.wait()
    try:
        p.stdin.close()
    except BrokenPipeError:
        pass
    finally:
        p.stdout.close()


def undispatched(root, s, peer, dial):
    # Read-only receipt query at the pinned peer (C-601). `absent` or `received`
    # means the signer never got a commit for this number, so the key was never
    # used. The signer re-checks this under its serial lock before accepting a
    # resend. Any other or unreadable answer is no permission to resend.
    p = dial(root, peer)
    try:
        send(p.stdin, canonical({'mode':'receipt','grant':s,'size':0,'dispatch_states':True}).encode())
        p.stdin.close()
        response = json.loads(line(p.stdout))
        require(not p.stdout.read(1) and p.wait(timeout=10)==0)
    finally:
        hang_up(p)
    require(type(response) is dict)
    return response.get('state') in ('absent', 'received')


def request(root, db, identity, fence, dial=connect, accepted=lambda rid, seconds, mode: None):
    identity, chain = attested(identity)
    ctx = scope(identity)
    require(set(identity) == set(SCOPE))
    rid = None
    try:
        row = db.execute('SELECT spec,state FROM grants WHERE scope=? AND NOT revoked', (ctx,)).fetchone()
        require(row)
        s, state = json.loads(row[0]), row[1]
        rid = s['id']
        require(state in USABLE)
        bound_to(root, db, s, chain)
        manifest(s)
        peer = route(root,s)

        def authorized():
            require(db.execute('SELECT 1 FROM grants WHERE id=? AND NOT revoked', (rid,)).fetchone())
            bound_to(root, db, s, chain)
            require(route(root,s) == peer)
            manifest(s)

        # A stored output is only hashed locally; a dispatch moves the input and output.
        # A lookup never reads the input copy: if it is gone, budget the largest output.
        inp = directory(root,'inputs') / rid
        seconds = budget(root, 0 if state == 'signed' else inp.stat().st_size if inp.exists() else LIMIT)
        signal.signal(signal.SIGALRM, stop('timed_out'))
        signal.setitimer(signal.ITIMER_REAL, seconds)
        # A claimed request whose input transfer was cut off before the commit
        # (server restart, interrupted helper) resends the same number to the
        # peer fixed at the first dispatch. Anything else is a lookup only.
        # The claim is already durable, so report the number before any peer IO:
        # a failed or interrupted receipt query still leaves the caller a request
        # number to poll, never a refusal.
        resume = reported = False
        if state == 'pending':
            pinned = db.execute('SELECT peer FROM dispatch_peer WHERE id=?', (rid,)).fetchone()
            probe = inp.exists() and pinned is not None and pinned[0] == peer
            accepted(rid, seconds, 'continue' if probe else 'lookup')
            reported = True
            resume = probe and undispatched(root, s, peer, dial)
        # A durable claim before contacting the peer. A lost reply permits lookup or resend only.
        with transaction(db):
            fresh = db.execute("UPDATE grants SET state='pending' WHERE id=? AND NOT revoked AND state='approved'", (rid,)).rowcount == 1
            if fresh:
                db.execute('INSERT INTO dispatch_peer VALUES(?,?)', (rid,peer))
            elif resume:
                require(db.execute("SELECT 1 FROM grants WHERE id=? AND state='pending' AND NOT revoked", (rid,)).fetchone())
            event(db, ctx, rid, 'request' if fresh else 'resume' if resume else 'lookup')
        if not reported:
            accepted(rid, seconds, 'sign' if fresh else 'stored' if state == 'signed' else 'lookup')
        fresh = fresh or resume  # both move the input; the signer dedupes by number
        output = directory(root,'outputs') / rid
        if state == 'signed':
            fence()
            authorized()
            return rid, checked_output(db,rid,output)
        p = dial(root,peer)
        try:
            inp = directory(root,'inputs') / rid
            size = inp.stat().st_size if fresh else 0
            local = handoff_route(root, s)
            send(p.stdin, canonical({'grant':s,'mode':'sign' if fresh else 'lookup','size':size,
                                     'failure_details':True,**({'handoff':True} if local else {})}).encode())
            if fresh:
                with inp.open('rb') as f:
                    require(transfer(f,p.stdin,size) == s['sha256'])
                p.stdin.flush()
            require(line(p.stdout) == b'ready')
            fence()  # current authenticated assignment, Run and machine, not the launch snapshot
            db.execute('BEGIN IMMEDIATE')
            try:
                authorized()
                event(db,ctx,rid,'dispatch' if fresh else 'reconcile')
                db.commit()  # linearizes dispatch against revoke; later revocation still withholds export
            except BaseException:
                db.rollback()
                raise
            send(p.stdin,b'commit')
            header = json.loads(line(p.stdout))
            if header.get('status') == 'failed':
                with transaction(db):
                    db.execute("UPDATE grants SET state='failed' WHERE id=? AND state='pending'", (rid,))
                    observe(db, rid, 'failed', None, header.get('failure_category'))
                raise ValueError('refused')
            with tempfile.TemporaryDirectory(dir=root) as tmp:
                received = Path(tmp)/'output'
                with received.open('xb') as f:
                    sha = transfer(p.stdout,f,header['size'])
                require(sha == header['sha256'] and not p.stdout.read(1) and p.wait(timeout=10)==0)
                authorized()
                persist(received,output)
                db.execute('BEGIN IMMEDIATE')
                try:
                    require(db.execute("UPDATE grants SET state='signed',output=? WHERE id=? AND NOT revoked AND state IN ('pending','peer_signed','signed')",(sha,rid)).rowcount == 1)
                    observe(db, rid, 'signed', sha)
                    if local and handoff_path(header.get('handoff')):
                        handoffs(db)
                        db.execute('INSERT OR REPLACE INTO handoffs VALUES(?,?,?)', (rid, header['handoff'], sha))
                    event(db,ctx,rid,'signed')
                    db.commit()
                except BaseException:
                    db.rollback()
                    raise
            return rid,sha
        finally:
            hang_up(p)
    except Exception as exc:
        signal.setitimer(signal.ITIMER_REAL, 0)
        if db.in_transaction:
            db.rollback()
        event(db,ctx,rid,exc.action if isinstance(exc, Stopped) else 'not_released')
        raise
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)


def watch_parent(parent, interval=1):
    # C-601: a helper whose server exited (restart, deployment, crash) can never
    # pass the fence. End it as `interrupted`, freeing the signer, instead of
    # leaving an orphan that holds the transfer while it waits for a commit.
    def run():
        while os.getppid() == parent:
            time.sleep(interval)
        # To the main thread, so a blocking read or write there is interrupted.
        signal.pthread_kill(threading.main_thread().ident, signal.SIGTERM)
    threading.Thread(target=run, daemon=True).start()


def checked_output(db,rid,output):
    sha = digest(output)
    require(db.execute("SELECT 1 FROM grants WHERE id=? AND state='signed' AND NOT revoked AND output=?", (rid,sha)).fetchone())
    return sha


def reconcile(db, root, rid, dial=connect):
    # Operator-only, exact dispatched peer and grant. No live Run, key use or bytes.
    row = db.execute('SELECT spec,peer FROM grants JOIN dispatch_peer USING(id) WHERE id=?',(rid,)).fetchone()
    require(row)
    spec, peer = json.loads(row[0]), row[1]
    manifest(spec, live=False)
    event(db, scope(spec), rid, 'check_receipt')
    with dial(root, peer) as p:
        send(p.stdin, canonical({'mode':'receipt','grant':spec,'size':0,'failure_details':True}).encode())
        p.stdin.close()
        response = json.loads(line(p.stdout))
        require(not p.stdout.read(1) and p.wait(timeout=10)==0)
    state, sha = response['state'], response['sha256']
    require((state == 'signed' and re.fullmatch('[0-9a-f]{64}',sha)) or
            (state in ('pending','failed') and sha is None))
    with transaction(db):
        if state != 'pending':
            db.execute("UPDATE grants SET state=? WHERE id=? AND state='pending'",
                       ('peer_signed' if state=='signed' else 'failed', rid))
        event(db,scope(spec),rid,'receipt_'+state)
        return observe(db, rid, state, sha, response.get('failure_category') if state == 'failed' else None)


def release_authority(root, db, rid, identity=None):
    row = db.execute("SELECT spec,output FROM grants WHERE id=? AND state='signed' AND NOT revoked",(rid,)).fetchone()
    require(row)
    spec = json.loads(row[0]); manifest(spec); route(root,spec)
    if identity is not None:
        require(set(identity)==set(SCOPE) and scope(identity)==scope(spec))
    return row[1]


def permit(root, db, identity, rid, file, fence):
    # The web host passes its open fd, then serves that very inode from offset zero.
    # Only the web host authenticates the Run; a receipt handle alone authorizes nothing.
    sha = release_authority(root,db,rid,identity)
    st = os.fstat(file.fileno())
    require(stat.S_ISREG(st.st_mode) and st.st_uid==os.getuid() and not st.st_mode & 0o077)
    require(transfer(file,None,st.st_size)==sha)
    fence()
    with transaction(db):
        require(release_authority(root,db,rid,identity)==sha)
        event(db,scope(identity),rid,'read_output')
    return sha


def staged(root, name):
    require(re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}',name))
    return private_file(private_dir(root/'incoming')/name)


def main():
    os.umask(0o077)
    root = private_dir(Path(sys.argv[1]).resolve(strict=True))
    cmd = sys.argv[2]
    db = ledger(root)
    def fence():
        send(sys.stdout.buffer,b'ready')
        require(line(sys.stdin.buffer)==b'commit')
    if cmd == 'request':
        for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            signal.signal(sig, stop('interrupted'))
        watch_parent(os.getppid())
        def accepted(rid, seconds, mode):
            send(sys.stdout.buffer, f'accepted {rid} {seconds} {mode}'.encode())
        rid, sha = request(root,db,json.loads(line(sys.stdin.buffer)),fence,accepted=accepted)
        local = handed_off(db, rid, sha)
        print(rid, sha, *([local] if local else []))
    elif cmd == 'permit':
        rid=sys.argv[3]
        with os.fdopen(3,'rb') as f:
            sha=permit(root,db,json.loads(line(sys.stdin.buffer)),rid,f,fence)
        print(rid,sha)
    elif cmd == 'check':
        # Re-validate a remembered receipt against the ledger now: same Run,
        # still signed, not revoked, live manifest and route. No bytes, no hashing.
        rid=sys.argv[3]
        require(re.fullmatch('[0-9a-f]{32}',rid))
        identity, chain = attested(json.loads(line(sys.stdin.buffer)))
        sha = release_authority(root,db,rid,identity)
        bound_to(root, db, json.loads(db.execute('SELECT spec FROM grants WHERE id=?', (rid,)).fetchone()[0]), chain)
        print(rid,sha)
    elif cmd == 'reconcile':
        print(canonical(reconcile(db,root,sys.argv[3])))
    elif cmd == 'chain':
        # Two lines on stdin (Run scope, chain request); candidate bytes on fd 3.
        identity = json.loads(line(sys.stdin.buffer))
        chained = json.loads(line(sys.stdin.buffer))
        with os.fdopen(3, 'rb') as f:
            rid, status = chain_grant(root, db, identity, chained, f)
        print(rid, status)
    elif cmd == 'register':
        register(root,db,config(staged(root,sys.argv[3])),staged(root,sys.argv[4]))
    elif cmd == 'approve':
        approve(root,db,config(staged(root,sys.argv[3])))
    elif cmd == 'show':
        row=db.execute('SELECT spec,state,output,revoked FROM grants WHERE id=?',(sys.argv[3],)).fetchone()
        require(row)
        obs=db.execute('SELECT state,sha FROM observed WHERE id=?',(sys.argv[3],)).fetchone()
        details = read_failure(db, sys.argv[3]) if obs and obs[0] == 'failed' else {}
        print(canonical({'candidate':json.loads(row[0]),'state':row[1],'output':row[2],'revoked':bool(row[3]),
                         'worker_receipt':{'state':obs[0],'sha256':obs[1],**details} if obs else None}))
    elif cmd == 'revoke':
        rid=sys.argv[3]
        require(db.execute('UPDATE grants SET revoked=1 WHERE id=?',(rid,)).rowcount == 1)
        event(db,db.execute('SELECT scope FROM grants WHERE id=?',(rid,)).fetchone()[0],rid,'revoked')
        withdraw(db, root, rid)
    elif cmd == 'export':
        rid=sys.argv[3]
        require(re.fullmatch('[0-9a-f]{32}',rid))
        path=root/'outputs'/rid
        require(checked_output(db,rid,path)==release_authority(root,db,rid))
        with path.open('rb') as src:
            transfer(src, sys.stdout.buffer, path.stat().st_size)
    else:
        raise ValueError('refused')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit('Mobile signing unavailable')
