"""SSH forced command for the dedicated signing UID. No shell command protocol."""
from contextlib import closing, contextmanager, nullcontext
import fcntl
import os
from pathlib import Path
import sqlite3
import stat
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (SigningFailure, canonical, config, database, digest, directory, json, line,
                    manifest, persist, private_dir, read_failure, require, save_failure, send,
                    transaction, transfer)
from platforms import android, ios, lock_keychain


@contextmanager
def signing_session(c, root):
    try:
        yield
    finally:
        if c['platform'] == 'ios':
            lock_keychain(c, root)


# Receipt states: `received` (C-601) while the input arrives and until the
# commit; the key is never used in it, so the same request number may be
# resent. `pending` is written durably on commit, before any key use; from
# then on only lookup. Old signers wrote `pending` already on receipt.
def receipt(root, spec, *, failure_details=True, dispatch_states=False):
    # Metadata only: no signing policy/key access, no output bytes, no journal mutation.
    # Old control hosts know only pending/signed/failed and an existing row.
    path = root/'audit.sqlite'
    if dispatch_states and not path.exists():
        return {'state': 'absent', 'sha256': None}
    with closing(sqlite3.connect(path.as_uri()+'?mode=ro', uri=True)) as db:
        table = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='receipts'").fetchone()
        row = db.execute('SELECT spec,state,sha FROM receipts WHERE id=?', (spec['id'],)).fetchone() if table else None
        if dispatch_states and row is None:
            return {'state': 'absent', 'sha256': None}
        require(row and row[0] == canonical(spec))
        state = row[1] if dispatch_states or row[1] != 'received' else 'pending'
        details = read_failure(db, spec['id']) if failure_details and state == 'failed' else {}
        return {'state': state, 'sha256': row[2], **details}


HANDOFF_MODES = (0o711, 0o751)


def handoff(c, rid, output, sha):
    """C-612: same-machine handoff of a signed Android test APK.

    Only when the control host asks for it and this identity names a
    `handoff_dir`: an administrator-created directory owned by this signing
    UID that others may traverse but neither list nor write. The file is
    named by the unguessable request number, written whole, then linked in
    without replacing anything. Any problem only skips the handoff; the
    control host still receives the bytes as before.
    """
    try:
        d = Path(c['handoff_dir'])
        st = d.lstat()
        require(d.is_absolute() and stat.S_ISDIR(st.st_mode) and st.st_uid == os.getuid()
                and stat.S_IMODE(st.st_mode) in HANDOFF_MODES)
        dest = d / f'{rid}.apk'
        if os.path.lexists(dest):
            ds = dest.lstat()
            require(stat.S_ISREG(ds.st_mode) and ds.st_uid == os.getuid() and stat.S_IMODE(ds.st_mode) == 0o644)
            require(digest(dest) == sha)
            return str(dest)
        fd, tmp = tempfile.mkstemp(dir=d, prefix=f'.{rid}.')
        try:
            with os.fdopen(fd, 'wb') as out, output.open('rb') as f:
                require(transfer(f, out, os.fstat(f.fileno()).st_size) == sha)
                out.flush()
                os.fsync(out.fileno())
            os.chmod(tmp, 0o644)
            os.link(tmp, dest)
        finally:
            os.unlink(tmp)
        return str(dest)
    except Exception:
        return None


def serve(root, src, dst, adapters=None):
    req = json.loads(line(src))
    s, mode = req['grant'], req['mode']
    manifest(s, live=False)
    require(s['worker_uid'] != os.getuid() and os.getuid() != 0)
    if mode == 'receipt':
        require(req['size'] == 0)
        send(dst, canonical(receipt(root, s, failure_details=req.get('failure_details') is True,
                                    dispatch_states=req.get('dispatch_states') is True)).encode())
        return
    require(mode in ('sign', 'lookup'))
    with (root/'serial.lock').open('ab') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        c = config(root/'identity.json')
        # Hold the serial lock through cleanup; do not publish a receipt or bytes
        # unless the lock-back succeeded. Read-only lookups never use an identity.
        with signing_session(c, root) if mode == 'sign' else nullcontext():
            require(all(c[k] == s[k] for k in ('project','machine','platform','app','version')))
            manifest(s)
            db = database(root, 'CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY,spec TEXT,state TEXT,sha TEXT)')
            rid, spec = s['id'], canonical(s)
            output = directory(root,'outputs')/rid
            with tempfile.TemporaryDirectory(dir=root) as d:
                tmp = Path(d)
                if mode == 'sign':
                    candidate = tmp/('input.apk' if s['platform']=='android' else 'input.zip')
                    # Under the serial lock: a resend is accepted only while the
                    # earlier attempt never reached the commit (C-601).
                    seen = db.execute('SELECT spec,state FROM receipts WHERE id=?', (rid,)).fetchone()
                    if seen:
                        require(seen == (spec, 'received'))
                    else:
                        db.execute("INSERT INTO receipts VALUES(?,?,'received',NULL)", (rid,spec))
                    with candidate.open('xb') as f:
                        require(transfer(src, f, req['size']) == s['sha256'])
                else:
                    require(req['size'] == 0)
                send(dst,b'ready')
                require(line(src)==b'commit')
                manifest(s)
                require(config(root/'identity.json') == c)
                if mode == 'sign':
                    # Durable dispatch mark before any key use; never resent after this.
                    require(db.execute("UPDATE receipts SET state='pending' WHERE id=? AND spec=? AND state='received'",
                                       (rid, spec)).rowcount == 1)
                    try:
                        signed = tmp/('signed.apk' if s['platform']=='android' else 'signed.zip')
                        (adapters or {'android':android,'ios':ios})[s['platform']](c,candidate,signed,tmp)
                        sha = digest(signed)
                        persist(signed, output)
                    except Exception as exc:
                        category = exc.category if isinstance(exc, SigningFailure) else 'signing_failed'
                        with transaction(db):
                            db.execute("UPDATE receipts SET state='failed' WHERE id=?", (rid,))
                            save_failure(db, rid, category)
                        sha = None
        if mode == 'sign' and sha is not None:
            db.execute("UPDATE receipts SET state='signed',sha=? WHERE id=?", (sha,rid))
        row = db.execute('SELECT state,sha FROM receipts WHERE id=? AND spec=?',(rid,spec)).fetchone()
        require(row)
        if row[0]=='failed':
            # Old control hosts compare the whole header to {"status":"failed"}.
            details = read_failure(db, rid) if req.get('failure_details') is True else {}
            send(dst, canonical({'status': 'failed', **details}).encode())
            return
        require(row[0]=='signed' and digest(output)==row[1])
        size=output.stat().st_size
        local = (handoff(c, rid, output, row[1]) if req.get('handoff') is True and s['platform'] == 'android'
                 and 'handoff_dir' in c else None)
        send(dst,canonical({'size':size,'sha256':row[1],**({'handoff':local} if local else {})}).encode())
        with output.open('rb') as f:
            transfer(f,dst,size)
        dst.flush()


if __name__=='__main__':
    try:
        os.umask(0o077)
        require(not os.environ.get('SSH_ORIGINAL_COMMAND'))
        serve(private_dir(Path(sys.argv[1])),sys.stdin.buffer,sys.stdout.buffer)
    except Exception:
        sys.exit(1)
