"""Synthetic Darwin observations only; never contacts a Mac, launchd or sudo."""
import builtins
import io
import json
import os
import platform
import plistlib
import shutil
import subprocess
import sys
import types
import urllib.error
import urllib.request

c = json.loads(sys.argv[1])
fault = c.get('fixture', 'safe')
platform.system = lambda: 'Darwin'
platform.machine = lambda: 'x86_64' if fault == 'intel' else 'arm64'
os.environ['PATH'] = c['path']


def forbidden(*args, **kwargs):
    raise AssertionError('Linux-only operation or unexpected IO')


if c['step'] in ('account', 'directories', 'helpers'):
    if c['step'] == 'account':
        policy = subprocess.run
        native['process_groups'] = lambda: [c['gid'], 80] if fault == 'process-admin' else [c['gid']]

        def run(argv, **kwargs):
            if argv[0] == '/usr/bin/dscl':
                assert argv == ['/usr/bin/dscl', '-plist', '.', '-read', '/Users/' + c['user'],
                                'UniqueID', 'PrimaryGroupID', 'NFSHomeDirectory']
                value = {'dsAttrTypeStandard:UniqueID': [str(c['uid'])],
                         'dsAttrTypeStandard:PrimaryGroupID': [str(c['gid'])],
                         'dsAttrTypeStandard:NFSHomeDirectory': [c['home']]}
                if fault == 'dscl-uid': value['dsAttrTypeStandard:UniqueID'] = ['0']
                return types.SimpleNamespace(returncode=0, stdout=plistlib.dumps(value))
            return policy(argv, **kwargs)
        subprocess.run = run
    else:
        native['acl_safe'] = lambda fd: not attributes(fd)
    os.listxattr = forbidden
elif c['step'] == 'tools':
    actual_open = builtins.open
    paths = {name: '/opt/homebrew/bin/' + name for name in ('node', 'git', 'pnpm')}
    paths.update(hc=c['launchd']['hc_path'], **{'herdr-core': c['home'] + '/.local/bin/herdr-core'})
    shutil.which = lambda name, **kwargs: paths.get(name)
    original_realpath = os.path.realpath
    os.path.realpath = lambda path: CORE if path in (paths['hc'], paths['herdr-core']) else path

    def opened(path, *args, **kwargs):
        if path == paths['pnpm']: return io.BytesIO(b'#!/usr/bin/env node\n')
        if path == APP + '/Contents/Info.plist':
            return io.BytesIO(plistlib.dumps(dict(CFBundleIdentifier='dev.herdr.core',
                                                   CFBundleShortVersionString=c['hc_version'])))
        return actual_open(path, *args, **kwargs)
    builtins.open = opened
    checked = set()

    def run(argv, **kwargs):
        assert kwargs['env']['PATH'] == c['path'] and kwargs['env']['HOME'] == c['home']
        assert kwargs['stdin'] == subprocess.DEVNULL
        if argv[0] == '/usr/bin/lipo':
            assert argv[1] == '-archs'
            checked.add(argv[2])
            arch = b'x86_64' if fault == 'intel-tool' else b'arm64 x86_64'
            return types.SimpleNamespace(returncode=0, stdout=arch)
        if argv[0] == '/usr/bin/codesign':
            assert argv[-1] == APP and 'anchor apple generic' in argv[-2]
            return types.SimpleNamespace(returncode=1 if fault == 'signature' else 0, stdout=b'')
        if argv == [paths['node'], '-p', 'process.arch']:
            assert paths['node'] in checked
            return types.SimpleNamespace(returncode=0, stdout=b'x64' if fault == 'rosetta' else b'arm64')
        name = argv[0]
        assert argv[1:] == ['--version']
        if name in ('node', 'git', 'hc'): assert os.path.realpath(paths[name]) in checked
        versions = {'hc': 'hc ' + c['hc_version'], 'git': 'git version 2.49.0', 'node': 'v24.0.0', 'pnpm': '11.7.0'}
        if fault == 'version': versions['hc'] = 'hc 0.0.0'
        return types.SimpleNamespace(returncode=0, stdout=versions[name].encode())
    subprocess.run = run
elif c['step'] == 'resources':
    label = c['launchd']['label']
    path = '/Library/LaunchDaemons/' + label + '.plist'
    entry(path, owner=0, group=0, mode=0o644, regular=True)
    native['acl_safe'] = lambda fd: False if fault == 'plist-acl' else not attributes(fd)
    os.listxattr = forbidden
    if fault == 'plist-owner': facts[path].st_uid = c['uid']
    plist = dict(Label=label, ProgramArguments=[CORE, 'serve'], UserName=c['user'],
                 WorkingDirectory=c['home'], EnvironmentVariables=dict(PATH=c['path'], HOME=c['home']),
                 RunAtLoad=True, KeepAlive=True, InitGroups=False, ProcessType='Background')
    for key in ('ProgramArguments', 'UserName', 'WorkingDirectory', 'EnvironmentVariables', 'InitGroups', 'KeepAlive'):
        if fault == key: plist[key] = None
    builtins.open = lambda filename, *args, **kwargs: io.BytesIO(plistlib.dumps(plist))
    # plistlib cannot serialize None; represent missing/mismatched fields instead.
    plist = {key: value for key, value in plist.items() if value is not None}
    loaded = '\n'.join([
        'system/' + label + ' = {', '\tpath = ' + path, '\tprogram = ' + CORE,
        '\tstate = running', '\tusername = ' + c['user'], '\tworking directory = ' + c['home'],
        '\targuments = {', '\t\t' + CORE, '\t\tserve', '\t}',
        '\tenvironment = {', '\t\tPATH => ' + c['path'], '\t\tHOME => ' + c['home'], '\t}',
        '\tpid = 123', '}',
    ])
    if fault == 'loaded-path': loaded = loaded.replace('\tpath = ' + path, '\tpath = /other.plist')
    if fault == 'loaded-user': loaded = loaded.replace('\tusername = ' + c['user'], '\tusername = root')
    if fault == 'loaded-args': loaded = loaded.replace('\t\tserve', '\t\tserver start')
    if fault == 'loaded-env': loaded = loaded.replace('\t\tPATH => ' + c['path'], '\t\tPATH => /usr/bin')
    if fault == 'loaded-cwd': loaded = loaded.replace('\tworking directory = ' + c['home'], '\tworking directory = /')

    def run(argv, **kwargs):
        assert argv == ['/bin/launchctl', 'print', 'system/' + label]
        return types.SimpleNamespace(returncode=1 if fault == 'unloaded' else 0, stdout=loaded.encode())
    subprocess.run = run
    os.getpgid = lambda _: 123
    calls = 0

    def identity(*args):
        global calls
        calls += 1
        if fault == 'unknown-pid': return None
        return dict(uid=0 if fault == 'root-pid' else c['uid'], start=str(calls) if fault == 'reused-pid' else '1:2')
    native['identity'] = identity
    process_path = lambda _: '/other/hc' if fault == 'wrong-executable' else CORE
elif c['step'] == 'mcp':
    class Endpoint:
        def open(self, request, timeout):
            assert request.full_url == c['mcp_url'] and not request.has_header('Authorization')
            raise urllib.error.HTTPError(request.full_url, 401 if fault == 'safe' else 403, 'SECRET', {}, None)
    urllib.request.build_opener = lambda *args: Endpoint()
