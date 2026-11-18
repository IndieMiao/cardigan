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
    for key, number in foreign.items():
        name = {'ssh': 'com.apple.access_ssh', 'sharepoint': 'com.apple.sharepoint.group.1'}.get(key, key)
        groups[number] = R(gr_name=name, gr_gid=number, gr_mem=[account.pw_name])
        records['/Groups/' + name] = dict(RecordName=[name], PrimaryGroupID=[str(number)],
            GeneratedUID=[f'ABCDEFAB-CDEF-ABCD-EFAB-CDEF{number:08X}'], GroupMembership=[account.pw_name])
    if fault in foreign:
        membership.append(foreign[fault])
    if fault.endswith('-via-everyone'):
        number = foreign[fault.removesuffix('-via-everyone')]
        membership.append(number)
        groups[number].gr_mem = []
        records['/Groups/' + groups[number].gr_name] = dict(RecordName=[groups[number].gr_name],
            PrimaryGroupID=[str(number)], GeneratedUID=['00000000-0000-0000-0000-000000000001'],
            NestedGroups=[identifiers['everyone']])
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
    if fault == 'explicit-case': records['/Groups/everyone']['GroupMembership'] = [account.pw_name.upper()]
    if fault == 'explicit-gr-mem': groups[12].gr_mem = [account.pw_name]
    if fault == 'nested-project': records['/Groups/_lpoperator']['NestedGroups'] = ['PRIVATE-PROJECT-GROUP']
    if fault == 'root-cycle': records['/Groups/everyone']['NestedGroups'] = [identifiers['everyone']]

    uuids = {name: value for name, value in identifiers.items()}
    uuids.update({path.removeprefix('/Groups/'): data['GeneratedUID'][0]
                  for path, data in records.items() if path.startswith('/Groups/')
                  and path.removeprefix('/Groups/') not in identifiers})
    if fault.startswith('share-') or fault == 'linux-share':
        number, name = 701, 'com.apple.sharepoint.group.1'
        if fault == 'share-other-number': number, name = 880, 'com.apple.sharepoint.group.42'
        if fault == 'share-bad-name': name = 'com.apple.sharepoint.group.1.extra'
        if fault == 'share-unicode-number': name = 'com.apple.sharepoint.group.１'
        shared_id = '87654321-4321-4321-4321-ABCDEF123456'
        groups[number] = R(gr_name=name, gr_gid=number, gr_mem=[])
        shared = dict(RecordName=[name], PrimaryGroupID=[str(number)], GeneratedUID=[shared_id],
                      NestedGroups=[identifiers['everyone']])
        records['/Groups/' + name] = shared
        uuids[name] = shared_id
        if fault != 'share-process-only': membership.append(number)
        inherited.append(number)
        if fault == 'share-localaccounts': shared['NestedGroups'] = [identifiers['localaccounts'].lower()]
        if fault == 'share-both': shared['NestedGroups'].append(identifiers['localaccounts'])
        if fault == 'share-direct-name': shared['GroupMembership'] = [account.pw_name]
        if fault == 'share-direct-alias': shared['GroupMembership'] = ['FIXTURE_ALIAS']
        if fault == 'share-direct-uuid': shared['GroupMembers'] = [user_id.lower()]
        if fault == 'share-direct-gr-mem': groups[number].gr_mem = [account.pw_name]
        if fault == 'share-nested-user': shared['NestedGroups'] = [user_id]
        if fault == 'share-mixed': shared['NestedGroups'].append('00000000-0000-0000-0000-000000000001')
        if fault == 'share-unknown': shared['NestedGroups'] = ['00000000-0000-0000-0000-000000000001']
        if fault == 'share-recursive': shared['NestedGroups'] = [identifiers['_lpoperator']]
        if fault == 'share-cycle': shared['NestedGroups'] = [shared_id]
        if fault == 'share-empty': shared['NestedGroups'] = []
        if fault == 'share-missing-nesting': shared.pop('NestedGroups')
        if fault == 'share-record-name': shared['RecordName'] = ['other']
        if fault == 'share-record-gid': shared['PrimaryGroupID'] = ['702']
        if fault == 'share-name-gid': groups[number].gr_gid = 702
        if fault == 'share-missing-uuid': shared.pop('GeneratedUID')
        if fault == 'share-malformed-uuid': shared['GeneratedUID'] = ['invalid']
        if fault == 'share-uuid-mismatch': uuids[name] = '00000000-0000-0000-0000-000000000001'
        if fault == 'share-duplicate-uuid': shared['GeneratedUID'] = [identifiers['everyone']]; uuids[name] = identifiers['everyone']
        if fault == 'share-malformed-nesting': shared['NestedGroups'] = identifiers['everyone']

    pwd.getpwnam = pwd.getpwuid = lambda _: account
    pwd.getpwall = lambda: [account]
    grp.getgrgid = lambda number: groups[number]
    grp.getgrnam = lambda name: next(group for group in groups.values() if group.gr_name == name)
    os.getgrouplist = lambda *args: membership
    os.getgroups = lambda: inherited
    state['process_groups'] = lambda: inherited

    def directory_read(argv, timeout_ms):
        assert system == 'Darwin' and 0 < timeout_ms <= 15000
        if argv[:3] == ['/usr/bin/dsmemberutil', 'getuuid', '-G']:
            if fault == 'uuid-unavailable': raise OSError('synthetic UUID lookup failure')
            if fault == 'uuid-mismatch': return user_id
            return uuids[argv[3]]
        assert argv[:4] == ['/usr/bin/dscl', '-plist', '.', '-read']
        if fault == 'dscl-unavailable': raise OSError('synthetic failure')
        if fault == 'dscl-malformed': return 'not a plist'
        value = records[argv[4]]
        if argv[4].startswith('/Users/'):
            assert argv[5:] == ['RecordName', 'GeneratedUID', 'UniqueID', 'PrimaryGroupID']
            keys = argv[5:]
        else:
            assert len(argv) == 5, 'optional missing attributes must not be requested individually'
            keys = value.keys()
        return plistlib.dumps({'dsAttrTypeStandard:' + key: value[key] for key in keys if key in value}).decode()
    state['run'] = directory_read
    return inherited
