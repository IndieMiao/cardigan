"""Fixed signing recipes. No build system, project plugin, shell or upload tool."""
from datetime import datetime, timezone
import hashlib
import os
from pathlib import Path
import plistlib
import re
import resource
import shutil
import struct
import subprocess
import tempfile
import zipfile
from archives import inspect_zip
from common import LIMIT, digest, private_file, require


def tool(cwd, argv, diagnostics=False):
    # Fixed binaries and clean environment; do not return/log native diagnostics.
    require(Path(argv[0]).is_absolute())
    with tempfile.TemporaryFile(dir=cwd) as out:
        subprocess.run(argv,cwd=cwd,env={'PATH':'/usr/bin:/bin','LC_ALL':'C','TMPDIR':str(cwd)},
                       stdin=subprocess.DEVNULL,stdout=out,stderr=out if diagnostics else subprocess.DEVNULL,
                       check=True,timeout=120,preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_FSIZE,(LIMIT,LIMIT)))
        require(out.tell() <= 2*1024*1024)
        out.seek(0)
        return out.read()


def android(c, src, dest, tmp):
    names = inspect_zip(src)
    require('AndroidManifest.xml' in names and not any(re.match(r'(?i)^META-INF/[^/]+\.(SF|RSA|DSA|EC)$',n) for n in names))
    def package(path):
        return tool(tmp,[c['aapt2'],'dump','packagename',path]).decode().strip()
    require(package(src)==c['app'])
    tool(tmp,[c['apksigner'],'sign','--ks',private_file(Path(c['keystore'])), '--ks-key-alias',c['alias'],
              '--ks-pass','file:'+str(private_file(Path(c['store_password_file']))),
              '--key-pass','file:'+str(private_file(Path(c['key_password_file']))),
              '--v4-signing-enabled','false','--out',dest,src])
    result=tool(tmp,[c['apksigner'],'verify','--print-certs',dest]).decode()
    certs=re.findall(r'^Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]{64})$',result,re.M)
    require([d.lower() for d in certs] == [c['cert_sha256']] and package(dest)==c['app'])


def plist(path):
    require(path.stat().st_size <= 2*1024*1024)
    return plistlib.loads(path.read_bytes())


def device_binary(path, filetype):
    # Single arm64 device slice only; Info.plist alone cannot rule out simulator code.
    with path.open('rb') as f:
        magic,cpu,_,kind,n,size,_,_=struct.unpack('<8I',f.read(32))
        require(magic==0xfeedfacf and cpu==0x0100000c and kind==filetype and 0<n<=8192 and size<=2*1024*1024)
        commands=f.read(size); require(len(commands)==size); offset=0; platforms=[]
        for _ in range(n):
            cmd,length=struct.unpack_from('<II',commands,offset)
            require(length>=8 and offset+length<=size and cmd!=0x1d)  # unsigned input
            if cmd==0x32:  # LC_BUILD_VERSION
                require(length>=24); platforms.append(struct.unpack_from('<I',commands,offset+8)[0])
            offset+=length
        require(offset==size and platforms==[2])  # PLATFORM_IOS, not IOSSIMULATOR


