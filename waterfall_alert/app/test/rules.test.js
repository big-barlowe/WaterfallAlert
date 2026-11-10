import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, MIGRATIONS } from '../src/db.js';
import { Engine } from '../src/engine.js';
import { createApi } from '../src/api.js';
import { renameInExpr } from '../public/js/filter.js';
import { matchRules, ruleProblem } from '../public/js/rules.js';

// WAN ─ Switch ─ NAS (Critical)
//            └ Printer
function setup() {
  const store = new Store(':memory:');
  const results = {};
  const sent = []; // [kind, title, channel names]
  const engine = new Engine({
    store,
    checkers: { ping: (m) => ({ ok: results[m.name] ?? true, ping: 1, msg: results[m.name] === false ? 'timeout' : 'ok' }) },
    notify: async (channels, alert) => {
      sent.push([alert.kind, alert.title, channels.map((c) => c.name).sort()]);
      return channels.map((c) => ({ id: c.id, name: c.name, ok: true }));
    },
    schedule: () => null,
    cancel: () => {},
  });
  const icons = { describe: () => null, sync: () => {}, hasUpload: () => false, saveUpload: () => {} };
  const handle = createApi({ store, engine, icons });
  const call = (method, p, body) => handle({ method }, new URL(`http://x${p}`), body);
  const ids = {};
  const add = (name, parent) => {
    ids[name] = store.createMonitor({
      name, type: 'ping', config: { host: name }, interval: 60, retries: 0, retryInterval: 20,
      timeout: 5, resendInterval: 0, parentMode: 'all', active: true,
    });
    if (parent) store.addEdge(ids[parent], ids[name]);
  };
  add('WAN');
  add('Switch', 'WAN');
  add('NAS', 'Switch');
  add('Printer', 'Switch');
  const phone = store.createNotification({ name: 'Phone', type: 'webhook', config: {} });
  const email = store.createNotification({ name: 'Email', type: 'webhook', config: {} });
  const critical = store.createTag({ name: 'Critical', color: '#f472b6' });
  const office = store.createTag({ name: 'Office', color: '#60a5fa' });
  store.setMonitorTags(ids.NAS, [critical]);
  store.setMonitorTags(ids.Printer, [office]);
  const down = store.listProblems()[0].id;
  const fail = async (name) => {
    results[name] = false;
    await engine.check(ids[name]);
    await engine.idle();
  };
  const recover = async (name) => {
    results[name] = true;
    await engine.check(ids[name]);
    await engine.idle();
  };
  engine.reload();
  return { store, engine, call, ids, phone, email, critical, office, down, sent, fail, recover };
}

test('there is one built-in problem, and an alert goes to the channels whose rules match', async () => {
  const t = setup();
  assert.deepEqual(t.store.listProblems(), [{ id: t.down, kind: 'down', name: 'Monitor down', severity: 'severe', config: { recovery: true } }]);
  await t.engine.idle();
  t.store.createRule({ channelIds: [t.email] }); // everything
  t.store.createRule({ channelIds: [t.phone], problemIds: [t.down], tagIds: [t.critical] });

  await t.fail('NAS');
  assert.deepEqual(t.sent.at(-1), ['down', 'Alert: NAS is unreachable', ['Email', 'Phone']]);
  await t.fail('Printer');
  assert.deepEqual(t.sent.at(-1), ['down', 'Alert: Printer is unreachable', ['Email']]);
  await t.recover('Printer');
  await t.recover('NAS');
  assert.deepEqual(t.sent.at(-1), ['up', 'Resolved: NAS is back up', ['Email', 'Phone']]);

  // An untagged switch that takes the NAS down with it: the Critical rule
  // hears about it (downstream is on by default), unless it is turned off.
  await t.fail('Switch');
  assert.deepEqual(t.sent.at(-1), ['down', 'Alert: Switch is unreachable', ['Email', 'Phone']]);
  await t.recover('Switch');
  assert.deepEqual(t.sent.at(-1), ['up', 'Resolved: Switch is back up', ['Email', 'Phone']]);
  const [, rule] = t.store.listRules();
  await t.call('PUT', `/api/rules/${rule.id}`, { downstream: false });
  await t.fail('Switch');
  assert.deepEqual(t.sent.at(-1)[2], ['Email']);

  // Resolved alerts can be turned off on the problem.
  await t.call('PUT', `/api/problems/${t.down}`, { name: 'Down', config: { recovery: false } });
  await t.recover('Switch');
  assert.equal(t.sent.at(-1)[0], 'down', 'no resolved alert was sent');
  const log = t.store.listAlerts(1)[0];
  assert.equal(log.kind, 'up');
  assert.deepEqual(log.delivered, []);
});

