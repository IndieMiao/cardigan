# C-390: file steps of `cardigan hc upgrade` on one hc target (this host, the
# execution account via sudo, or a registered worker via ssh). Started as
#   python3 -I -c 'import sys,base64,zlib;exec(zlib.decompress(base64.b64decode(sys.stdin.buffer.readline())))'
# stdin: this script (zlib+base64, one line), one JSON request line, then the
# archive bytes for `stage`. stdout: one JSON result line. Only stdlib.
import hashlib, io, json, os, shutil, stat, subprocess, sys, tarfile, tempfile, time

def fail(message):
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(1)

def version_of(path):
    try:
        out = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=30)
    except Exception:
        return None
    return out.stdout.strip() if out.returncode == 0 else None

def safe_name(name, prefix):
    parts = name.split("/")
    return (not name.startswith("/") and ".." not in parts
            and (name == prefix or name.startswith(prefix + "/")))

def extract(archive, platform, target):
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as bundle:
        if platform.startswith("linux-"):
            member = bundle.getmember("herdr-core")
            if not member.isfile():
                fail("hc archive must contain a regular herdr-core binary")
            path = os.path.join(target, "herdr-core")
            with open(path, "wb") as out:
                out.write(bundle.extractfile(member).read())
            os.chmod(path, 0o755)
            os.symlink("herdr-core", os.path.join(target, "hc"))
            return
        if not platform.startswith("macos-"):
            fail("unsupported platform " + platform)
        app = "Herdr Core.app"
        for member in bundle.getmembers():
            if not safe_name(member.name, app):
                continue
            path = os.path.join(target, member.name)
            if member.isdir():
                os.makedirs(path, exist_ok=True)
            elif member.isfile():
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "wb") as out:
                    out.write(bundle.extractfile(member).read())
                os.chmod(path, member.mode & 0o755)
            elif member.issym():
                resolved = os.path.normpath(os.path.join(os.path.dirname(member.name), member.linkname))
                if member.linkname.startswith("/") or not safe_name(resolved, app):
                    fail("hc archive link escapes the app bundle")
                os.makedirs(os.path.dirname(path), exist_ok=True)
                os.symlink(member.linkname, path)
            else:
                fail("hc archive contains an unsupported entry")
        binary = os.path.join(app, "Contents", "MacOS", "herdr-core")
        if not os.path.isfile(os.path.join(target, binary)):
            fail("hc archive has no app binary")
        os.symlink(binary, os.path.join(target, "hc"))

def stage(request, archive):
    root, version, digest = request["install_root"], request["version"], request["sha256"]
    final = os.path.join(root, version)
    marker = os.path.join(final, ".sha256")
    if os.path.isfile(marker) and open(marker).read().strip() == digest \
            and version_of(os.path.join(final, "hc")) == "hc " + version:
        return {"hc": os.path.join(final, "hc"), "staged": False}
    if hashlib.sha256(archive).hexdigest() != digest:
        fail("hc archive sha256 mismatch")
    os.makedirs(root, mode=0o755, exist_ok=True)
    work = tempfile.mkdtemp(prefix=".stage-", dir=root)
    os.chmod(work, 0o755)
    extract(archive, request["platform"], work)
    if version_of(os.path.join(work, "hc")) != "hc " + version:
        shutil.rmtree(work, ignore_errors=True)
        fail("staged hc does not report version " + version)
    with open(os.path.join(work, ".sha256"), "w") as out:
        out.write(digest + "\n")
    if os.path.lexists(final):
        os.rename(final, os.path.join(root, ".stale-%s-%d" % (version, int(time.time() * 1000))))
    os.rename(work, final)
    return {"hc": os.path.join(final, "hc"), "staged": True}

def inspect(request):
    link = request["link"]
    try:
        info = os.lstat(link)
    except FileNotFoundError:
        return {"kind": "missing"}
    if stat.S_ISLNK(info.st_mode):
        return {"kind": "symlink", "target": os.readlink(link)}
    if stat.S_ISREG(info.st_mode):
        return {"kind": "file"}
    fail(link + " is neither a file nor a symlink")

def replace_with_symlink(link, target):
    temporary = os.path.join(os.path.dirname(link), ".hc-switch-%d-%d" % (os.getpid(), int(time.time() * 1000)))
    os.symlink(target, temporary)
    os.replace(temporary, link)

def switch(request):
    link, dest, previous = request["link"], request["dest"], request["previous"]
    current = inspect(request)
    if current.get("kind") == "symlink" and current["target"] == dest:
        return {"switched": False}
    if previous["kind"] == "file":
        if current.get("kind") != "file":
            fail(link + " changed since it was inspected")
        backup = previous["backup"]
        if not os.path.lexists(backup):
            os.makedirs(os.path.dirname(backup), mode=0o755, exist_ok=True)
            shutil.copy2(link, backup)
    elif current != previous:
        fail(link + " changed since it was inspected")
    replace_with_symlink(link, dest)
    return {"switched": True}

def restore(request):
    link, previous = request["link"], request["previous"]
    if previous["kind"] == "symlink":
        current = inspect(request)
        if current.get("kind") != "symlink" or current["target"] != previous["target"]:
            replace_with_symlink(link, previous["target"])
        return {"restored": True}
    backup = previous["backup"]
    if not os.path.isfile(backup):
        fail("backup " + backup + " is missing")
    temporary = os.path.join(os.path.dirname(link), ".hc-restore-%d" % os.getpid())
    shutil.copy2(backup, temporary)
    os.replace(temporary, link)
    return {"restored": True}

def main():
    request = json.loads(sys.stdin.buffer.readline())
    op = request.get("op")
    if op == "stage":
        result = stage(request, sys.stdin.buffer.read())
    elif op == "inspect":
        result = inspect(request)
    elif op == "switch":
        result = switch(request)
    elif op == "restore":
        result = restore(request)
    else:
        fail("unknown op")
    result["ok"] = True
    print(json.dumps(result))

main()