def ios(c,src,dest,tmp):
    codesign='/usr/bin/codesign'; security='/usr/bin/security'
    keychain=private_file(Path(c['keychain']))
    try:
        tree=tmp/'tree'; tree.mkdir()
        inspect_zip(src,tree)
        archive,=tree.iterdir(); require(archive.suffix=='.xcarchive')
        require({p.name for p in archive.iterdir()} <= {'Products','Info.plist','dSYMs'} and [p.name for p in (archive/'Products').iterdir()]==['Applications'])
        app,=(archive/'Products'/'Applications').iterdir(); require(app.suffix=='.app' and app.is_dir())
        props=plist(archive/'Info.plist')['ApplicationProperties']; info=plist(app/'Info.plist')
        require(props['ApplicationPath']=='Applications/'+app.name and props['CFBundleIdentifier']==info['CFBundleIdentifier']==c['app']
                and info['CFBundlePackageType']=='APPL' and info['CFBundleSupportedPlatforms']==['iPhoneOS'])
        # Thin device archive only. Nested code is a private exact allowlist, not --deep signing.
        targets=[]
        for name,bundle_id in c['frameworks'].items():
            require(re.fullmatch(r'[A-Za-z0-9_+-]+\.framework',name))
            fw=app/'Frameworks'/name; fi=plist(fw/'Info.plist'); require(fi['CFBundlePackageType']=='FMWK' and fi['CFBundleIdentifier']==bundle_id)
            targets.append((fw,fi))
        targets.append((app,info))
        executables=set()
        for target,i in targets:
            exe=i['CFBundleExecutable']; require(re.fullmatch(r'[a-zA-Z0-9_+.-]+',exe) and not exe.startswith('.'))
            device_binary(target/exe, 2 if target==app else 6)
            executables.add(target/exe)
        macho = {bytes.fromhex(s) for s in ('feedface','cefaedfe','feedfacf','cffaedfe','cafebabe','bebafeca','cafebabf','bfbafeca')}
        found=set()
        for path in archive.rglob('*'):
            if path.is_dir():
                require(path.name not in ('_CodeSignature','PlugIns','Watch','XPCServices') and (path.suffix.lower() not in ('.app','.framework','.appex','.bundle','.xpc','.plugin') or path in [t for t,_ in targets]))
            else:
                require(path.name != 'embedded.mobileprovision')
                with path.open('rb') as f:
                    if f.read(4) in macho:
                        rel=path.relative_to(archive).parts
                        if len(rel)==6 and rel[0]=='dSYMs' and rel[1].endswith('.dSYM') and rel[2:5]==('Contents','Resources','DWARF'):
                            continue  # debug data outside Products
                        require(path in executables); found.add(path)
        require(found==executables)
        profile=private_file(Path(c['profile'])); ent_file=private_file(Path(c['entitlements']))
        require(digest(profile)==c['profile_sha256'])
        profile_info=plistlib.loads(tool(tmp,[security,'cms','-D','-i',profile])); ent=plist(ent_file)
        require(profile_info['TeamIdentifier']==[c['team']] and 'iOS' in profile_info['Platform'] and
                profile_info['ExpirationDate'].replace(tzinfo=timezone.utc)>datetime.now(timezone.utc) and
                ent['application-identifier']==c['team']+'.'+c['app'] and ent['com.apple.developer.team-identifier']==c['team'])
        require(all(plistlib.dumps(v)==plistlib.dumps(profile_info['Entitlements'][k]) for k,v in ent.items()))
        leaf,=[cert for cert in profile_info['DeveloperCertificates'] if hashlib.sha256(cert).hexdigest()==c['cert_sha256']]
        identity=hashlib.sha1(leaf).hexdigest()  # codesign identity selector, not the policy fingerprint
        shutil.copyfile(profile, app/'embedded.mobileprovision')
        for target,meta in targets:
            (target/meta['CFBundleExecutable']).chmod(0o755)
            tool(tmp,[codesign,'--sign',identity,'--keychain',keychain,'--timestamp=none',
                      *(['--entitlements',ent_file,'--generate-entitlement-der'] if target==app else []),target])
            tool(tmp,[codesign,'--verify','--strict','--all-architectures',target]);
            desc=tool(tmp,[codesign,'--display','--verbose=4',target],True).decode()
            require(('TeamIdentifier='+c['team']) in desc.splitlines() and ('Identifier='+meta['CFBundleIdentifier']) in desc.splitlines())
            tool(tmp,[codesign,'--display','--extract-certificates='+str(tmp/'leaf'),target]); cert=tmp/'leaf0'
            require(digest(cert)==c['cert_sha256']); cert.unlink()
            actual=tool(tmp,[codesign,'--display','--entitlements','-','--xml',target]);
            require(plistlib.dumps(plistlib.loads(actual) if actual else {})==plistlib.dumps(ent if target==app else {}))
        tool(tmp,[codesign,'--verify','--deep','--strict','--all-architectures',app])
        with zipfile.ZipFile(dest,'x',compression=zipfile.ZIP_DEFLATED,allowZip64=False) as z:
            for path in sorted(archive.rglob('*')):
                z.write(path,path.relative_to(tree))
    finally:
        tool(tmp,[security,'lock-keychain',keychain])