test('tag matching: all of several tags, expressions, and deleted tags', () => {
  const tags = [{ id: 1, name: 'Critical' }, { id: 2, name: 'Office' }, { id: 3, name: 'Server room' }];
  const monitorTags = { 10: [1], 11: [1, 2], 12: [2, 3], 13: [] };
  const ctx = (rules) => ({ rules, tags, tagsOf: (id) => monitorTags[id] ?? [] });
  const rule = (extra) => ({ id: 1, channelIds: [7], problemIds: [], tagIds: [], tagMatch: 'any', tagExpr: '', downstream: false, ...extra });
  const hits = (r, monitorId, affectedIds) => matchRules(ctx([r]), { problemId: 1, monitorId, affectedIds }).channelIds.has(7);

  assert.equal(hits(rule({ tagIds: [1, 2], tagMatch: 'all' }), 10), false);
  assert.equal(hits(rule({ tagIds: [1, 2], tagMatch: 'all' }), 11), true);
  assert.equal(hits(rule({ tagIds: [1, 2] }), 12), true);
  assert.equal(hits(rule({ tagExpr: 'Office & !Critical' }), 12), true);
  assert.equal(hits(rule({ tagExpr: 'Office & !Critical' }), 11), false);
  assert.equal(hits(rule({ tagIds: [1] }), 13, [10]), false);
  assert.equal(hits(rule({ tagIds: [1], downstream: true }), 13, [10]), true);
  assert.equal(hits(rule({ problemIds: [2] }), 13), false, 'another problem');
  assert.equal(hits(rule({}), 13), true, 'no tags = every monitor');

  // A rule whose tags are gone stops matching (it must not widen to everything).
  assert.equal(hits(rule({ tagIds: [99] }), 13), false);
  assert.equal(ruleProblem(rule({ tagIds: [99] }), { tags, channels: [{ id: 7 }] }), 'Not sending: Its tag was deleted.');
  assert.equal(ruleProblem(rule({ tagExpr: 'Gone | Office' }), { tags, channels: [{ id: 7 }] }), 'Not sending: No tag called "Gone".');
  assert.equal(ruleProblem(rule({}), { tags, channels: [] }), 'Pick a channel to send to.');
  assert.equal(ruleProblem(rule({ tagIds: [99, 2] }), { tags, channels: [{ id: 7 }] }), null);
});

test('renaming a tag rewrites the expressions that name it', async () => {
  assert.equal(renameInExpr('critical&(Office|"or")', 'Critical', 'Must work'), 'Must work & (Office | "or")');
  assert.equal(renameInExpr('Office', 'Critical', 'X'), 'Office', 'untouched when not named');
  assert.equal(renameInExpr('!Critical', 'critical', 'Server & co'), '!"Server & co"');

  const t = setup();
  const rule = await t.call('POST', '/api/rules', { channelIds: [t.phone], tagExpr: 'Critical | (Office' });
  assert.equal(rule.tagExpr, 'Critical | (Office)', 'an open bracket is closed');
  await t.call('PUT', `/api/tags/${t.critical}`, { name: 'Must work', color: '#f472b6' });
  assert.equal(t.store.getRule(rule.id).tagExpr, 'Must work | (Office)');
  await assert.rejects(t.call('PUT', `/api/rules/${rule.id}`, { tagExpr: 'Nope' }), /No tag called "Nope"/);
});

