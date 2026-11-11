import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMib, splitModules, buildLibrary, MibLibrary, bundledModules, formatValue, octetHint, mibLibrary } from '../src/mib.js';
import { snmpBrowse, checkSnmp, cardText } from '../src/checkers/snmp.js';
import { createApi } from '../src/api.js';
import { Store } from '../src/db.js';
import { Engine } from '../src/engine.js';
import { mib, agent } from './fake-snmp.js';
import { compareOids } from '../src/snmp.js';

// A made-up vendor, split over two modules like real vendor MIBs, with the
// usual untidiness: dashed comment lines, a TC with a display hint, units,
// enumerations, a MAC, and a table.
const ACME_SMI = `
-------------------------------------------------- ACME root --------
ACME-SMI DEFINITIONS ::= BEGIN
IMPORTS MODULE-IDENTITY, enterprises FROM SNMPv2-SMI;
acme MODULE-IDENTITY
    LAST-UPDATED "202401010000Z"
    ORGANIZATION "Acme"
    CONTACT-INFO "nobody"
    DESCRIPTION "The Acme root."
    ::= { enterprises 99 }
acmeProducts OBJECT IDENTIFIER ::= { acme 1 }
END
`;

const ACME_SENSOR = `
ACME-SENSOR-MIB DEFINITIONS ::= BEGIN
IMPORTS
    OBJECT-TYPE, Integer32, Gauge32       FROM SNMPv2-SMI
    TEXTUAL-CONVENTION, DisplayString,
    MacAddress                            FROM SNMPv2-TC
    acme                                  FROM ACME-SMI;

-- -- odd comment -- with dashes inside
TenthsCelsius ::= TEXTUAL-CONVENTION
    DISPLAY-HINT "d-1"
    STATUS current
    DESCRIPTION "Tenths of a degree."
    SYNTAX Integer32 (-1000..2000)

acmeSensors OBJECT IDENTIFIER ::= { acme 2 }

acmeTemp OBJECT-TYPE
    SYNTAX TenthsCelsius
    UNITS "degrees C"
    MAX-ACCESS read-only
    STATUS current
    DESCRIPTION
        "Inside temperature.

         Measured at the intake."
    ::= { acmeSensors 1 }

acmeFanTable OBJECT-TYPE
    SYNTAX SEQUENCE OF AcmeFanEntry
    MAX-ACCESS not-accessible
    STATUS current
    DESCRIPTION "Fans."
    ::= { acmeSensors 2 }

acmeFanEntry OBJECT-TYPE
    SYNTAX AcmeFanEntry
    MAX-ACCESS not-accessible
    STATUS current
    DESCRIPTION "A fan."
    INDEX { acmeFanIndex }
    ::= { acmeFanTable 1 }

AcmeFanEntry ::= SEQUENCE { acmeFanIndex Integer32, acmeFanState INTEGER, acmeFanSpeed Gauge32, acmeFanMac MacAddress }

acmeFanIndex OBJECT-TYPE SYNTAX Integer32 (1..16) MAX-ACCESS not-accessible STATUS current DESCRIPTION "Index." ::= { acmeFanEntry 1 }
acmeFanState OBJECT-TYPE
    SYNTAX INTEGER { ok(1), failed(2), absent(3) }
    MAX-ACCESS read-only
    STATUS current
    DESCRIPTION "State."
    DEFVAL { ok }
    ::= { acmeFanEntry 2 }
acmeFanSpeed OBJECT-TYPE SYNTAX Gauge32 UNITS "rpm" MAX-ACCESS read-only STATUS current DESCRIPTION "Speed." ::= { acmeFanEntry 3 }
acmeFanMac OBJECT-TYPE SYNTAX MacAddress MAX-ACCESS read-only STATUS current DESCRIPTION "MAC." ::= { acmeFanEntry 4 }
acmeName OBJECT-TYPE SYNTAX DisplayString MAX-ACCESS read-only STATUS current DESCRIPTION "Name." ::= { acmeProducts 9 }
END
`;

const libWith = (...texts) => {
  const lib = new MibLibrary();
  for (const mod of bundledModules()) lib.add(mod, 'bundled');
  for (const t of texts) for (const mod of parseMib(t)) lib.add(mod, 'uploaded');
  return lib.compile();
};

