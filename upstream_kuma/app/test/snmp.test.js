import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMessage, decodeMessage, PDU, SnmpClient } from '../src/snmp.js';
import { mib, agent } from './fake-snmp.js';
import { checkSnmp, addRates, parseExtraOids, cardText } from '../src/checkers/snmp.js';
import { createApi } from '../src/api.js';
import { Store } from '../src/db.js';
import { Engine } from '../src/engine.js';

const monitor = (port, config = {}) => ({ id: 1, name: 'Switch', type: 'snmp', timeout: 2, config: { host: '127.0.0.1', port, ...config } });

test('messages survive a round trip, including big and negative numbers', () => {
  const vbs = [
    { oid: '1.3.6.1.2.1.1.3.0', type: 'timeticks', value: 4294967295 },
    { oid: '1.3.6.1.2.1.31.1.1.1.6.1', type: 'counter64', value: 2 ** 52 + 3 },
    { oid: '1.3.6.1.4.1.311.1', type: 'integer', value: -129 },
    { oid: '1.3.6.1.4.1.99999.128.16384', type: 'oid', value: '1.3.6.1.4.1.9.1.1208' },
    { oid: '1.3.6.1.2.1.4.20.1.1.10.0.0.1', type: 'ip', value: '10.0.0.1' },
    { oid: '1.3.6.1.2.1.1.9.0', type: 'noSuchObject' },
  ];
  const back = decodeMessage(encodeMessage({ version: '1', community: 'secret', pdu: { type: PDU.RESPONSE, id: 7, a: 0, b: 0, varbinds: vbs } }));
  assert.equal(back.version, '1');
  assert.equal(back.community, 'secret');
  assert.equal(back.pdu.id, 7);
  assert.deepEqual(back.pdu.varbinds.map((v) => [v.oid, v.type, v.value]), vbs.map((v) => [v.oid, v.type, v.value ?? null]));
});

test('an SNMP monitor is up and collects the system, interfaces and resources', async () => {
  const a = await agent();
  try {
    const res = await checkSnmp(monitor(a.port, { oids: 'Temperature = 1.3.6.1.4.1.99.1.0\nMissing = .1.3.6.1.4.1.99.2.0' }));
    assert.equal(res.ok, true);
    assert.equal(res.msg, 'core-sw · 1/2 links up');
    const d = res.data;
    assert.deepEqual(d.system, { descr: 'Test switch v1.2', objectId: '1.3.6.1.4.1.9.1.1', uptime: 1235, contact: 'Network team', name: 'core-sw', location: 'Server room' });
    assert.deepEqual(d.interfaces.map((i) => [i.index, i.name, i.alias, i.kind, i.oper, i.speed, i.hc]), [
      [1, 'Gi1/0/1', 'Uplink', 'Ethernet', 'up', 1e9, true],
      [2, 'Gi1/0/2', '', 'Ethernet', 'down', 1e9, true],
      [3, 'lo', '', 'Loopback', 'up', 1e7, false],
    ]);
    assert.equal(d.interfaces[0].mac, '00:1a:2b:3c:4d:01');
    assert.equal(d.interfaces[0].inOctets, 5e9); // 64-bit counters win
    assert.equal(d.interfaces[2].inOctets, 3000);
    assert.equal(d.interfaces[1].inErrors, 7);
    assert.equal(d.interfaces[0].inBps, null); // no previous sample yet
    assert.deepEqual(d.cpu, { cores: 2, load: 20 });
    assert.deepEqual(d.storage, [
      { kind: 'memory', name: 'Physical memory', size: 1024000, used: 256000 },
      { kind: 'disk', name: '/', size: 4096000, used: 2048000 },
    ]);
    assert.deepEqual(d.custom.map((c) => [c.label, c.value]), [['Temperature', 42], ['Missing', null]]);
    assert.deepEqual(d.notes, []);
  } finally {
    a.close();
  }
});

