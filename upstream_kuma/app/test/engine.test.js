import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { Engine } from '../src/engine.js';
import { Graph } from '../src/graph.js';
import { UP, DOWN, BLOCKED, PENDING } from '../src/status.js';

// Builds the hierarchy from the README:
//   WAN
//   ├ Host 1 ─ Service 1 ─ Microservice 1
//   │        └ Service 2
//   └ Host 2 ─ Service 2.1 ─ Microservice 2.1.1
//            └ Service 2.2
function setup({ retries = 0 } = {}) {
  const store = new Store(':memory:');
  let clock = 1_700_000_000_000;
  const results = {}; // monitor name -> boolean (up?)
  const calls = {};   // monitor name -> number of real checks
  const alerts = [];

  const fake = (m) => {
    calls[m.name] = (calls[m.name] ?? 0) + 1;
    const ok = results[m.name] ?? true;
    return { ok, ping: 5, msg: ok ? 'ok' : 'timeout' };
  };
  const checkers = { ping: fake, http: fake, tcp: fake };

  const notifId = store.createNotification({ name: 'phone', type: 'webhook', config: {} });
  store.createRule({ channelIds: [notifId] }); // everything, for every monitor
  const ids = {};
  const add = (name, type, parents = [], extra = {}) => {
    const id = store.createMonitor({
      name, type, config: {}, interval: 60, retries, retryInterval: 20, timeout: 5,
      resendInterval: 0, parentMode: 'all', active: true, ...extra,
    });
    for (const p of parents) store.addEdge(ids[p], id);
    ids[name] = id;
  };
  add('WAN', 'ping');
  add('Host 1', 'ping', ['WAN']);
  add('Service 1', 'http', ['Host 1']);
  add('Microservice 1', 'http', ['Service 1']);
  add('Service 2', 'http', ['Host 1']);
  add('Host 2', 'ping', ['WAN']);
  add('Service 2.1', 'http', ['Host 2']);
  add('Microservice 2.1.1', 'http', ['Service 2.1']);
  add('Service 2.2', 'http', ['Host 2']);

  const engine = new Engine({
    store,
    checkers,
    notify: async (channels, alert) => {
      alerts.push(alert);
      return channels.map((c) => ({ id: c.id, ok: true }));
    },
    now: () => clock,
    schedule: () => null,
    cancel: () => {},
  });
  const status = (name) => engine.runtime.get(ids[name]).status;
  const advance = (ms) => { clock += ms; };
  const resetCalls = () => { for (const k of Object.keys(calls)) delete calls[k]; };
  return { store, engine, ids, results, calls, alerts, status, advance, resetCalls, add };
}

test('a down host sends one alert listing everything beneath it, without checking it', async () => {
  const t = setup();
  t.results['Host 2'] = false;
  await t.engine.start();
  await t.engine.idle();

  assert.equal(t.status('Host 2'), DOWN);
  for (const n of ['Service 2.1', 'Microservice 2.1.1', 'Service 2.2']) {
    assert.equal(t.status(n), BLOCKED, `${n} should be blocked`);
    assert.equal(t.calls[n] ?? 0, 0, `${n} should never have been checked`);
  }
  assert.equal(t.status('Service 1'), UP);

  assert.equal(t.alerts.length, 1);
  const [a] = t.alerts;
  assert.equal(a.title, 'Alert: Host 2 is unreachable');
  assert.match(a.message, /Other affected monitors \(3\):\n- Service 2\.1\n-- Microservice 2\.1\.1\n- Service 2\.2/);
  assert.deepEqual(a.affected.map((x) => x.name), ['Service 2.1', 'Microservice 2.1.1', 'Service 2.2']);
});

test('a child failure re-checks its parents first and alerts on the real root cause', async () => {
  const t = setup();
  await t.engine.start();
  t.advance(60_000);
  t.resetCalls();

  // WAN dies, but Host 2's timer happens to fire before WAN's does.
  t.results.WAN = false;
  t.results['Host 2'] = false;
  await t.engine.check(t.ids['Host 2']);
  await t.engine.idle();

  assert.equal(t.calls.WAN, 1, 'WAN should be probed by the failing child');
  assert.equal(t.status('WAN'), DOWN);
  assert.equal(t.status('Host 2'), BLOCKED);
  assert.equal(t.status('Microservice 1'), BLOCKED);
  assert.equal(t.alerts.length, 1, 'only the root cause alerts');
  assert.equal(t.alerts[0].title, 'Alert: WAN is unreachable');
  assert.equal(t.alerts[0].affected.length, 8);
});

