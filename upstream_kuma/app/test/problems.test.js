import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { Engine } from '../src/engine.js';
import { createApi } from '../src/api.js';
import { evaluate } from '../src/problems.js';
import { checkSnmp } from '../src/checkers/snmp.js';
import { agent, mib } from './fake-snmp.js';

const STD = '1.3.6.1.2.1.33.1.4.1.0'; // UPS-MIB upsOutputSource
const APC = '1.3.6.1.4.1.318.1.1.1.4.1.1.0'; // PowerNet upsBasicOutputStatus
const onBattery = {
  name: 'UPS on battery',
  severity: 'warning',
  config: {
    readings: [
      { source: 'oid', oid: STD, op: 'in', values: [5] },
      { source: 'oid', oid: APC, op: 'in', values: [3], names: { 2: 'onLine', 3: 'onBattery' } },
    ],
  },
};

test('a monitor uses the first reading it answers', () => {
  const p = { config: onBattery.config };
  const probe = (values) => ({ probe: Object.fromEntries(Object.entries(values).map(([oid, value]) => [oid, { value, text: String(value) }])) });
  assert.deepEqual(evaluate(p, probe({ [STD]: 5 })), { state: 'open', value: '5', reading: 0 });
  assert.deepEqual(evaluate(p, probe({ [STD]: 3, [APC]: 3 })), { state: 'ok', value: '3', reading: 0 });
  assert.deepEqual(evaluate(p, probe({ [STD]: null, [APC]: 3 })), { state: 'open', value: 'onBattery (3)', reading: 1 });
  assert.deepEqual(evaluate(p, probe({})), { state: 'unknown', value: '' });

  const disk = { config: { readings: [{ source: 'disk', op: '>=', value: 90 }] } };
  const data = { storage: [{ kind: 'disk', name: '/', size: 100, used: 50 }, { kind: 'disk', name: '/var', size: 100, used: 95 }, { kind: 'memory', name: 'RAM', size: 100, used: 99 }] };
  assert.deepEqual(evaluate(disk, { data }), { state: 'open', value: '/var 95% full', reading: 0 });
  const notIn = { config: { readings: [{ source: 'oid', oid: STD, op: 'not-in', values: ['normal', 3] }] } };
  assert.equal(evaluate(notIn, probe({ [STD]: 3 })).state, 'ok');
  assert.equal(evaluate(notIn, probe({ [STD]: 4 })).state, 'open');
});

// Core ─ UPS 1 (UPS, SNMP) ─ Rack switch
//      ├ UPS 2 (UPS, SNMP, APC)
//      └ Printer (UPS, ping)
function setup() {
  const store = new Store(':memory:');
  let clock = 1_700_000_000_000;
  const values = {}; // monitor name -> { oid: value }
  const up = {};
  const sent = [];
  const engine = new Engine({
    store,
    now: () => clock,
    checkers: {
      ping: (m) => ({ ok: up[m.name] ?? true, ping: 1, msg: 'ok' }),
      snmp: (m, { probe }) => ({
        ok: up[m.name] ?? true,
        ping: 1,
        msg: 'ok',
        probe: Object.fromEntries(probe.map((oid) => {
          const v = values[m.name]?.[oid];
          return [oid, { value: v ?? null, text: v == null ? null : String(v) }];
        })),
      }),
    },
    notify: async (channels, alert) => {
      sent.push({ kind: alert.kind, title: alert.title, message: alert.message, to: channels.map((c) => c.name).sort(), problem: alert.problem });
      return channels.map((c) => ({ id: c.id, name: c.name, ok: true }));
    },
    schedule: () => null,
    cancel: () => {},
  });
  const icons = { describe: () => null, sync: () => {}, hasUpload: () => false, saveUpload: () => {} };
  const handle = createApi({ store, engine, icons });
  const call = (method, p, body) => handle({ method }, new URL(`http://x${p}`), body);
  const ids = {};
  const add = (name, type, parent) => {
    ids[name] = store.createMonitor({
      name, type, config: { host: name }, interval: 60, retries: 0, retryInterval: 20,
      timeout: 5, resendInterval: 0, parentMode: 'all', active: true,
    });
    if (parent) store.addEdge(ids[parent], ids[name]);
  };
  add('Core', 'ping');
  add('UPS 1', 'snmp', 'Core');
  add('Rack switch', 'ping', 'UPS 1');
  add('UPS 2', 'snmp', 'Core');
  add('Printer', 'ping', 'Core');
  const ups = store.createTag({ name: 'UPS', color: '#facc15' });
  for (const n of ['UPS 1', 'UPS 2', 'Printer']) store.setMonitorTags(ids[n], [ups]);
  const pager = store.createNotification({ name: 'Pager', type: 'webhook', config: {} });
  const log = store.createNotification({ name: 'Log', type: 'webhook', config: {} });
  store.createRule({ channelIds: [log] }); // everything
  store.createRule({ channelIds: [pager], minSeverity: 'severe' });
  engine.reload();
  const check = async (name) => {
    clock += 60_000;
    await engine.check(ids[name]);
    await engine.idle();
  };
  return { store, engine, call, ids, ups, pager, log, values, up, sent, check, advance: (ms) => { clock += ms; } };
}