test('the bundled standard MIBs name standard objects, with their types', () => {
  const lib = mibLibrary();
  assert.ok(bundledModules().length > 50);
  assert.equal(lib.label('1.3.6.1.2.1.2.2.1.8.3').name, 'ifOperStatus.3');
  assert.equal(lib.label('1.3.6.1.2.1.1.3.0').name, 'sysUpTime.0', 'the object, not an alias node for its instance');
  assert.equal(lib.label('1.0.8802.1.1.2.1.4.1.1.9.0.3.1').name, 'lldpRemSysName.0.3.1');
  assert.equal(lib.label('1.3.6.1.2.1.31.1.1.1.6.1').entry.syntax.base, 'Counter64');
  assert.equal(formatValue(lib.label('1.3.6.1.2.1.2.2.1.8.3').entry, { type: 'integer', value: 2 }).text, 'down');
  assert.equal(formatValue(lib.label('1.3.6.1.2.1.2.2.1.3.1').entry, { type: 'integer', value: 6 }).text, 'ethernetCsmacd', 'IANAifType enumerations');
  assert.equal(formatValue(lib.label('1.3.6.1.2.1.2.2.1.6.1').entry, { type: 'octets', value: Buffer.from([0, 0x1a, 0x2b, 0x3c, 0x4d, 5]) }).text, '00:1a:2b:3c:4d:05');
  assert.equal(formatValue(null, { type: 'oid', value: '1.3.6.1.2.1.25.2.1.2' }).text, 'hrStorageRam');
  assert.equal(formatValue(null, { type: 'timeticks', value: 9000000 }).text, '1d 1h 0m');
  // vendor subtrees have no name, only a place to look
  assert.equal(lib.label('1.3.6.1.4.1.99.1.0'), null);
  assert.deepEqual(lib.near('1.3.6.1.4.1.99.1.0'), { oid: '1.3.6.1.4.1.99', under: 'enterprises' });
});

test('a vendor MIB: imports, textual conventions, units, enumerations, tables', () => {
  const lib = libWith(ACME_SMI, ACME_SENSOR);
  const temp = lib.label('1.3.6.1.4.1.99.2.1.0');
  assert.equal(temp.name, 'acmeTemp.0');
  assert.equal(temp.entry.module, 'ACME-SENSOR-MIB');
  assert.equal(temp.entry.desc, 'Inside temperature.\n\nMeasured at the intake.');
  assert.deepEqual(formatValue(temp.entry, { type: 'integer', value: 415 }), { text: '41.5 degrees C', raw: '415' });
  assert.equal(lib.label('1.3.6.1.4.1.99.2.2').entry.kind, 'table');
  assert.equal(lib.label('1.3.6.1.4.1.99.2.2.1').entry.kind, 'row');
  assert.deepEqual(formatValue(lib.label('1.3.6.1.4.1.99.2.2.1.2.4').entry, { type: 'integer', value: 2 }), { text: 'failed', raw: '2' });
  assert.equal(formatValue(lib.label('1.3.6.1.4.1.99.2.2.1.3.4').entry, { type: 'gauge32', value: 5400 }).text, '5400 rpm');
  assert.equal(formatValue(lib.label('1.3.6.1.4.1.99.2.2.1.4.4').entry, { type: 'octets', value: Buffer.from([1, 2, 3, 4, 5, 255]) }).text, '01:02:03:04:05:ff');
  assert.equal(lib.label('1.3.6.1.4.1.99.1.9.0').name, 'acmeName.0');
  assert.deepEqual(lib.near('1.3.6.1.4.1.99.7.1.0'), { oid: '1.3.6.1.4.1.99.7', under: 'acme' });
  const stats = lib.list().find((m) => m.name === 'ACME-SENSOR-MIB');
  assert.deepEqual(stats.missing, []);
  assert.equal(stats.unresolved, 0);
});

test('a MIB without what it imports says what is missing', () => {
  const lib = libWith(ACME_SENSOR);
  const stats = lib.list().find((m) => m.name === 'ACME-SENSOR-MIB');
  assert.deepEqual(stats.missing, ['ACME-SMI']);
  assert.ok(stats.unresolved > 0);
  assert.equal(lib.label('1.3.6.1.4.1.99.2.1.0'), null);
});

test('display hints for octet strings', () => {
  assert.equal(octetHint('1x:', Buffer.from([0xa, 0xb, 0xc])), '0a:0b:0c');
  assert.equal(octetHint('1d.1d.1d.1d', Buffer.from([192, 168, 1, 20])), '192.168.1.20');
  assert.equal(octetHint('255a', Buffer.from('hello')), 'hello');
  assert.equal(octetHint('2d-1d-1d,1d:1d:1d.1d,1a1d:1d', Buffer.from([0x07, 0xe8, 3, 5, 14, 3, 7, 0, 0x2b, 1, 0])), '2024-3-5,14:3:7.0,+1:0');
  assert.equal(octetHint('*1x:/1x:', Buffer.from([2, 0xaa, 0xbb, 0xcc])), 'aa:bb/cc', 'repeat count and terminator');
  const lib = mibLibrary();
  const date = lib.label('1.3.6.1.2.1.25.1.2.0').entry;
  assert.equal(formatValue(date, { type: 'octets', value: Buffer.from([0x07, 0xe8, 3, 5, 14, 3, 7, 0, 0x2b, 1, 0]) }).text, '2024-03-05 14:03:07 +01:00');
});

