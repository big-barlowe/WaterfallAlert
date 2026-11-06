import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { Engine } from '../src/engine.js';
import { createApi } from '../src/api.js';
import { parseCsv, toCsv } from '../src/csv.js';
import { exportCsv, importCsv, CSV_EXAMPLE, csvTemplate } from '../src/transfer.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);

function freshStore() {
  const store = new Store(':memory:');
  store.createNotification({ name: 'Phone', type: 'webhook', config: {}, isDefault: true });
  store.createNotification({ name: 'Email', type: 'webhook', config: {} });
  return store;
}

function add(store, name, type, extra = {}) {
  return store.createMonitor({
    name, type, config: {}, interval: 60, retries: 1, retryInterval: 20, timeout: 10,
    resendInterval: 0, parentMode: 'all', active: true, ...extra,
  });
}

// Everything an import should carry over, without ids.
function snapshot(store) {
  const monitors = store.listMonitors();
  const name = new Map(monitors.map((m) => [m.id, m.name]));
  const edges = store.listEdges();
  const tags = new Map(store.listTags().map((t) => [t.id, `${t.name} ${t.color}`]));
  const tagMap = store.monitorTagMap();
  const channels = new Map(store.listNotifications().map((n) => [n.id, n.name]));
  return monitors.map((m) => ({
    name: m.name,
    type: m.type,
    // unticked checkboxes are absent or false, depending on how it was saved
    config: Object.fromEntries(Object.entries(m.config).filter(([, v]) => v !== false)),
    settings: [m.interval, m.retries, m.retryInterval, m.timeout, m.resendInterval, m.parentMode, m.active, m.description, m.icon],
    parents: edges.filter((e) => e.childId === m.id).map((e) => name.get(e.parentId)).sort(),
    tags: (tagMap.get(m.id) ?? []).map((t) => tags.get(t)),
    notifications: store.monitorNotificationIds(m.id).map((id) => channels.get(id)).sort(),
    image: m.icon === 'upload' ? Buffer.from(store.getIcon(m.id).data).toString('hex') : null,
    pushToken: m.type === 'push' ? m.pushToken : null,
  })).sort((a, b) => `${a.name}${a.parents}`.localeCompare(`${b.name}${b.parents}`));
}

test('CSV survives commas, quotes, newlines and a BOM', () => {
  const rows = [['a', 'b,c', 'say "hi"'], ['line\nbreak', ' padded ', '']];
  const text = toCsv(rows);
  assert.ok(text.startsWith('﻿'));
  assert.deepEqual(parseCsv(text).map((r) => r.cells), rows);
  // the record after a quoted newline starts on line 4
  assert.deepEqual(parseCsv('h\n"x\ny"\nz').map((r) => r.line), [1, 2, 4]);
  assert.throws(() => parseCsv('a\n"open'), /never closed/);
});

test('an export imports into a new install as the same monitors', () => {
  const src = freshStore();
  const [phone, email] = src.listNotifications().sort((a, b) => a.id - b.id).map((n) => n.id);
  const wan = add(src, 'WAN', 'ping', { config: { host: '1.1.1.1' }, icon: 'builtin:globe', description: 'Fibre, "the good one"' });
  const router = add(src, 'Router | main', 'tcp', { config: { host: '192.168.1.1', port: '80' }, parentMode: 'any', retries: 3 });
  const site = add(src, 'Site', 'http', {
    config: { url: 'https://x.example/', method: 'HEAD', acceptedCodes: '200-399', keyword: 'ok, fine', ignoreTls: true, invertKeyword: false, headers: '{"A": "b"}' },
    icon: 'upload', active: false, interval: 300,
  });
  // two monitors with the same name need keys to be told apart
  const api1 = add(src, 'API', 'http', { config: { url: 'https://a.example/', method: 'GET', acceptedCodes: '200-299' } });
  const api2 = add(src, 'API', 'http', { config: { url: 'https://b.example/', method: 'GET', acceptedCodes: '200-299' } });
  const push = add(src, 'Backup', 'push');
  add(src, 'Folder', 'group', { icon: 'emoji:📁' });
  src.addEdge(wan, router);
  src.addEdge(wan, site);
  src.addEdge(router, site);
  src.addEdge(router, api1);
  src.addEdge(site, api2);
  src.addEdge(api2, push);
  src.setIcon(site, { source: 'upload', mime: 'image/png', data: PNG, updatedAt: 1, checkedAt: 1 });
  const home = src.createTag({ name: 'Home', color: '#60a5fa' });
  const media = src.createTag({ name: 'Media, etc', color: '#e879f9' });
  src.setMonitorTags(site, [home, media]);
  src.setMonitorTags(api2, [home]);
  src.setMonitorNotifications(wan, [phone, email]);
  src.setMonitorNotifications(router, []);

  const csv = exportCsv(src);
  const dst = freshStore();
  const res = importCsv(dst, csv);
  assert.deepEqual(res.errors, []);
  assert.equal(res.created, 7);
  for (const u of res.uploads) dst.setIcon(u.id, { source: 'upload', ...u.img, updatedAt: 1, checkedAt: 1 });
  assert.equal(res.tagsCreated, 2);
  assert.deepEqual(snapshot(dst), snapshot(src));

  // The uploaded image comes back from the route that applies the import.
  assert.equal(res.uploads.length, 1);
  assert.deepEqual(res.uploads[0].img.data, PNG);
});