test('traffic rates come from the previous sample', async () => {
  const a = await agent();
  try {
    const first = (await checkSnmp(monitor(a.port))).data;
    // 10 seconds later, port 1 has received 125 MB more: 100 Mbit/s.
    first.at -= 10000;
    first.system.uptime -= 10;
    a.values.find((v) => v.oid === '1.3.6.1.2.1.31.1.1.1.6.1').value += 125_000_000;
    const second = (await checkSnmp(monitor(a.port), { previous: first })).data;
    const rate = second.interfaces[0].inBps;
    assert.ok(Math.abs(rate - 1e8) / 1e8 < 0.02, `about 100 Mbit/s, got ${rate}`);
    assert.equal(second.interfaces[0].outBps, 0);
  } finally {
    a.close();
  }

  // A 32-bit counter that went backwards wrapped around; a reboot resets all.
  const ifs = [{ index: 3, hc: false, inOctets: 100, outOctets: 50 }];
  addRates(ifs, { at: 0, system: { uptime: 5 }, interfaces: [{ index: 3, hc: false, inOctets: 2 ** 32 - 900, outOctets: 50 }] }, 1000, 6);
  assert.deepEqual([ifs[0].inBps, ifs[0].outBps], [8000, 0]);
  const rebooted = [{ index: 3, hc: false, inOctets: 100, outOctets: 50, inBps: null }];
  addRates(rebooted, { at: 0, system: { uptime: 500 }, interfaces: [{ index: 3, hc: false, inOctets: 50, outOctets: 0 }] }, 1000, 6);
  assert.equal(rebooted[0].inBps, null);
});

test('v1 agents: walks with GETNEXT, a missing OID does not sink the GET', async () => {
  const a = await agent({ version: '1' });
  try {
    const res = await checkSnmp(monitor(a.port, { version: '1', oids: 'Temperature = 1.3.6.1.4.1.99.1.0\nMissing = 1.3.6.1.4.1.99.2.0' }));
    assert.equal(res.ok, true);
    assert.equal(res.data.interfaces.length, 3);
    assert.deepEqual(res.data.custom.map((c) => c.value), [42, null]);
    assert.equal(a.stats.bulk, 0);
    assert.ok(a.stats.next > 30);
  } finally {
    a.close();
  }
});

test('a tooBig reply makes the walk ask for less', async () => {
  const a = await agent({ tooBigAbove: 4 });
  try {
    const client = new SnmpClient({ host: '127.0.0.1', port: a.port, timeout: 1000 });
    const rows = await client.walk('1.3.6.1.2.1.2.2.1.2');
    client.close();
    assert.deepEqual(rows.map((r) => r.value.toString()), ['GigabitEthernet1/0/1', 'GigabitEthernet1/0/2', 'lo']);
  } finally {
    a.close();
  }
});

test('the wrong community gets no reply, which is down', async () => {
  const a = await agent({ community: 'private' });
  try {
    const t = Date.now();
    await assert.rejects(checkSnmp({ ...monitor(a.port), timeout: 1 }), /No SNMP reply from 127\.0\.0\.1:\d+ \(check the address, version and community\)/);
    assert.ok(Date.now() - t < 2000);
    assert.equal(a.stats.requests, 2); // one retry
  } finally {
    a.close();
  }
});

test('extra OIDs: "Label = OID" lines, or a bare OID', () => {
  assert.deepEqual(parseExtraOids('Temp = 1.3.6.1.4.1.1.0; .1.3.6.1.2.1.1.5.0\n\n'), [
    { label: 'Temp', oid: '1.3.6.1.4.1.1.0' },
    { label: '1.3.6.1.2.1.1.5.0', oid: '1.3.6.1.2.1.1.5.0' },
  ]);
  assert.throws(() => parseExtraOids('Temp = sysName.0'), /is not "Label = OID"/);
});

