"""Conservative first-release archive subset: no links, aliases, extensions or project hooks."""
import re
import shutil
import stat
import struct
import zipfile
from common import LIMIT, require


SEGMENT = re.compile(r'[a-zA-Z0-9_+@.-][a-zA-Z0-9_.$@+ -]*')
LOCAL_HEADER = struct.Struct('<4s14xIIHH')  # signature, sizes, name/extra lengths


def require_classic_extra(extra):
    pos = 0
    while pos + 4 <= len(extra):
        tag, size = struct.unpack_from('<HH', extra, pos)
        pos += 4 + size
        require(tag != 0x0001 and pos <= len(extra))  # ZIP64 extended information
    require(not any(extra[pos:]))  # allow trailing zero alignment padding


def require_classic_member(f, member):
    # A small member can use ZIP64 only in its local header. ZipInfo exposes
    # decoded sizes and the central extra, neither of which rules that out.
    require_classic_extra(member.extra)
    require(member.volume == 0 and member.compress_size < 0xffffffff)
    f.seek(member.header_offset)
    header = f.read(LOCAL_HEADER.size)
    require(len(header) == LOCAL_HEADER.size)
    magic, compressed, expanded, name_size, extra_size = LOCAL_HEADER.unpack(header)
    require(magic == b'PK\x03\x04' and 0xffffffff not in (compressed, expanded))
    f.seek(name_size, 1)
    extra = f.read(extra_size)
    require(len(extra) == extra_size)
    require_classic_extra(extra)


def inspect_zip(path, dest=None, *, apk=False):
    # Bound the central directory before letting ZipFile allocate its member table.
    with path.open('rb') as f:
        f.seek(-22,2)
        end = f.tell()
        magic, disk, cd_disk, n_disk, n, size, offset, comment = struct.unpack('<4s4H2IH',f.read(22))
        require(magic == b'PK\x05\x06' and disk == cd_disk == comment == 0 and 0 < n == n_disk
                and offset+size == end and offset >= 16)
        require(n <= 16000 and size <= 4*1024*1024, 'archive_too_large')
        f.seek(offset-16)
        require(f.read(16) != b'APK Sig Block 42')
    with path.open('rb') as raw, zipfile.ZipFile(raw) as z:
        seen, spell, dirs, files, total = set(), {}, set(), set(), 0
        require(len(z.infolist()) == n)
        for i in z.infolist():
            if apk:
                require_classic_member(raw, i)
            name = i.orig_filename.removesuffix('/')
            parts = name.split('/')
            # No empty/absolute segments, trailing dots/spaces (including . and ..),
            # separators other than '/', or control characters, even for APKs.
            # Only APKs may start a segment with '.' (Godot) or '-' (AAPT2 shortened
            # resources); member names never reach a tool's argv.
            require(len(name)<=512 and len(parts)<=32 and all(
                SEGMENT.fullmatch(p) and (apk or not p.startswith(('.', '-'))) and not p.endswith((' ', '.')) for p in parts), 'archive_member_name')
            require(not (i.flag_bits & 1) and i.compress_type in (0,8))
            require(stat.S_IFMT(i.external_attr >> 16) in (0, stat.S_IFDIR if i.is_dir() else stat.S_IFREG))
            require(name not in seen, 'archive_member_name')
            for j in range(len(parts)):
                prefix='/'.join(parts[:j+1]); require(spell.setdefault(prefix.lower(),prefix)==prefix, 'archive_member_name')
            parents = {'/'.join(parts[:j]) for j in range(1,len(parts))}
            require(not files.intersection(parents) and (i.is_dir() or name not in dirs), 'archive_member_name')
            dirs.update(parents); (dirs if i.is_dir() else files).add(name)
            seen.add(name)
            total += i.file_size
            require(total <= LIMIT and i.file_size <= LIMIT, 'archive_too_large')
            require(not i.is_dir() or not i.file_size)
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