test('a value problem opens, alerts by severity, and resolves', async () => {
  const t = setup();
  const created = await t.call('POST', '/api/problems', { ...onBattery, config: { ...onBattery.config, tagIds: [t.ups], downstream: true } });
  await t.engine.idle();
  assert.equal(created.severity, 'warning');
  // Printer is tagged but not SNMP; the UPSes were checked straight away.
  const cov = (await t.call('GET', '/api/problems')).find((p) => p.id === created.id).coverage;
  assert.deepEqual(cov.notSnmp, [t.ids.Printer]);
  assert.deepEqual(cov.monitors.map((x) => [x.monitorId, x.state]), [[t.ids['UPS 1'], 'unknown'], [t.ids['UPS 2'], 'unknown']]);

  t.values['UPS 1'] = { [STD]: 3 };
  t.values['UPS 2'] = { [APC]: 2 };
  await t.check('UPS 1');
  await t.check('UPS 2');
  assert.equal(t.sent.length, 0);

  t.values['UPS 1'][STD] = 5;
  await t.check('UPS 1');
  assert.equal(t.sent.length, 1);
  const [a] = t.sent;
  assert.equal(a.kind, 'problem');
  assert.equal(a.title, 'Warning: UPS 1 – UPS on battery');
  assert.deepEqual(a.to, ['Log'], 'the severe-only rule stays quiet');
  assert.deepEqual(a.problem, { id: created.id, name: 'UPS on battery', severity: 'warning' });
  assert.match(a.message, /Value: 5/);
  assert.match(a.message, /Downstream monitors \(1\):\n- Rack switch/, a.message);
  assert.equal(t.store.listAlerts(10)[0].severity, 'warning');

  // still open: no second alert; in the open list
  await t.check('UPS 1');
  assert.equal(t.sent.length, 1);
  const open = t.engine.snapshot().open.filter((x) => x.problemId === created.id);
  assert.deepEqual(open.map((x) => [x.monitorId, x.severity, x.value, x.stale]), [[t.ids['UPS 1'], 'warning', '5', false]]);

  // severe now: the pager hears about the next one
  await t.call('PUT', `/api/problems/${created.id}`, { severity: 'severe' });
  await t.engine.idle();
  t.values['UPS 2'][APC] = 3;
  await t.check('UPS 2');
  assert.equal(t.sent.at(-1).title, 'Severe: UPS 2 – UPS on battery');
  assert.deepEqual(t.sent.at(-1).to, ['Log', 'Pager']);

  t.values['UPS 1'][STD] = 3;
  await t.check('UPS 1');
  assert.equal(t.sent.at(-1).kind, 'resolved');
  assert.equal(t.sent.at(-1).title, 'Resolved: UPS 1 – UPS on battery');
  assert.match(t.sent.at(-1).message, /cleared on UPS 1 after 3m 0s/);
});

