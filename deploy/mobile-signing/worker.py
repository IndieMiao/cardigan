"""SSH forced command for the dedicated signing UID. No shell command protocol."""
from contextlib import closing, contextmanager, nullcontext
import fcntl
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
import sys
import tempfile
import time

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


# C-612 same-machine handoff. Owner full access, group traverse only (with or
# without setgid), nothing for others: no account lists the directory, and
# only the directory's group can open a file whose name it already knows.
HANDOFF_MODES = (0o710, 0o2710)
HANDOFF_FILE = 0o640
# Copies older than this are removed by the signer's own periodic job
# (`worker.py <root> prune`, scheduled by the administrator). Without a recent
# run of that job there is no handoff at all: the Run downloads as before.
HANDOFF_TTL = 3600
PRUNE_FRESH = 900
HANDOFF_NAME = re.compile(r'\.?[0-9a-f]{32}(?:\.apk|\..+)', re.ASCII)


def group_members(gid):
    """Every account in the group: listed members and primary-group users."""
    import grp
    import pwd
    uids = {pwd.getpwnam(name).pw_uid for name in grp.getgrgid(gid).gr_mem}
    return uids | {p.pw_uid for p in pwd.getpwall() if p.pw_gid == gid}


def own_dir(c):
    d = Path(c['handoff_dir'])
    st = d.lstat()
    require(d.is_absolute() and stat.S_ISDIR(st.st_mode) and st.st_uid == os.getuid())
    return d, st


def handoff_dir(c, worker_uid):
    """The handoff directory, only if its group admits exactly the target worker."""
    d, st = own_dir(c)
    require(stat.S_IMODE(st.st_mode) in HANDOFF_MODES)
    require(group_members(st.st_gid) - {os.getuid()} == {worker_uid})
    return d, st.st_gid


def prune(d, now=None):
    # Only this signer's own files with handoff names; never follows links.
    now = time.time() if now is None else now
    for entry in os.scandir(d):
        try:
            st = entry.stat(follow_symlinks=False)
            if (HANDOFF_NAME.fullmatch(entry.name) and stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid()
                    and now - st.st_mtime > HANDOFF_TTL):
                os.unlink(d / entry.name)
        except OSError:
            pass


def expire(root, now=None):
    """The administrator's periodic job: remove expired copies, then prove it ran."""
    c = config(root/'identity.json')
    if 'handoff_dir' in c:
        prune(own_dir(c)[0], now)
    beat = root/'handoff-pruned'
    fd = os.open(beat, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    os.close(fd)
    os.utime(beat)


def pruned_recently(root):
    st = (root/'handoff-pruned').lstat()
    require(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and not st.st_mode & 0o077
            and 0 <= time.time() - st.st_mtime <= PRUNE_FRESH)


def handoffs(db):
    db.execute('CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, name TEXT NOT NULL)')


def handoff(root, db, c, s, output, sha):
    """C-612: same-machine handoff of a signed Android test APK.

    Only when the control host asks for it, this identity names a
    `handoff_dir` (administrator-created, owned by this signing UID, mode
    0710 or 02710, whose group holds no account but the request's worker UID)
    and the periodic expiry job ran within `PRUNE_FRESH`. The copy gets a
    fresh random name that only this signer and, after its own final
    authorization, the control host know; the directory cannot be listed,
    so nobody opens it before the host releases the receipt. It is readable
    by that group only, written whole, linked in without replacing anything
    and removed by the expiry job after `HANDOFF_TTL` or when the control
    host withdraws it. Any problem only skips the handoff; the control host
    still receives the bytes and the Run downloads them as before.
    """
    try:
        rid = s['id']
        pruned_recently(root)
        d, gid = handoff_dir(c, s['worker_uid'])
        handoffs(db)
        row = db.execute('SELECT name FROM handoffs WHERE id=?', (rid,)).fetchone()
        if row and os.path.lexists(d / row[0]):
            dest = d / row[0]
            ds = dest.lstat()
            require(stat.S_ISREG(ds.st_mode) and ds.st_uid == os.getuid() and ds.st_gid == gid
                    and stat.S_IMODE(ds.st_mode) == HANDOFF_FILE)
            require(digest(dest) == sha)
            return str(dest)
        name = secrets.token_hex(16) + '.apk'
        dest = d / name
        fd, tmp = tempfile.mkstemp(dir=d, prefix=f'.{secrets.token_hex(16)}.')
        try:
            with os.fdopen(fd, 'wb') as out, output.open('rb') as f:
                if os.fstat(out.fileno()).st_gid != gid:
                    os.fchown(out.fileno(), -1, gid)
                require(transfer(f, out, os.fstat(f.fileno()).st_size) == sha)
                out.flush()
                os.fsync(out.fileno())
                os.fchmod(out.fileno(), HANDOFF_FILE)
                st = os.fstat(out.fileno())
                require(st.st_gid == gid and stat.S_IMODE(st.st_mode) == HANDOFF_FILE)
            os.link(tmp, dest)
        finally:
            os.unlink(tmp)
        db.execute('INSERT OR REPLACE INTO handoffs VALUES(?,?)', (rid, name))
        return str(dest)
    except Exception:
        return None


def withdraw(root, c, s):
    """Remove this request's handed-off copy after the control host revoked it."""
    d = own_dir(c)[0]
    db = database(root, 'CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY,spec TEXT,state TEXT,sha TEXT)')
    handoffs(db)
    row = db.execute('SELECT name FROM handoffs WHERE id=?', (s['id'],)).fetchone()
    if row and os.path.lexists(d / row[0]):
        dest = d / row[0]
        require(stat.S_ISREG(dest.lstat().st_mode) and dest.lstat().st_uid == os.getuid())
        os.unlink(dest)
    db.execute('DELETE FROM handoffs WHERE id=?', (s['id'],))
    prune(d)


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
    if mode == 'withdraw':
        # C-612: no key, no bytes; only removes this request's own handoff copy.
        require(req['size'] == 0)
        c = config(root/'identity.json')
        require(all(c[k] == s[k] for k in ('project','machine','platform','app','version')) and 'handoff_dir' in c)
        withdraw(root, c, s)
        send(dst, b'withdrawn')
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
        local = (handoff(root, db, c, s, output, row[1]) if req.get('handoff') is True and s['platform'] == 'android'
                 and 'handoff_dir' in c else None)
        send(dst,canonical({'size':size,'sha256':row[1],**({'handoff':local} if local else {})}).encode())
        with output.open('rb') as f:
            transfer(f,dst,size)
        dst.flush()


def main():
    try:
        os.umask(0o077)
        require(not os.environ.get('SSH_ORIGINAL_COMMAND'))
        root = private_dir(Path(sys.argv[1]))
        if sys.argv[2:] == ['prune']:
            # Local scheduled job of the signing account; never reachable over
            # SSH, whose forced command passes only the root.
            expire(root)
        else:
            serve(root,sys.stdin.buffer,sys.stdout.buffer)
    except Exception:
        sys.exit(1)


if __name__=='__main__':
    main()