test('files with several modules are split; garbage is refused', () => {
  const both = splitModules(ACME_SMI + ACME_SENSOR);
  assert.deepEqual([...both.keys()], ['ACME-SMI', 'ACME-SENSOR-MIB']);
  assert.ok(both.get('ACME-SMI').trim().endsWith('END'));
  assert.throws(() => parseMib('just some text'), /No MIB module/);
});

test('uploading MIBs names the values in All data and on the card', async () => {
  const store = new Store(':memory:');
  const engine = new Engine({ store, checkers: {}, notify: async () => [], schedule: () => null, cancel: () => {} });
  const icons = { describe: () => null, sync: () => {}, hasUpload: () => false, saveUpload: () => {} };
  const handle = createApi({ store, engine, icons });
  const call = (method, path, body) => handle({ method }, new URL(`http://x${path}`), body);
  const values = [...mib(), { oid: '1.3.6.1.4.1.99.2.1.0', type: 'integer', value: 415 }].sort((a, b) => compareOids(a.oid, b.oid));
  const a = await agent({ values });
  try {
    const m = { id: 1, name: 'Switch', type: 'snmp', timeout: 2, config: { host: '127.0.0.1', port: a.port, oids: 'Temp = 1.3.6.1.4.1.99.2.1.0', card: ['value:1.3.6.1.4.1.99.2.1.0'] } };
    let page = await snmpBrowse(m);
    let e = page.entries.find((x) => x.oid === '1.3.6.1.4.1.99.2.1.0');
    assert.equal(e.name, undefined);
    assert.deepEqual(e.near, { oid: '1.3.6.1.4.1.99', under: 'enterprises' });
    const descr = page.entries.find((x) => x.oid === '1.3.6.1.2.1.2.2.1.8.2');
    assert.equal(descr.name, 'ifOperStatus.2');
    assert.equal(descr.text, 'down');
    assert.equal(page.objects[descr.obj].module, 'IF-MIB');
    assert.equal(cardText((await checkSnmp(m)).data, m.config), 'Temp 415');

    // one file missing its import, then the import
    let r = await call('POST', '/api/mibs', { files: [{ filename: 'acme-sensor.mib', text: ACME_SENSOR }, { filename: 'notes.txt', text: 'hello' }] });
    assert.deepEqual(r.added.map((x) => x.name), ['ACME-SENSOR-MIB']);
    assert.match(r.errors[0].error, /No MIB module/);
    assert.deepEqual(r.modules.find((x) => x.name === 'ACME-SENSOR-MIB').missing, ['ACME-SMI']);
    r = await call('POST', '/api/mibs', { files: [{ filename: 'acme-smi.mib', text: ACME_SMI }] });
    assert.deepEqual(r.modules.find((x) => x.name === 'ACME-SENSOR-MIB').missing, []);
    assert.equal(r.modules.find((x) => x.name === 'ACME-SMI').source, 'uploaded');

    page = await snmpBrowse(m);
    e = page.entries.find((x) => x.oid === '1.3.6.1.4.1.99.2.1.0');
    assert.equal(e.name, 'acmeTemp.0');
    assert.equal(e.text, '41.5 degrees C');
    assert.equal(page.objects[e.obj].units, 'degrees C');
    assert.equal(cardText((await checkSnmp(m)).data, m.config), 'Temp 41.5 degrees C');

    // stored: a fresh API over the same store has them
    createApi({ store, engine, icons });
    assert.equal(mibLibrary().label('1.3.6.1.4.1.99.2.1.0').name, 'acmeTemp.0');

    await call('DELETE', '/api/mibs/ACME-SMI');
    await assert.rejects(call('DELETE', '/api/mibs/IF-MIB'), /No uploaded MIB/);
    assert.equal(mibLibrary().label('1.3.6.1.4.1.99.2.1.0'), null);
  } finally {
    a.close();
    store.close();
    // leave the bundled-only library for other tests
    createApi({ store: new Store(':memory:'), engine, icons });
  }
});

test('a library is rebuilt from what the store holds', () => {
  const lib = buildLibrary([{ name: 'ACME-SMI', filename: 'a.mib', text: ACME_SMI, addedAt: 1 }]);
  const acme = lib.list().find((m) => m.name === 'ACME-SMI');
  assert.equal(acme.filename, 'a.mib');
  assert.equal(lib.label('1.3.6.1.4.1.99.1').name, 'acmeProducts');
});
