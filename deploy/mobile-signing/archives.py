"""Conservative first-release archive subset: no links, aliases, extensions or project hooks."""
import re
import shutil
import stat
import struct
import zipfile
from common import LIMIT, require


def inspect_zip(path, dest=None):
    # Bound the central directory before letting ZipFile allocate its member table.
    with path.open('rb') as f:
        f.seek(-22,2)
        end = f.tell()
        magic, disk, cd_disk, n_disk, n, size, offset, comment = struct.unpack('<4s4H2IH',f.read(22))
        require(magic == b'PK\x05\x06' and disk == cd_disk == comment == 0 and 0 < n == n_disk <= 16000
                and size <= 4*1024*1024 and offset+size == end and offset >= 16)
        f.seek(offset-16)
        require(f.read(16) != b'APK Sig Block 42')
    with zipfile.ZipFile(path) as z:
        seen, spell, dirs, files, total = set(), {}, set(), set(), 0
        require(len(z.infolist()) == n)
        for i in z.infolist():
            name = i.orig_filename.removesuffix('/')
            parts = name.split('/')
            require(len(name)<=512 and len(parts)<=32 and all(re.fullmatch(r'[a-zA-Z0-9_+@][a-zA-Z0-9_.$@+ -]*|[0-9][a-zA-Z0-9_.$@+ -]*',p) and not p.endswith((' ','.')) for p in parts))
            require(not (i.flag_bits & 1) and i.compress_type in (0,8))
            require(stat.S_IFMT(i.external_attr >> 16) in (0, stat.S_IFDIR if i.is_dir() else stat.S_IFREG))
            require(name not in seen)
            for j in range(len(parts)):
                prefix='/'.join(parts[:j+1]); require(spell.setdefault(prefix.lower(),prefix)==prefix)
            parents = {'/'.join(parts[:j]) for j in range(1,len(parts))}
            require(not files.intersection(parents) and (i.is_dir() or name not in dirs))
            dirs.update(parents); (dirs if i.is_dir() else files).add(name)
            seen.add(name)
            total += i.file_size
            require(total <= LIMIT and i.file_size <= LIMIT and (not i.is_dir() or not i.file_size))
            if dest is not None:
                out = dest.joinpath(*parts)
                if i.is_dir():
                    out.mkdir(parents=True,exist_ok=True)
                else:
                    out.parent.mkdir(parents=True,exist_ok=True)
                    with z.open(i) as src, out.open('xb') as dst:
                        shutil.copyfileobj(src,dst,1024*1024)
            elif not i.is_dir():
                with z.open(i) as src:
                    while src.read(1024*1024):
                        pass  # validate each local header, CRC and decompression bound
        return seen
