"""Trusted control host only. No caller-supplied command, path, key reference or target."""
import os
from pathlib import Path
import signal
import subprocess
import stat
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))  # reviewed release, not cwd
from common import (SCOPE, canonical, config, database, digest, directory, json,
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


def request(root, db, identity, fence, dial=connect, accepted=lambda rid, seconds, mode: None):
    ctx = scope(identity)
    require(set(identity) == set(SCOPE))
    rid = None
    try:
        row = db.execute('SELECT spec,state FROM grants WHERE scope=? AND NOT revoked', (ctx,)).fetchone()
        require(row)
        s, state = json.loads(row[0]), row[1]
        rid = s['id']
        require(state in ('approved','pending','peer_signed','signed'))
        manifest(s)
        peer = route(root,s)

        def authorized():
            require(db.execute('SELECT 1 FROM grants WHERE id=? AND NOT revoked', (rid,)).fetchone())
            require(route(root,s) == peer)
            manifest(s)

        # A stored output is only hashed locally; anything else may move the input and output.
        seconds = budget(root, 0 if state == 'signed' else (directory(root,'inputs') / rid).stat().st_size)
        signal.signal(signal.SIGALRM, stop('timed_out'))
        signal.setitimer(signal.ITIMER_REAL, seconds)
        # A durable claim before contacting the peer. A lost reply permits lookup only.
        with transaction(db):
            fresh = db.execute("UPDATE grants SET state='pending' WHERE id=? AND NOT revoked AND state='approved'", (rid,)).rowcount == 1
            if fresh:
                db.execute('INSERT INTO dispatch_peer VALUES(?,?)', (rid,peer))
            event(db, ctx, rid, 'request' if fresh else 'lookup')
        accepted(rid, seconds, 'sign' if fresh else 'stored' if state == 'signed' else 'lookup')
        output = directory(root,'outputs') / rid
        if state == 'signed':
            fence()
            authorized()
            return rid, checked_output(db,rid,output)
        p = dial(root,peer)
        try:
            inp = directory(root,'inputs') / rid
            size = inp.stat().st_size if fresh else 0
            send(p.stdin, canonical({'grant':s,'mode':'sign' if fresh else 'lookup','size':size,
                                     'failure_details':True}).encode())
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
                    event(db,ctx,rid,'signed')
                    db.commit()
                except BaseException:
                    db.rollback()
                    raise
            return rid,sha
        finally:
            p.kill()
            p.wait()
            try:
                p.stdin.close()
            except BrokenPipeError:
                pass
            finally:
                p.stdout.close()
    except Exception as exc:
        signal.setitimer(signal.ITIMER_REAL, 0)
        if db.in_transaction:
            db.rollback()
        event(db,ctx,rid,exc.action if isinstance(exc, Stopped) else 'not_released')
        raise
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)


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
        def accepted(rid, seconds, mode):
            send(sys.stdout.buffer, f'accepted {rid} {seconds} {mode}'.encode())
        rid, sha = request(root,db,json.loads(line(sys.stdin.buffer)),fence,accepted=accepted)
        print(rid,sha)
    elif cmd == 'permit':
        rid=sys.argv[3]
        with os.fdopen(3,'rb') as f:
            sha=permit(root,db,json.loads(line(sys.stdin.buffer)),rid,f,fence)
        print(rid,sha)
    elif cmd == 'reconcile':
        print(canonical(reconcile(db,root,sys.argv[3])))
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
