// For the SNMP "All data" view: group names by OID prefix (standard groups
// and the big vendors' enterprise numbers), and a few common objects as a
// fallback. Names normally come from the server's MIB library.

const cols = (base, names) => Object.fromEntries(names.map((n, i) => (n ? [`${base}.${i + 1}`, n] : null)).filter(Boolean));

const OBJECTS = {
  ...cols('1.3.6.1.2.1.1', ['sysDescr', 'sysObjectID', 'sysUpTime', 'sysContact', 'sysName', 'sysLocation', 'sysServices', 'sysORLastChange']),
  '1.3.6.1.2.1.2.1': 'ifNumber',
  ...cols('1.3.6.1.2.1.2.2.1', ['ifIndex', 'ifDescr', 'ifType', 'ifMtu', 'ifSpeed', 'ifPhysAddress', 'ifAdminStatus', 'ifOperStatus', 'ifLastChange',
    'ifInOctets', 'ifInUcastPkts', 'ifInNUcastPkts', 'ifInDiscards', 'ifInErrors', 'ifInUnknownProtos', 'ifOutOctets', 'ifOutUcastPkts',
    'ifOutNUcastPkts', 'ifOutDiscards', 'ifOutErrors', 'ifOutQLen', 'ifSpecific']),
  ...cols('1.3.6.1.2.1.4.20.1', ['ipAdEntAddr', 'ipAdEntIfIndex', 'ipAdEntNetMask', 'ipAdEntBcastAddr', 'ipAdEntReasmMaxSize']),
  '1.3.6.1.2.1.4.1': 'ipForwarding',
  '1.3.6.1.2.1.4.2': 'ipDefaultTTL',
  ...cols('1.3.6.1.2.1.31.1.1.1', ['ifName', 'ifInMulticastPkts', 'ifInBroadcastPkts', 'ifOutMulticastPkts', 'ifOutBroadcastPkts', 'ifHCInOctets',
    'ifHCInUcastPkts', 'ifHCInMulticastPkts', 'ifHCInBroadcastPkts', 'ifHCOutOctets', 'ifHCOutUcastPkts', 'ifHCOutMulticastPkts',
    'ifHCOutBroadcastPkts', 'ifLinkUpDownTrapEnable', 'ifHighSpeed', 'ifPromiscuousMode', 'ifConnectorPresent', 'ifAlias', 'ifCounterDiscontinuityTime']),
  ...cols('1.3.6.1.2.1.25.1', ['hrSystemUptime', 'hrSystemDate', 'hrSystemInitialLoadDevice', 'hrSystemInitialLoadParameters', 'hrSystemNumUsers', 'hrSystemProcesses', 'hrSystemMaxProcesses']),
  '1.3.6.1.2.1.25.2.2': 'hrMemorySize',
  ...cols('1.3.6.1.2.1.25.2.3.1', ['hrStorageIndex', 'hrStorageType', 'hrStorageDescr', 'hrStorageAllocationUnits', 'hrStorageSize', 'hrStorageUsed', 'hrStorageAllocationFailures']),
  ...cols('1.3.6.1.2.1.25.3.2.1', ['hrDeviceIndex', 'hrDeviceType', 'hrDeviceDescr', 'hrDeviceID', 'hrDeviceStatus', 'hrDeviceErrors']),
  ...cols('1.3.6.1.2.1.25.3.3.1', ['hrProcessorFrwID', 'hrProcessorLoad']),
  ...cols('1.3.6.1.2.1.25.4.2.1', ['hrSWRunIndex', 'hrSWRunName', 'hrSWRunID', 'hrSWRunPath', 'hrSWRunParameters', 'hrSWRunType', 'hrSWRunStatus']),
  ...cols('1.3.6.1.2.1.25.5.1.1', ['hrSWRunPerfCPU', 'hrSWRunPerfMem']),
  ...cols('1.3.6.1.2.1.25.6.3.1', ['hrSWInstalledIndex', 'hrSWInstalledName', 'hrSWInstalledID', 'hrSWInstalledType', 'hrSWInstalledDate']),
  ...cols('1.3.6.1.2.1.47.1.1.1.1', [null, 'entPhysicalDescr', 'entPhysicalVendorType', 'entPhysicalContainedIn', 'entPhysicalClass', 'entPhysicalParentRelPos',
    'entPhysicalName', 'entPhysicalHardwareRev', 'entPhysicalFirmwareRev', 'entPhysicalSoftwareRev', 'entPhysicalSerialNum', 'entPhysicalMfgName', 'entPhysicalModelName']),
  ...cols('1.0.8802.1.1.2.1.4.1.1', [null, null, null, 'lldpRemChassisIdSubtype', 'lldpRemChassisId', 'lldpRemPortIdSubtype', 'lldpRemPortId', 'lldpRemPortDesc', 'lldpRemSysName', 'lldpRemSysDesc']),
  ...cols('1.3.6.1.4.1.2021.4', [null, null, 'memTotalSwap', 'memAvailSwap', 'memTotalReal', 'memAvailReal', null, null, null, null, 'memTotalFree', 'memMinimumSwap', 'memShared', 'memBuffer', 'memCached']),
  ...cols('1.3.6.1.4.1.2021.9.1', [null, 'dskPath', 'dskDevice', null, null, 'dskTotal', 'dskAvail', 'dskUsed', 'dskPercent']),
  ...cols('1.3.6.1.4.1.2021.10.1', ['laIndex', 'laNames', 'laLoad', 'laConfig', 'laLoadInt']),
  '1.3.6.1.4.1.2021.11.9': 'ssCpuUser',
  '1.3.6.1.4.1.2021.11.10': 'ssCpuSystem',
  '1.3.6.1.4.1.2021.11.11': 'ssCpuIdle',
};