test('rule routes keep known channels and problems, and keep deleted tags', async () => {
  const t = setup();
  const r = await t.call('POST', '/api/rules', { channelIds: [t.phone, 999], problemIds: [t.down, 5], tagIds: [t.critical, t.office], tagMatch: 'all' });
  assert.deepEqual(r, { id: r.id, channelIds: [t.phone], problemIds: [t.down], minSeverity: '', tagIds: [t.critical, t.office], tagMatch: 'all', tagExpr: '', downstream: true });
  // A partial update keeps the rest; switching to pills clears the expression.
  assert.deepEqual((await t.call('PUT', `/api/rules/${r.id}`, { channelIds: [t.email] })).tagIds, [t.critical, t.office]);
  await t.call('PUT', `/api/rules/${r.id}`, { tagExpr: 'Office' });
  const pills = await t.call('PUT', `/api/rules/${r.id}`, { tagExpr: '', tagIds: [t.office] });
  assert.deepEqual([pills.tagExpr, pills.tagIds], ['', [t.office]]);

  await t.call('DELETE', `/api/tags/${t.office}`);
  assert.deepEqual(t.store.getRule(r.id).tagIds, [t.office], 'kept, so the rule stops instead of matching everything');
  await t.call('DELETE', `/api/rules/${r.id}`);
  await assert.rejects(t.call('DELETE', `/api/rules/${r.id}`), /Rule not found/);
  await assert.rejects(t.call('PUT', `/api/problems/${t.down}`, { name: ' ' }), /Name is required/);

  // A new channel can come with a rule that sends it everything.
  const ch = await t.call('POST', '/api/notifications', { name: 'Pager', type: 'webhook', config: {}, alertAll: true });
  assert.deepEqual(t.store.listRules().map((x) => [x.channelIds, x.tagIds, x.problemIds]), [[[ch.id], [], []]]);
});

test('upgrading turns the channels chosen on each monitor into rules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfa-rules-'));
  const file = path.join(dir, 'db.sqlite');
  try {
    const db = new DatabaseSync(file);
    for (let v = 0; v < 6; v++) db.exec(MIGRATIONS[v]);
    db.exec('PRAGMA user_version = 6');
    const monitor = db.prepare("INSERT INTO monitors (name, type, created_at) VALUES (?, 'ping', 0)");
    const [a, b, c] = ['A', 'B', 'C'].map((n) => Number(monitor.run(n).lastInsertRowid));
    const channel = db.prepare("INSERT INTO notifications (name, type, is_default) VALUES (?, 'webhook', ?)");
    const [all, pager, sms, unused] = [['All', 1], ['Pager', 0], ['SMS', 0], ['Unused', 1]].map(([n, d]) => Number(channel.run(n, d).lastInsertRowid));
    db.exec("INSERT INTO tags (name, color) VALUES ('Alerts: Pager, SMS', '#000000')"); // a name that is taken
    const use = db.prepare('INSERT INTO monitor_notifications (monitor_id, notification_id) VALUES (?, ?)');
    for (const m of [a, b, c]) use.run(m, all);
    for (const m of [a, b]) use.run(m, pager);
    for (const m of [a, b]) use.run(m, sms);
    db.close();

    const store = new Store(file);
    const tags = new Map(store.listTags().map((t) => [t.id, t.name]));
    const rules = store.listRules().map((r) => ({ channels: r.channelIds, tags: r.tagIds.map((id) => tags.get(id)), downstream: r.downstream }));
    assert.deepEqual(rules, [
      { channels: [all], tags: [], downstream: true },
      { channels: [pager, sms], tags: ['Alerts: Pager, SMS (2)'], downstream: false },
    ]);
    const tagged = store.monitorTagMap();
    const newTag = store.listTags().find((t) => t.name.endsWith('(2)')).id;
    assert.deepEqual([a, b, c].map((m) => (tagged.get(m) ?? []).includes(newTag)), [true, true, false]);
    assert.ok(!('isDefault' in store.getNotification(unused)));
    store.db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