test('checks in a row, unknown values, monitors going down, and leaving the tag', async () => {
  const t = setup();
  const p = await t.call('POST', '/api/problems', { ...onBattery, config: { ...onBattery.config, tagIds: [t.ups], checks: 2, recovery: false } });
  await t.engine.idle();
  t.values['UPS 1'] = { [STD]: 5 };
  await t.check('UPS 1');
  assert.equal(t.sent.length, 0, 'one hit is not enough');
  await t.check('UPS 1');
  assert.equal(t.sent.length, 1);

  // the device stops answering: it stays open
  t.values['UPS 1'] = {};
  await t.check('UPS 1');
  assert.equal(t.engine.problemState().find((x) => x.monitorId === t.ids['UPS 1']).state, 'open');

  // the monitor goes down: still listed, but stale; and Monitor down is listed too
  t.up['UPS 1'] = false;
  await t.check('UPS 1');
  const open = t.engine.snapshot().open;
  assert.deepEqual(open.map((x) => [x.problemId, x.severity, Boolean(x.stale)]).sort(), [[1, 'severe', false], [p.id, 'warning', true]]);

  // a restart remembers it was open: no new alert
  t.up['UPS 1'] = true;
  t.values['UPS 1'] = { [STD]: 5 };
  const before = t.sent.length;
  const again = new Engine({ store: t.store, checkers: t.engine.checkers, notify: async (c, a) => { t.sent.push(a); return []; }, schedule: () => null, cancel: () => {} });
  again.reload();
  await again.check(t.ids['UPS 1']);
  await again.idle();
  assert.equal(t.sent.filter((a) => a.kind === 'problem').length, 1);
  assert.equal(t.sent.length, before + 1, 'only the Monitor down recovery');

  // recovery off: clearing sends nothing
  t.values['UPS 1'] = { [STD]: 3 };
  await again.check(t.ids['UPS 1']);
  await again.idle();
  assert.equal(t.sent.length, before + 1);

  // untagged: forgotten without an alert
  t.values['UPS 1'] = { [STD]: 5 };
  await again.check(t.ids['UPS 1']);
  await again.check(t.ids['UPS 1']);
  await again.idle();
  assert.equal(again.openProblems().filter((x) => x.problemId === p.id).length, 1);
  t.store.setMonitorTags(t.ids['UPS 1'], []);
  assert.equal(again.openProblems().filter((x) => x.problemId === p.id).length, 0);
  const n = t.sent.length;
  await again.check(t.ids['UPS 1']);
  await again.idle();
  assert.equal(t.sent.length, n);
  assert.equal(again.problemState().filter((x) => x.monitorId === t.ids['UPS 1']).length, 0);
});

test('problem routes validate, rename tags in expressions, and clean up rules on delete', async () => {
  const t = setup();
  await assert.rejects(t.call('POST', '/api/problems', { name: 'x', severity: 'warning', config: { readings: [] } }), /at least one reading/);
  await assert.rejects(t.call('POST', '/api/problems', { name: 'x', severity: 'warning', config: { readings: [{ source: 'oid', oid: 'nope', op: 'in', values: [1] }] } }), /not an OID/);
  await assert.rejects(t.call('POST', '/api/problems', { name: 'x', severity: 'loud', config: onBattery.config }), /Severity/);
  await assert.rejects(t.call('POST', '/api/problems', { name: 'x', severity: 'info', config: { readings: [{ source: 'cpu', op: '>' }] } }), /number/);

  t.store.createTag({ name: 'Spare', color: '#94a3b8' });
  const p = await t.call('POST', '/api/problems', { ...onBattery, config: { ...onBattery.config, tagExpr: 'UPS & !Spare' } });
  await t.call('PUT', `/api/tags/${t.ups}`, { name: 'Battery backup', color: '#facc15' });
  assert.equal(t.store.getProblem(p.id).config.tagExpr, 'Battery backup & !Spare');

  const only = t.store.createRule({ channelIds: [t.pager], problemIds: [p.id] });
  const both = t.store.createRule({ channelIds: [t.pager], problemIds: [p.id, 1] });
  const res = await t.call('DELETE', `/api/problems/${p.id}`);
  assert.equal(res.rulesDeleted, 1);
  assert.equal(t.store.getRule(only), null);
  assert.deepEqual(t.store.getRule(both).problemIds, [1]);
  await assert.rejects(t.call('DELETE', '/api/problems/1'), /built-in/);

  const rule = await t.call('POST', '/api/rules', { channelIds: [t.pager], minSeverity: 'warning' });
  assert.equal(rule.minSeverity, 'warning');
  assert.equal((await t.call('PUT', `/api/rules/${rule.id}`, { minSeverity: 'bogus' })).minSeverity, '');
});

