"""Synthetic directory records; no Mac, real accounts or dscl is contacted."""
def install_group_observations(native, account, fault, system='Darwin'):
    import grp
    import os
    import platform
    import plistlib
    import pwd
    from types import SimpleNamespace as R

    state = native['isolation_groups'].__globals__
    platform.system = lambda: system
    gid = account.pw_gid
    implicit = {'everyone': 12, 'localaccounts': 61, '_lpoperator': 100}
    identifiers = {name: f'ABCDEFAB-CDEF-ABCD-EFAB-CDEF{number:08X}' for name, number in implicit.items()}
    user_id = '12345678-1234-1234-1234-123456789ABC'
    records = {'/Users/' + account.pw_name: dict(RecordName=[account.pw_name, 'fixture_alias'],
               GeneratedUID=[user_id], UniqueID=[str(account.pw_uid)], PrimaryGroupID=[str(gid)])}
    groups = {gid: R(gr_name=account.pw_name, gr_gid=gid, gr_mem=[])}
    for name, number in implicit.items():
        groups[number] = R(gr_name=name, gr_gid=number, gr_mem=[])
        records['/Groups/' + name] = dict(RecordName=[name], PrimaryGroupID=[str(number)],
                                        GeneratedUID=[identifiers[name]])
    # Stock implicit nesting: printing operators inherit everyone.
    records['/Groups/_lpoperator']['NestedGroups'] = [identifiers['everyone']]
    membership = [gid, 12, 61, 100] if system == 'Darwin' or fault == 'linux-implicit' else [gid]
    inherited = membership[:]
    if fault == 'primary-only': membership = inherited = [gid]
    if fault == 'empty-process': inherited = []
    if fault == 'missing-primary': membership.remove(gid)
    foreign = {'admin': 80, 'wheel': 0, 'staff': 20, 'ssh': 399, 'sharepoint': 701, 'project': 2202}
    if fault in foreign:
        membership.append(foreign[fault])
    if fault == 'process-admin': inherited.append(80)
    if fault == 'primary-staff': groups[gid].gr_name = 'staff'
    if fault == 'primary-sharepoint': groups[gid].gr_name = 'com.apple.sharepoint.group.1'
    if fault == 'process-implicit': membership = [gid]
    if fault == 'wrong-name': groups[12].gr_name = 'other'
    if fault == 'wrong-gid': groups[12].gr_gid = 999
    if fault == 'record-gid': records['/Groups/everyone']['PrimaryGroupID'] = ['999']
    if fault == 'record-name': records['/Groups/everyone']['RecordName'] = ['other']
    if fault == 'missing-guid': records['/Groups/everyone'].pop('GeneratedUID')
    if fault == 'duplicate-guid': records['/Groups/everyone']['GeneratedUID'] = [identifiers['localaccounts']]
    if fault == 'malformed-members': records['/Groups/everyone']['GroupMembership'] = account.pw_name
    if fault.startswith('explicit-') and ':' in fault:
        name, attribute = fault.removeprefix('explicit-').split(':')
        records['/Groups/' + name][attribute] = [account.pw_name if attribute == 'GroupMembership' else user_id.lower()]
    if fault == 'explicit-alias': records['/Groups/everyone']['GroupMembership'] = ['fixture_alias']
    if fault == 'explicit-gr-mem': groups[12].gr_mem = [account.pw_name]
    if fault == 'nested-project': records['/Groups/_lpoperator']['NestedGroups'] = ['PRIVATE-PROJECT-GROUP']

    pwd.getpwnam = pwd.getpwuid = lambda _: account
    pwd.getpwall = lambda: [account]
    grp.getgrgid = lambda number: groups[number]
    grp.getgrnam = lambda name: next(group for group in groups.values() if group.gr_name == name)
    os.getgrouplist = lambda *args: membership
    os.getgroups = lambda: inherited
    state['process_groups'] = lambda: inherited

    def directory_read(argv, timeout_ms):
        assert system == 'Darwin' and 0 < timeout_ms <= 15000
        assert argv[:4] == ['/usr/bin/dscl', '-plist', '.', '-read']
        if fault == 'dscl-unavailable': raise OSError('synthetic failure')
        if fault == 'dscl-malformed': return 'not a plist'
        value = records[argv[4]]
        return plistlib.dumps({'dsAttrTypeStandard:' + key: value[key] for key in argv[5:] if key in value}).decode()
    state['run'] = directory_read
    return inherited