test('a dry run changes nothing, and so does a file with any error', () => {
  const store = freshStore();
  const text = [
    'name,type,parents,host,url,interval',
    'WAN,ping,,1.1.1.1,,',
    '"Multi',
    'line",http,WAN,,https://ok.example/,',
    'Broken,tcp,WAN,10.0.0.1,,',
    'Orphan,ping,Nowhere,10.0.0.2,,abc',
  ].join('\n');
  const dry = importCsv(store, text.split('\n').slice(0, 4).join('\n'), { dryRun: true });
  assert.deepEqual(dry.errors, []);
  assert.equal(dry.applied, false);
  assert.equal(dry.created, 2); // "Multi\nline" is one record
  assert.equal(store.listMonitors().length, 0);

  const bad = importCsv(store, text);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors, [
    { line: 5, message: 'port is required for tcp monitors' },
    { line: 6, message: 'interval must be a whole number, not "abc"' },
  ]);
  assert.equal(store.listMonitors().length, 0);
  assert.equal(store.listTags().length, 0);
});

test('update and skip modes match existing monitors by name', () => {
  const store = freshStore();
  const wan = add(store, 'WAN', 'ping', { config: { host: '1.1.1.1' }, description: 'keep me' });
  const nas = add(store, 'NAS', 'tcp', { config: { host: '10.0.0.5', port: '5000' }, interval: 30 });

  // Only the columns in the file change; parents can point at monitors
  // that are not in the file.
  const up = importCsv(store, 'name,interval,parents,tags\nNAS,120,WAN,Storage\nPlex,,NAS,Media', { mode: 'update' });
  assert.deepEqual(up.errors, [{ line: 3, message: 'Type is required for a new monitor' }]);
  // A column that is there but blank means "default" (here: no host).
  const blank = importCsv(store, 'name,type,interval,parents,host,tags\nNAS,,120,WAN,,Storage\nPlex,ping,,NAS,10.0.0.6,Media', { mode: 'update' });
  assert.deepEqual(blank.errors, [{ line: 2, message: 'host is required for tcp monitors' }]);
  const res = importCsv(store, 'name,type,interval,parents,host,tags\nNAS,,120,WAN,10.0.0.5,Storage\nPlex,ping,,NAS,10.0.0.6,Media', { mode: 'update' });
  assert.deepEqual(res.errors, []);
  assert.deepEqual([res.created, res.updated], [1, 1]);
  const after = store.getMonitor(nas);
  assert.equal(after.interval, 120);
  assert.deepEqual(after.config, { host: '10.0.0.5', port: '5000' }); // no port column: kept
  assert.deepEqual(store.listEdges().find((e) => e.childId === nas), { parentId: wan, childId: nas });
  assert.equal(store.getMonitor(wan).description, 'keep me');

  const skip = importCsv(store, 'name,type,host\nWAN,ping,9.9.9.9\nNew,ping,8.8.8.8', { mode: 'skip' });
  assert.deepEqual([skip.created, skip.skipped], [1, 1]);
  assert.equal(store.getMonitor(wan).config.host, '1.1.1.1');

  // add mode makes a second WAN, after which the name is ambiguous
  importCsv(store, 'name,type,host\nWAN,ping,1.0.0.1');
  const amb = importCsv(store, 'name,interval\nWAN,30', { mode: 'update' });
  assert.match(amb.errors[0].message, /2 existing monitors are called "WAN"/);
});

test('loops, unknown parents and unknown channels', () => {
  const store = freshStore();
  const loop = importCsv(store, 'name,type,parents,host\nA,ping,B,a\nB,ping,A,b');
  assert.match(loop.errors[0].message, /loop/);
  const missing = importCsv(store, 'name,type,parents,host\nA,ping,Ghost,a');
  assert.match(missing.errors[0].message, /Parent "Ghost" isn't in the file/);
  const warned = importCsv(store, 'name,type,host,notifications,url,bogus\nA,ping,a,Phone | Pager,https://x/,1');
  assert.equal(warned.ok, true);
  assert.deepEqual(warned.warnings.map((w) => w.message), [
    'Unknown column "bogus" is ignored',
    'url doesn\'t apply to ping monitors and is ignored',
    'There is no notification channel called "Pager"; skipped',
  ]);
});

test('the example imports cleanly and the template is just the header', () => {
  const store = freshStore();
  const res = importCsv(store, CSV_EXAMPLE);
  assert.deepEqual(res.errors, []);
  assert.equal(res.created, 9);
  assert.equal(parseCsv(csvTemplate()).length, 1);
  assert.match(importCsv(store, csvTemplate()).errors[0].message, /only the header/);
});

test('the import route saves uploads and starts the new monitors', async () => {
  const store = freshStore();
  const engine = new Engine({ store, checkers: { ping: () => ({ ok: true, ping: 1, msg: 'ok' }) }, notify: async () => [], schedule: () => null, cancel: () => {} });
  engine.reload();
  const saved = [];
  const icons = { describe: () => null, sync: () => {}, hasUpload: () => false, saveUpload: (id, img) => saved.push(id) };
  const handle = createApi({ store, engine, icons });
  const csv = toCsv([['name', 'type', 'host', 'icon'], ['A', 'ping', 'a', `data:image/png;base64,${PNG.toString('base64')}`]]);
  const call = (body) => handle({ method: 'POST' }, new URL('http://x/api/csv/import'), body);

  const dry = await call({ csv, dryRun: true });
  assert.deepEqual([dry.ok, dry.applied, dry.created], [true, false, 1]);
  assert.equal(saved.length, 0);
  const res = await call({ csv });
  assert.equal(res.applied, true);
  assert.equal(res.affected, undefined);
  assert.equal(saved.length, 1);
  assert.ok(engine.monitors.has(saved[0]));
});
