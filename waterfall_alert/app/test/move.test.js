import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { Engine } from '../src/engine.js';
import { createApi } from '../src/api.js';

// WAN ─ Router ─ NAS ─ Plex
//     └ Switch ─ Camera
//     └ AP
//     Camera also hangs off AP
function setup() {
  const store = new Store(':memory:');
  const engine = new Engine({
    store,
    checkers: { ping: () => ({ ok: true, ping: 1, msg: 'ok' }) },
    notify: async () => [],
    schedule: () => null,
    cancel: () => {},
  });
  const icons = { describe: () => null, sync: () => {}, hasUpload: () => false, saveUpload: () => {} };
  const handle = createApi({ store, engine, icons });
  const call = (method, path, body) => handle({ method }, new URL(`http://x${path}`), body);
  const ids = {};
  const add = (name, ...parents) => {
    ids[name] = store.createMonitor({
      name, type: 'ping', config: { host: name }, interval: 60, retries: 0, retryInterval: 20,
      timeout: 5, resendInterval: 0, parentMode: 'all', active: true,
    });
    for (const p of parents) store.addEdge(ids[p], ids[name]);
  };
  add('WAN');
  add('Router', 'WAN');
  add('Switch', 'WAN');
  add('AP', 'WAN');
  add('NAS', 'Router');
  add('Plex', 'NAS');
  add('Camera', 'Switch', 'AP');
  engine.reload();
  const parentsOf = (name) => engine.graph.parentsOf(ids[name]).map((p) => Object.keys(ids).find((k) => ids[k] === p)).sort();
  return { call, ids, parentsOf, engine };
}

test('moving several monitors keeps a moved subtree in shape', async () => {
  const { call, ids, parentsOf } = setup();
  // NAS and Plex picked together: Plex rides along under NAS.
  const res = await call('POST', '/api/monitors/move', {
    moves: [{ id: ids.NAS, fromParentId: ids.Router }, { id: ids.Plex, fromParentId: ids.NAS }, { id: ids.AP }],
    toParentId: ids.Switch,
  });
  assert.deepEqual(res, { ok: true, moved: 2, along: 1 });
  assert.deepEqual(parentsOf('NAS'), ['Switch']);
  assert.deepEqual(parentsOf('Plex'), ['NAS']);
  assert.deepEqual(parentsOf('AP'), ['Switch']);
});

test('the parent a monitor is moved from decides which edge goes', async () => {
  const { call, ids, parentsOf } = setup();
  // From the tree, under AP: only that edge is replaced.
  await call('POST', '/api/monitors/move', { moves: [{ id: ids.Camera, fromParentId: ids.AP }], toParentId: ids.Router });
  assert.deepEqual(parentsOf('Camera'), ['Router', 'Switch']);
  // From the Falls (no fromParentId): all parents are replaced.
  await call('POST', '/api/monitors/move', { moves: [{ id: ids.Camera }], toParentId: ids.NAS });
  assert.deepEqual(parentsOf('Camera'), ['NAS']);
  // link keeps them; null moves to the top level.
  await call('POST', '/api/monitors/move', { moves: [{ id: ids.Camera }], toParentId: ids.AP, link: true });
  assert.deepEqual(parentsOf('Camera'), ['AP', 'NAS']);
  await call('POST', '/api/monitors/move', { moves: [{ id: ids.Camera }, { id: ids.Plex, fromParentId: ids.NAS }], toParentId: null });
  assert.deepEqual(parentsOf('Camera'), []);
  assert.deepEqual(parentsOf('Plex'), []);
});

test('a move that would make a loop changes nothing', async () => {
  const { call, ids, parentsOf } = setup();
  await assert.rejects(call('POST', '/api/monitors/move', {
    moves: [{ id: ids.AP, fromParentId: ids.WAN }, { id: ids.Router, fromParentId: ids.WAN }],
    toParentId: ids.Plex,
  }), /loop/);
  assert.deepEqual(parentsOf('AP'), ['WAN']); // rolled back with the rest
  assert.deepEqual(parentsOf('Router'), ['WAN']);
  await assert.rejects(call('POST', '/api/monitors/move', { moves: [{ id: ids.AP }], toParentId: ids.AP }), /under itself/);
  await assert.rejects(call('POST', '/api/monitors/move', { moves: [] }), /Nothing to move/);
  await assert.rejects(call('POST', '/api/monitors/move', { moves: [{ id: 999 }], toParentId: ids.AP }), /not found/);
});

test('the single-monitor move route still works', async () => {
  const { call, ids, parentsOf } = setup();
  await call('POST', `/api/monitors/${ids.Camera}/move`, { fromParentId: ids.Switch, toParentId: ids.Router });
  assert.deepEqual(parentsOf('Camera'), ['AP', 'Router']);
  await assert.rejects(call('POST', `/api/monitors/${ids.WAN}/move`, { fromParentId: null, toParentId: ids.AP }), /loop/);
  assert.deepEqual(parentsOf('WAN'), []);
});
