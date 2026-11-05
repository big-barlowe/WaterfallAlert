import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { IconCache, findIconLinks, sniffImage, validateIconSpec, decodeDataUrl } from '../src/icons.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const ICO = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]);

function setup(sites) {
  const store = new Store(':memory:');
  const requests = [];
  // sites: url -> { code?, body, type? } or a function returning one
  const request = async (url) => {
    requests.push(url);
    const r = typeof sites[url] === 'function' ? sites[url]() : sites[url];
    if (!r) throw new Error(`ECONNREFUSED ${url}`);
    const body = Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body);
    return { code: r.code ?? 200, headers: { 'content-type': r.type ?? 'text/html' }, url, body, size: body.length };
  };
  let changes = 0;
  const icons = new IconCache({ store, request, onChange: () => changes++ });
  const add = (fields) => {
    const id = store.createMonitor({
      name: 'Site', type: 'http', config: {}, interval: 60, retries: 0, retryInterval: 20, timeout: 5,
      resendInterval: 0, parentMode: 'all', active: true, ...fields,
    });
    return id;
  };
  const sync = async (force) => {
    icons.sync(store.listMonitors(), force);
    await icons.idle();
  };
  return { store, icons, add, sync, requests, changes: () => changes };
}

test('picks the best <link rel=icon> and resolves it against the page', () => {
  const html = `
    <link rel="stylesheet" href="/app.css">
    <link rel="icon" href="/favicon-16.png" sizes="16x16">
    <link rel='icon' type='image/png' href='icons/fav-48.png?a=1&amp;b=2' sizes='48x48'>
    <link href="/apple.png" rel="apple-touch-icon">
    <link rel="mask-icon" href="/mask.svg">`;
  const links = findIconLinks(html, 'https://nas.local/ui/index.html');
  assert.deepEqual(links.map((l) => l.url), [
    'https://nas.local/ui/icons/fav-48.png?a=1&b=2',
    'https://nas.local/apple.png',
    'https://nas.local/favicon-16.png',
  ]);
});

test('identifies images by content, not by name', () => {
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(ICO), 'image/x-icon');
  assert.equal(sniffImage(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'image/svg+xml');
  assert.equal(sniffImage(Buffer.from('<!doctype html><html>')), null);
  assert.throws(() => decodeDataUrl('data:text/html;base64,' + Buffer.from('<html>').toString('base64')), /not a supported image/);
  assert.equal(decodeDataUrl('data:image/png;base64,' + PNG.toString('base64')).mime, 'image/png');
});

test('validates icon specs', () => {
  assert.equal(validateIconSpec(''), '');
  assert.equal(validateIconSpec('builtin:server'), 'builtin:server');
  assert.equal(validateIconSpec('emoji: 🖥️ '), 'emoji:🖥️');
  assert.equal(validateIconSpec('url:https://cdn.example/x.png'), 'url:https://cdn.example/x.png');
  assert.throws(() => validateIconSpec('url:javascript:alert(1)'), /http/);
  assert.throws(() => validateIconSpec('builtin:<script>'), /Unknown/);
});

test('HTTP monitors get the favicon from the page, falling back to the home page', async () => {
  const t = setup({
    'https://app.local/api/health': { body: '{"ok":true}', type: 'application/json' },
    'https://app.local/': { body: '<head><link rel="icon" href="/static/logo.png"></head>' },
    'https://app.local/static/logo.png': { body: PNG, type: 'image/png' },
  });
  const id = t.add({ config: { url: 'https://app.local/api/health' } });
  await t.sync();
  const icon = t.icons.describe(t.store.getMonitor(id));
  assert.equal(icon.kind, 'image');
  assert.match(icon.src, new RegExp(`^api/monitors/${id}/icon\\?v=\\d+$`));
  assert.deepEqual(Buffer.from(t.store.getIcon(id).data), PNG);
  assert.equal(t.changes(), 1);
});

test('falls back to /favicon.ico and caches failures', async () => {
  const t = setup({
    'http://router.local/': { body: '<html>no links</html>' },
    'http://router.local/favicon.ico': { body: ICO, type: 'image/x-icon' },
  });
  const ok = t.add({ config: { url: 'http://router.local/' } });
  const dead = t.add({ config: { url: 'http://dead.local/' } });
  await t.sync();
  assert.equal(t.icons.describe(t.store.getMonitor(ok)).kind, 'image');
  assert.equal(t.icons.describe(t.store.getMonitor(dead)), null);

  // A second sync doesn't re-fetch either of them.
  const before = t.requests.length;
  await t.sync();
  assert.equal(t.requests.length, before);
});

test('changing the icon setting drops the old image; groups default to a folder', async () => {
  const t = setup({
    'https://a.local/': { body: '<link rel="icon" href="/i.png">' },
    'https://a.local/i.png': { body: PNG },
    'https://cdn.local/proxmox.png': { body: PNG },
  });
  const id = t.add({ config: { url: 'https://a.local/' } });
  await t.sync();
  assert.ok(t.store.getIcon(id));

  t.store.updateMonitor(id, { icon: 'emoji:🖥️' });
  await t.sync();
  assert.equal(t.store.getIcon(id), null);
  assert.deepEqual(t.icons.describe(t.store.getMonitor(id)), { kind: 'emoji', value: '🖥️' });

  t.store.updateMonitor(id, { icon: 'url:https://cdn.local/proxmox.png' });
  await t.sync();
  assert.equal(t.icons.describe(t.store.getMonitor(id)).kind, 'image');

  const group = t.add({ name: 'Rack', type: 'group' });
  await t.sync();
  assert.deepEqual(t.icons.describe(t.store.getMonitor(group)), { kind: 'builtin', name: 'folder' });
  t.store.updateMonitor(group, { icon: 'none' });
  assert.equal(t.icons.describe(t.store.getMonitor(group)), null);
});

test('a failed refresh keeps the previous image', async () => {
  let up = true;
  const t = setup({
    'https://b.local/': () => (up ? { body: '<link rel="icon" href="/i.png">' } : null),
    'https://b.local/i.png': () => (up ? { body: PNG } : null),
  });
  const id = t.add({ config: { url: 'https://b.local/' } });
  await t.sync();
  up = false;
  await t.sync([id]); // forced, as after saving the monitor
  assert.equal(t.icons.describe(t.store.getMonitor(id)).kind, 'image');
});