const GROUPS = [
  ['1.3.6.1.2.1.1', 'System'],
  ['1.3.6.1.2.1.2', 'Interfaces'],
  ['1.3.6.1.2.1.3', 'Address translation'],
  ['1.3.6.1.2.1.4', 'IP'],
  ['1.3.6.1.2.1.5', 'ICMP'],
  ['1.3.6.1.2.1.6', 'TCP'],
  ['1.3.6.1.2.1.7', 'UDP'],
  ['1.3.6.1.2.1.10', 'Transmission'],
  ['1.3.6.1.2.1.11', 'SNMP'],
  ['1.3.6.1.2.1.17', 'Bridge (MAC table, STP)'],
  ['1.3.6.1.2.1.25', 'Host resources'],
  ['1.3.6.1.2.1.31', 'Interfaces (extended)'],
  ['1.3.6.1.2.1.47', 'Entity (hardware)'],
  ['1.3.6.1.2.1.55', 'IPv6'],
  ['1.3.6.1.2.1.92', 'Notification log'],
  ['1.3.6.1.2.1.105', 'Power over Ethernet'],
  ['1.3.6.1.2.1', 'MIB-2'],
  ['1.3.6.1.6.3', 'SNMP framework'],
  ['1.0.8802.1.1.2', 'LLDP (neighbours)'],
  ['1.3.6.1.4.1.9', 'Cisco'],
  ['1.3.6.1.4.1.11', 'HP / Aruba'],
  ['1.3.6.1.4.1.14823', 'Aruba'],
  ['1.3.6.1.4.1.25506', 'H3C / HPE Comware'],
  ['1.3.6.1.4.1.2636', 'Juniper'],
  ['1.3.6.1.4.1.6527', 'Nokia'],
  ['1.3.6.1.4.1.674', 'Dell'],
  ['1.3.6.1.4.1.6876', 'VMware'],
  ['1.3.6.1.4.1.2011', 'Huawei'],
  ['1.3.6.1.4.1.4526', 'Netgear'],
  ['1.3.6.1.4.1.14988', 'MikroTik'],
  ['1.3.6.1.4.1.41112', 'Ubiquiti'],
  ['1.3.6.1.4.1.4413', 'Ubiquiti (EdgeSwitch)'],
  ['1.3.6.1.4.1.12356', 'Fortinet'],
  ['1.3.6.1.4.1.25461', 'Palo Alto'],
  ['1.3.6.1.4.1.12325', 'pfSense / OPNsense (BSD)'],
  ['1.3.6.1.4.1.6574', 'Synology'],
  ['1.3.6.1.4.1.24681', 'QNAP'],
  ['1.3.6.1.4.1.318', 'APC'],
  ['1.3.6.1.4.1.534', 'Eaton'],
  ['1.3.6.1.4.1.17713', 'Cambium'],
  ['1.3.6.1.4.1.311', 'Microsoft'],
  ['1.3.6.1.4.1.2021', 'net-snmp (UCD)'],
  ['1.3.6.1.4.1.8072', 'net-snmp'],
  ['1.3.6.1.4.1', 'Enterprise'],
].sort((a, b) => b[0].length - a[0].length); // longest prefix first

// "ifDescr.3" for 1.3.6.1.2.1.2.2.1.2.3: the longest known object, plus the
// rest of the OID (its index). null if nothing matches.
export function oidName(oid) {
  const arcs = oid.split('.');
  for (let n = arcs.length; n > 1; n--) {
    const name = OBJECTS[arcs.slice(0, n).join('.')];
    if (name) return n === arcs.length ? name : `${name}.${arcs.slice(n).join('.')}`;
  }
  return null;
}

export function oidGroup(oid) {
  return GROUPS.find(([p]) => oid === p || oid.startsWith(`${p}.`))?.[1] ?? 'Other';
}