test('the engine keeps what a check collected and hands it to the next check', async () => {
  const store = new Store(':memory:');
  const seen = [];
  let n = 0;
  const engine = new Engine({
    store,
    checkers: {
      snmp: async (m, { previous }) => {
        seen.push(previous);
        n++;
        return n === 3 ? { ok: false, msg: 'No SNMP reply' } : { ok: true, ping: 1, msg: 'ok', data: { n } };
      },
    },
    notify: async () => [],
    schedule: () => null,
    cancel: () => {},
  });
  const id = store.createMonitor({ name: 'Switch', type: 'snmp', config: { host: 'x' }, interval: 60, retries: 0, retryInterval: 20, timeout: 5, resendInterval: 0, parentMode: 'all', active: true });
  engine.reload();
  await engine.idle();
  for (let i = 0; i < 3; i++) await engine.check(id);
  assert.deepEqual(seen, [null, { n: 1 }, { n: 2 }]);
  assert.deepEqual(store.getMonitorData(id).data, { n: 2 }); // a failed check keeps the last data
  store.deleteMonitor(id);
  assert.equal(store.getMonitorData(id), null);
});

test('the Falls card shows the picked values, and hidden interfaces are not counted', async () => {
  const a = await agent();
  try {
    const config = { oids: 'Temperature = 1.3.6.1.4.1.99.1.0' };
    const { data } = await checkSnmp(monitor(a.port, config));
    data.interfaces[0].inBps = 1_250_000;
    data.interfaces[0].outBps = 2e9;
    assert.equal(cardText(data, {}), 'core-sw · 1/2 links up');
    assert.equal(cardText(data, { hide: ['if:Gi1/0/2'] }), 'core-sw · 1/1 links up');
    assert.equal(cardText(data, { card: ['cpu', 'memory'] }), 'CPU 20% · Mem 25%');
    assert.equal(cardText(data, { card: ['if:Gi1/0/1', 'value:1.3.6.1.4.1.99.1.0'], ...config }), 'Gi1/0/1 ↓1.25M ↑2G · Temperature 42');
    assert.equal(cardText(data, { card: ['uptime', 'disk:/'] }), 'up 20m · / 50%');
    assert.equal(cardText(data, { card: ['if:nope', 'disk:nope'] }), ''); // gone: the check says "SNMP OK"
  } finally {
    a.close();
  }
});

test('display settings change what is shown without losing the data', async () => {
  const store = new Store(':memory:');
  const engine = new Engine({ store, checkers: { snmp: async () => ({ ok: true, ping: 1, msg: 'ok', data: { n: 1 } }) }, notify: async () => [], schedule: () => null, cancel: () => {} });
  const icons = { describe: () => null, sync: () => {}, hasUpload: () => false, saveUpload: () => {} };
  const handle = createApi({ store, engine, icons });
  const call = (method, path, body) => handle({ method }, new URL(`http://x${path}`), body);
  const created = await call('POST', '/api/monitors', { name: 'Switch', type: 'snmp', config: { host: '10.0.0.2' } });
  await engine.idle();
  const id = created.id;
  assert.deepEqual((await call('GET', `/api/monitors/${id}/data`)).display, { oids: '', hide: [], card: [] });

  const display = await call('PUT', `/api/monitors/${id}/snmp-display`, { hide: ['if:lo', 'section:resources'], card: ['cpu'] });
  assert.deepEqual(display, { oids: '', hide: ['if:lo', 'section:resources'], card: ['cpu'] });
  assert.ok(store.getMonitorData(id), 'still there');
  await assert.rejects(call('PUT', `/api/monitors/${id}/snmp-display`, { card: ['cpu', 'memory', 'uptime'] }), /at most 2/);
  await assert.rejects(call('PUT', `/api/monitors/${id}/snmp-display`, { oids: 'Temp = nope' }), /is not "Label = OID"/);

  // Saving the form with the same target keeps the data; a new host drops it.
  const m = await call('GET', `/api/monitors/${id}`);
  await call('PUT', `/api/monitors/${id}`, { ...m, config: { ...m.config, oids: 'Temp = 1.3.6.1.4.1.1.0' } });
  assert.ok(store.getMonitorData(id));
  await call('PUT', `/api/monitors/${id}`, { ...m, config: { ...m.config, host: '10.0.0.3' } });
  assert.equal(store.getMonitorData(id), null);
});