test('the SNMP check reads the values problems ask for, v1 and v2c', async () => {
  for (const version of ['2c', '1']) {
    const values = [...mib(), { oid: STD, type: 'integer', value: 5 }].sort((a, b) => a.oid.localeCompare(b.oid, undefined, { numeric: true }));
    const a = await agent({ version, values });
    try {
      const res = await checkSnmp({ id: 1, name: 'UPS', type: 'snmp', timeout: 2, config: { host: '127.0.0.1', port: a.port, version } }, { probe: [STD, APC] });
      assert.equal(res.ok, true);
      assert.equal(res.probe[STD].value, 5);
      assert.deepEqual(res.probe[APC], { value: null, text: null }, `missing over v${version}`);
    } finally {
      a.close();
    }
  }
});

test("a monitor's page lists the problems reading it, and which reading it answered", async () => {
  const t = setup();
  const p = await t.call('POST', '/api/problems', { ...onBattery, config: { ...onBattery.config, tagIds: [t.ups] } });
  await t.engine.idle();
  t.values['UPS 2'] = { [APC]: 3 };
  await t.check('UPS 2');
  const [apc] = await t.call('GET', `/api/monitors/${t.ids['UPS 2']}/problems`);
  assert.equal(apc.problem.id, p.id);
  assert.deepEqual([apc.state, apc.reading, apc.value], ['open', 1, 'onBattery (3)']);
  const [none] = await t.call('GET', `/api/monitors/${t.ids['UPS 1']}/problems`);
  assert.deepEqual([none.state, none.reading], ['unknown', null]);
  const [printer] = await t.call('GET', `/api/monitors/${t.ids.Printer}/problems`);
  assert.equal(printer.state, 'notSnmp');
  assert.deepEqual(await t.call('GET', `/api/monitors/${t.ids.Core}/problems`), []);
});

test('a reading can be kept to one model (sysObjectID) or to certain monitors', async () => {
  const odd = '1.3.6.1.4.1.99999.5.1.0';
  const p = { config: { readings: [
    { source: 'oid', oid: odd, op: 'in', values: [2], where: { sysObjectId: '1.3.6.1.4.1.99999.1' } },
    { source: 'oid', oid: odd, op: 'in', values: [1], where: { monitorIds: [7] } },
  ] } };
  const res = (sys) => ({ probe: { [odd]: { value: 2, text: '2' } }, data: { system: { objectId: sys } } });
  assert.equal(evaluate(p, res('1.3.6.1.4.1.99999.1'), { id: 3 }).state, 'open');
  assert.deepEqual(evaluate(p, res('1.3.6.1.4.1.318.1'), { id: 7 }), { state: 'ok', value: '2', reading: 1 });
  assert.equal(evaluate(p, res('1.3.6.1.4.1.318.1'), { id: 3 }).state, 'unknown');

  const t = setup();
  const body = (where) => ({ name: 'Odd', severity: 'info', config: { readings: [{ source: 'oid', oid: odd, op: 'in', values: [1], where }] } });
  await assert.rejects(t.call('POST', '/api/problems', body({ sysObjectId: 'APC' })), /Reading 1: "APC" is not a sysObjectID/);
  const saved = await t.call('POST', '/api/problems', body({ sysObjectId: '.1.3.6.1.4.1.99999.1', monitorIds: [3, 3, 'x'] }));
  assert.deepEqual(saved.config.readings[0].where, { sysObjectId: '1.3.6.1.4.1.99999.1', monitorIds: [3] });
  const plain = await t.call('POST', '/api/problems', body({}));
  assert.equal(plain.config.readings[0].where, undefined);
});
