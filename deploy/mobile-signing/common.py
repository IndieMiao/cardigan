"""Private files and bounded, typed messages shared by the host and forced command."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import time

LIMIT = 512 * 1024 * 1024
SCOPE = ('project', 'machine', 'card', 'assignment', 'run', 'platform', 'worker_uid')
FIELDS = (*SCOPE, 'id', 'version', 'app', 'build', 'commit', 'sha256', 'expires')


# Only these constants cross the signing boundary; never stringify a tool error.
FAILURES = frozenset(('archive_invalid', 'archive_member_name', 'archive_too_large',
                      'package_mismatch', 'apksigner_failed', 'signing_failed'))


class SigningFailure(ValueError):
    def __init__(self, category):
        super().__init__('refused')
        self.category = category


@contextmanager
def failure_stage(category):
    try:
        yield
    except SigningFailure:
        raise
    except Exception:
        raise SigningFailure(category) from None


def failure_fields(category):
    return {'failure_category': category} if isinstance(category, str) and category in FAILURES else {}


def save_failure(db, rid, category):
    if failure_fields(category):
        # Side table keeps old writers and pre-upgrade receipts compatible.
        db.execute('CREATE TABLE IF NOT EXISTS failure_categories (id TEXT PRIMARY KEY, category TEXT NOT NULL)')
        db.execute('INSERT OR REPLACE INTO failure_categories VALUES (?,?)', (rid, category))


def read_failure(db, rid):
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='failure_categories'").fetchone():
        row = db.execute('SELECT category FROM failure_categories WHERE id=?', (rid,)).fetchone()
        if row:
            return failure_fields(row[0])
    return {}


def require(value, category=None):
    if not value:
        if category:
            raise SigningFailure(category)
        raise ValueError('refused')


def scope(s):
    require(type(s['worker_uid']) is int and s['worker_uid'] > 0)
    for k in SCOPE[:-1]:
        require(re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}', s[k]))
    require(s['platform'] in ('android', 'ios'))
    return canonical({k: s[k] for k in SCOPE})


def manifest(s, *, live=True):
    scope(s)
    require(set(s) == set(FIELDS))
    for k, pattern in [('id', '[0-9a-f]{32}'), ('commit', '[0-9a-f]{40}'), ('sha256', '[0-9a-f]{64}'),
                       ('app', r'[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+' if s['platform']=='android' else r'[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+'), ('build', r'[\w.-]{1,128}'), ('version', r'[\w.-]{1,128}')]:
        require(re.fullmatch(pattern, s[k], re.ASCII))
    require(type(s['expires']) is int and (not live or time.time() < s['expires']))


def canonical(x):
    return json.dumps(x, sort_keys=True, separators=(',', ':'))


def private_dir(path):
    st = path.lstat()
    require(stat.S_ISDIR(st.st_mode) and st.st_uid == os.getuid() and not st.st_mode & 0o077)
    return path


def private_file(path):
    st = path.lstat()
    require(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and not st.st_mode & 0o077)
    return path


def config(path):
    return json.loads(private_file(path).read_bytes())


def directory(base, name):
    path = base / name
    path.mkdir(mode=0o700, exist_ok=True)
    return private_dir(path)


@contextmanager
def transaction(db):
    db.execute('BEGIN IMMEDIATE')
    try:
        yield
        db.commit()
    except BaseException:
        db.rollback()
        raise


def database(base, schema):
    db = sqlite3.connect(base / 'audit.sqlite', isolation_level=None)
    db.execute('PRAGMA synchronous=FULL')
    db.execute(schema)
    return db


def line(stream):
    data = stream.readline(8193)
    require(len(data) <= 8192 and data.endswith(b'\n'))
    return data[:-1]


def send(stream, data):
    stream.write(data + b'\n')
    stream.flush()


def transfer(src, dst, size):
    require(type(size) is int and 0 < size <= LIMIT)
    digest = hashlib.sha256()
    while size:
        chunk = src.read(min(size, 1024 * 1024))
        require(chunk)
        digest.update(chunk)
        if dst:
            dst.write(chunk)
        size -= len(chunk)
    return digest.hexdigest()


def digest(path):
    with path.open('rb') as f:
        return transfer(f, None, os.fstat(f.fileno()).st_size)


def persist(temp, dest):
    with temp.open('rb') as f:
        os.fsync(f.fileno())
    os.replace(temp, dest)
    fd = os.open(dest.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