test('a failing parent that is still retrying holds the child in pending', async () => {
  const t = setup({ retries: 1 });
  await t.engine.start();
  t.advance(60_000);

  t.results['Host 1'] = false;
  t.results['Service 1'] = false;
  await t.engine.check(t.ids['Service 1']); // pending (retry 1/1)
  t.advance(20_000);
  await t.engine.check(t.ids['Service 1']); // confirmed failure -> probes Host 1 (now pending)
  assert.equal(t.status('Host 1'), PENDING);
  assert.equal(t.status('Service 1'), PENDING);
  assert.equal(t.alerts.length, 0);

  t.advance(20_000);
  await t.engine.check(t.ids['Host 1']);
  await t.engine.idle();
  assert.equal(t.status('Host 1'), DOWN);
  assert.equal(t.status('Service 1'), BLOCKED);
  assert.deepEqual(t.alerts.map((a) => a.title), ['Alert: Host 1 is unreachable']);
});

test('recovery sends a resolved alert and re-checks downstream one level at a time', async () => {
  const t = setup();
  t.results['Host 2'] = false;
  await t.engine.start();
  await t.engine.idle();
  t.advance(5 * 60_000);
  t.resetCalls();

  t.results['Host 2'] = true;
  t.results['Service 2.1'] = false;
  await t.engine.check(t.ids['Host 2']);
  await t.engine.idle();

  assert.equal(t.status('Host 2'), UP);
  assert.equal(t.status('Service 2.2'), UP);
  assert.equal(t.status('Service 2.1'), DOWN);
  assert.equal(t.status('Microservice 2.1.1'), BLOCKED);
  assert.equal(t.calls['Microservice 2.1.1'] ?? 0, 0);

  const titles = t.alerts.map((a) => a.title);
  assert.deepEqual(titles, [
    'Alert: Host 2 is unreachable',
    'Resolved: Host 2 is back up',
    'Alert: Service 2.1 is down',
  ]);
  assert.match(t.alerts[1].message, /after 5m 0s down/);
  assert.deepEqual(t.alerts[2].affected.map((a) => a.name), ['Microservice 2.1.1']);
});

test("parentMode 'any' keeps a monitor reachable while one parent is up", async () => {
  const t = setup();
  t.add('Shared NAS', 'tcp', ['Host 1', 'Host 2'], { parentMode: 'any' });
  t.add('Strict NAS', 'tcp', ['Host 1', 'Host 2']);
  t.results['Host 2'] = false;
  await t.engine.start();
  await t.engine.idle();

  assert.equal(t.status('Shared NAS'), UP);
  assert.equal(t.status('Strict NAS'), BLOCKED);
  assert.ok(!t.alerts[0].affected.some((a) => a.name === 'Shared NAS'));
  assert.ok(t.alerts[0].affected.some((a) => a.name === 'Strict NAS'));
});

test('groups are transparent folders', async () => {
  const t = setup();
  t.add('Media', 'group', ['Host 1']);
  t.add('Plex', 'http', ['Media']);
  await t.engine.start();
  t.advance(60_000);
  t.results['Host 1'] = false;
  await t.engine.check(t.ids['Host 1']);
  await t.engine.idle();

  assert.equal(t.status('Plex'), BLOCKED);
  assert.equal(t.engine.displayStatus(t.ids.Media), 'blocked');
  const affected = t.alerts[0].affected.map((a) => `${a.depth}:${a.name}`);
  assert.ok(affected.includes('1:Media') && affected.includes('2:Plex'));
});

test('a paused parent does not block its children', async () => {
  const t = setup();
  t.store.updateMonitor(t.ids['Host 1'], { active: false });
  t.results['Host 1'] = false;
  await t.engine.start();
  await t.engine.idle();
  assert.equal(t.calls['Host 1'] ?? 0, 0);
  assert.equal(t.status('Service 1'), UP);
});

test('restarting while something is already down does not re-alert', async () => {
  const t = setup();
  t.results['Host 2'] = false;
  await t.engine.start();
  await t.engine.idle();
  assert.equal(t.alerts.length, 1);

  const again = new Engine({
    store: t.store,
    checkers: t.engine.checkers,
    notify: async (c, a) => { t.alerts.push(a); return []; },
    schedule: () => null,
    cancel: () => {},
  });
  await again.start();
  await again.idle();
  assert.equal(t.alerts.length, 1);
});

test('push monitors go up on push and down when pushes stop', async () => {
  const t = setup();
  t.add('Backup job', 'push', ['Host 1']);
  await t.engine.start();
  assert.equal(t.status('Backup job'), DOWN);
  const token = t.store.getMonitor(t.ids['Backup job']).pushToken;
  await t.engine.receivePush(token, {});
  await t.engine.idle();
  assert.equal(t.status('Backup job'), UP);
  t.advance(61_000);
  await t.engine.check(t.ids['Backup job']);
  assert.equal(t.status('Backup job'), DOWN);
});

test('graph rejects cycles', () => {
  const g = new Graph([1, 2, 3], [{ parentId: 1, childId: 2 }, { parentId: 2, childId: 3 }]);
  assert.equal(g.wouldCycle(3, 1), true);
  assert.equal(g.wouldCycle(1, 3), false);
  assert.equal(new Graph([1, 2], [{ parentId: 1, childId: 2 }, { parentId: 2, childId: 1 }]).hasCycle(), true);
});
