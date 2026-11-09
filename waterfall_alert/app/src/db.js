import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const MIGRATIONS = [
  // v1
  `
  CREATE TABLE monitors (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    type            TEXT    NOT NULL,
    config          TEXT    NOT NULL DEFAULT '{}',
    interval        INTEGER NOT NULL DEFAULT 60,
    retries         INTEGER NOT NULL DEFAULT 1,
    retry_interval  INTEGER NOT NULL DEFAULT 20,
    timeout         INTEGER NOT NULL DEFAULT 10,
    resend_interval INTEGER NOT NULL DEFAULT 0,
    parent_mode     TEXT    NOT NULL DEFAULT 'all',
    active          INTEGER NOT NULL DEFAULT 1,
    description     TEXT    NOT NULL DEFAULT '',
    push_token      TEXT,
    created_at      INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX monitors_push_token ON monitors(push_token);

  CREATE TABLE monitor_edges (
    parent_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    child_id  INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    PRIMARY KEY (parent_id, child_id)
  );
  CREATE INDEX monitor_edges_child ON monitor_edges(child_id);

  CREATE TABLE heartbeats (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    status     INTEGER NOT NULL,
    time       INTEGER NOT NULL,
    ping       REAL,
    msg        TEXT    NOT NULL DEFAULT '',
    important  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX heartbeats_monitor_time ON heartbeats(monitor_id, time);
  CREATE INDEX heartbeats_time ON heartbeats(time);
  CREATE INDEX heartbeats_important ON heartbeats(important, time) WHERE important = 1;

  CREATE TABLE notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    type       TEXT    NOT NULL,
    config     TEXT    NOT NULL DEFAULT '{}',
    is_default INTEGER NOT NULL DEFAULT 0,
    active     INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE monitor_notifications (
    monitor_id      INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    PRIMARY KEY (monitor_id, notification_id)
  );

  CREATE TABLE alerts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    time       INTEGER NOT NULL,
    monitor_id INTEGER REFERENCES monitors(id) ON DELETE SET NULL,
    kind       TEXT    NOT NULL,
    title      TEXT    NOT NULL,
    message    TEXT    NOT NULL,
    affected   TEXT    NOT NULL DEFAULT '[]',
    delivered  TEXT    NOT NULL DEFAULT '[]'
  );
  CREATE INDEX alerts_time ON alerts(time);

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // v2: monitor icons. `icon` is the spec chosen in the UI (see icons.js);
  // `icons` caches the image bytes for favicons, image URLs and uploads.
  `
  ALTER TABLE monitors ADD COLUMN icon TEXT NOT NULL DEFAULT '';

  CREATE TABLE icons (
    monitor_id INTEGER PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
    source     TEXT    NOT NULL,
    mime       TEXT,
    data       BLOB,
    error      TEXT    NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    checked_at INTEGER NOT NULL
  );
  `,
  // v3: tags (a name and a colour) and which monitors carry them.
  `
  CREATE TABLE tags (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL,
    color TEXT NOT NULL
  );
  CREATE UNIQUE INDEX tags_name ON tags(name COLLATE NOCASE);

  CREATE TABLE monitor_tags (
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (monitor_id, tag_id)
  );
  CREATE INDEX monitor_tags_tag ON monitor_tags(tag_id);
  `,
  // v4: a tag can give the monitors carrying it a default icon. `icon` is a
  // spec as for monitors; an uploaded image is kept with the tag.
  `
  ALTER TABLE tags ADD COLUMN icon TEXT NOT NULL DEFAULT '';
  ALTER TABLE tags ADD COLUMN icon_mime TEXT;
  ALTER TABLE tags ADD COLUMN icon_data BLOB;
  ALTER TABLE tags ADD COLUMN icon_updated_at INTEGER NOT NULL DEFAULT 0;
  `,
];

const TAG_COLS = 'id, name, color, icon, icon_updated_at AS iconV';

export const DEFAULT_SETTINGS = {
  retentionDays: 90,
};

const MONITOR_FIELDS = {
  name: 'name',
  type: 'type',
  interval: 'interval',
  retries: 'retries',
  retryInterval: 'retry_interval',
  timeout: 'timeout',
  resendInterval: 'resend_interval',
  parentMode: 'parent_mode',
  active: 'active',
  description: 'description',
  icon: 'icon',
};

function rowToMonitor(r) {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    config: JSON.parse(r.config),
    interval: r.interval,
    retries: r.retries,
    retryInterval: r.retry_interval,
    timeout: r.timeout,
    resendInterval: r.resend_interval,
    parentMode: r.parent_mode,
    active: Boolean(r.active),
    description: r.description,
    icon: r.icon,
    pushToken: r.push_token,
    createdAt: r.created_at,
  };
}

function rowToNotification(r) {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    config: JSON.parse(r.config),
    isDefault: Boolean(r.is_default),
    active: Boolean(r.active),
  };
}

export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');
    this.migrate();
    this.stmts = new Map();
  }

  migrate() {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get();
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  // Cached prepared statements.
  q(sql) {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close() {
    this.db.close();
  }

  // ---- monitors -----------------------------------------------------------

  listMonitors() {
    return this.q('SELECT * FROM monitors ORDER BY name COLLATE NOCASE').all().map(rowToMonitor);
  }

  getMonitor(id) {
    const r = this.q('SELECT * FROM monitors WHERE id = ?').get(id);
    return r ? rowToMonitor(r) : null;
  }

  getMonitorByPushToken(token) {
    const r = this.q('SELECT * FROM monitors WHERE push_token = ?').get(token);
    return r ? rowToMonitor(r) : null;
  }

  createMonitor(m) {
    const pushToken = m.type === 'push' ? crypto.randomBytes(12).toString('hex') : null;
    const res = this.q(
      `INSERT INTO monitors (name, type, config, interval, retries, retry_interval, timeout,
         resend_interval, parent_mode, active, description, icon, push_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      m.name, m.type, JSON.stringify(m.config ?? {}), m.interval, m.retries, m.retryInterval,
      m.timeout, m.resendInterval, m.parentMode, m.active ? 1 : 0, m.description ?? '',
      m.icon ?? '', pushToken, Date.now()
    );
    return Number(res.lastInsertRowid);
  }

  updateMonitor(id, m) {
    const sets = [];
    const vals = [];
    for (const [key, col] of Object.entries(MONITOR_FIELDS)) {
      if (m[key] === undefined) continue;
      sets.push(`${col} = ?`);
      vals.push(typeof m[key] === 'boolean' ? (m[key] ? 1 : 0) : m[key]);
    }
    if (m.config !== undefined) {
      sets.push('config = ?');
      vals.push(JSON.stringify(m.config));
    }
    if (m.type === 'push') {
      // keep an existing token; mint one if the type just changed to push
      sets.push("push_token = COALESCE(push_token, ?)");
      vals.push(crypto.randomBytes(12).toString('hex'));
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE monitors SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  setPushToken(id, token) {
    this.q('UPDATE monitors SET push_token = ? WHERE id = ?').run(token, id);
  }

  deleteMonitor(id) {
    this.q('DELETE FROM monitors WHERE id = ?').run(id);
  }

  // ---- hierarchy edges ----------------------------------------------------

  listEdges() {
    return this.q('SELECT parent_id AS parentId, child_id AS childId FROM monitor_edges').all()
      .map((e) => ({ parentId: e.parentId, childId: e.childId }));
  }

  addEdge(parentId, childId) {
    this.q('INSERT OR IGNORE INTO monitor_edges (parent_id, child_id) VALUES (?, ?)').run(parentId, childId);
  }

  removeEdge(parentId, childId) {
    this.q('DELETE FROM monitor_edges WHERE parent_id = ? AND child_id = ?').run(parentId, childId);
  }

  setParents(id, parentIds) {
    this.q('DELETE FROM monitor_edges WHERE child_id = ?').run(id);
    for (const p of parentIds) this.addEdge(p, id);
  }

  setChildren(id, childIds) {
    this.q('DELETE FROM monitor_edges WHERE parent_id = ?').run(id);
    for (const c of childIds) this.addEdge(id, c);
  }

  // ---- icons --------------------------------------------------------------

  listIconMeta() {
    return this.q(
      `SELECT monitor_id AS monitorId, source, data IS NOT NULL AS hasData,
              updated_at AS updatedAt, checked_at AS checkedAt FROM icons`
    ).all().map((r) => ({ ...r, hasData: Boolean(r.hasData) }));
  }

  getIcon(monitorId) {
    return this.q('SELECT mime, data FROM icons WHERE monitor_id = ? AND data IS NOT NULL').get(monitorId) ?? null;
  }

  setIcon(monitorId, i) {
    this.q(
      `INSERT INTO icons (monitor_id, source, mime, data, error, updated_at, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(monitor_id) DO UPDATE SET source = excluded.source, mime = excluded.mime, data = excluded.data,
         error = excluded.error, updated_at = excluded.updated_at, checked_at = excluded.checked_at`
    ).run(monitorId, i.source, i.mime ?? null, i.data ?? null, i.error ?? '', i.updatedAt, i.checkedAt);
  }

  markIconChecked(monitorId, checkedAt, error) {
    this.q('UPDATE icons SET checked_at = ?, error = ? WHERE monitor_id = ?').run(checkedAt, error ?? '', monitorId);
  }

  deleteIcon(monitorId) {
    this.q('DELETE FROM icons WHERE monitor_id = ?').run(monitorId);
  }

  // ---- tags ---------------------------------------------------------------

  listTags() {
    return this.q(`SELECT ${TAG_COLS} FROM tags ORDER BY name COLLATE NOCASE`).all().map((t) => ({ ...t }));
  }

  getTag(id) {
    const t = this.q(`SELECT ${TAG_COLS} FROM tags WHERE id = ?`).get(id);
    return t ? { ...t } : null;
  }

  findTagByName(name) {
    const t = this.q(`SELECT ${TAG_COLS} FROM tags WHERE name = ? COLLATE NOCASE`).get(name);
    return t ? { ...t } : null;
  }

  createTag(t) {
    return Number(this.q('INSERT INTO tags (name, color, icon) VALUES (?, ?, ?)').run(t.name, t.color, t.icon ?? '').lastInsertRowid);
  }

  // An uploaded image is dropped once the icon is no longer 'upload'.
  updateTag(id, t) {
    this.q(`UPDATE tags SET name = ?, color = ?, icon = ?,
            icon_mime = CASE WHEN ? = 'upload' THEN icon_mime END,
            icon_data = CASE WHEN ? = 'upload' THEN icon_data END
            WHERE id = ?`).run(t.name, t.color, t.icon ?? '', t.icon ?? '', t.icon ?? '', id);
  }

  setTagIcon(id, { mime, data }, now = Date.now()) {
    this.q('UPDATE tags SET icon_mime = ?, icon_data = ?, icon_updated_at = ? WHERE id = ?').run(mime, data, now, id);
  }

  getTagIcon(id) {
    return this.q('SELECT icon_mime AS mime, icon_data AS data FROM tags WHERE id = ? AND icon_data IS NOT NULL').get(id) ?? null;
  }

  deleteTag(id) {
    this.q('DELETE FROM tags WHERE id = ?').run(id);
  }

  // monitor id -> [tag ids], in tag name order
  monitorTagMap() {
    const out = new Map();
    const rows = this.q(
      `SELECT mt.monitor_id AS monitorId, mt.tag_id AS tagId FROM monitor_tags mt
       JOIN tags t ON t.id = mt.tag_id ORDER BY t.name COLLATE NOCASE`
    ).all();
    for (const r of rows) {
      if (!out.has(r.monitorId)) out.set(r.monitorId, []);
      out.get(r.monitorId).push(r.tagId);
    }
    return out;
  }

  monitorTagIds(monitorId) {
    return this.q('SELECT tag_id AS id FROM monitor_tags WHERE monitor_id = ?').all(monitorId).map((r) => r.id);
  }

  setMonitorTags(monitorId, tagIds) {
    this.q('DELETE FROM monitor_tags WHERE monitor_id = ?').run(monitorId);
    for (const t of tagIds) this.tagMonitor(monitorId, t);
  }

  tagMonitor(monitorId, tagId) {
    return this.q('INSERT OR IGNORE INTO monitor_tags (monitor_id, tag_id) VALUES (?, ?)').run(monitorId, tagId).changes;
  }

  untagMonitor(monitorId, tagId) {
    return this.q('DELETE FROM monitor_tags WHERE monitor_id = ? AND tag_id = ?').run(monitorId, tagId).changes;
  }

  // ---- heartbeats ---------------------------------------------------------

  addHeartbeat(hb) {
    const res = this.q(
      'INSERT INTO heartbeats (monitor_id, status, time, ping, msg, important) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(hb.monitorId, hb.status, hb.time, hb.ping ?? null, hb.msg ?? '', hb.important ? 1 : 0);
    return Number(res.lastInsertRowid);
  }

  recentHeartbeats(monitorId, limit) {
    return this.q(
      'SELECT status, time, ping, msg FROM heartbeats WHERE monitor_id = ? ORDER BY time DESC, id DESC LIMIT ?'
    ).all(monitorId, limit).reverse();
  }

  heartbeatsSince(monitorId, since) {
    return this.q(
      'SELECT status, time, ping, msg FROM heartbeats WHERE monitor_id = ? AND time >= ? ORDER BY time'
    ).all(monitorId, since);
  }

  importantHeartbeats(monitorId, limit) {
    return this.q(
      `SELECT status, time, ping, msg FROM heartbeats
       WHERE monitor_id = ? AND important = 1 ORDER BY time DESC LIMIT ?`
    ).all(monitorId, limit);
  }

  recentEvents(limit) {
    return this.q(
      `SELECT h.monitor_id AS monitorId, m.name, h.status, h.time, h.msg
       FROM heartbeats h JOIN monitors m ON m.id = h.monitor_id
       WHERE h.important = 1 ORDER BY h.time DESC LIMIT ?`
    ).all(limit);
  }

  // Up/down counts per monitor since `since`. Pending and blocked beats are
  // excluded: blocked means "unknown", so it should not count against uptime.
  uptimeSince(since) {
    const rows = this.q(
      `SELECT monitor_id AS id, SUM(status = 1) AS up, SUM(status = 0) AS down,
              AVG(CASE WHEN status = 1 THEN ping END) AS avgPing
       FROM heartbeats WHERE time >= ? GROUP BY monitor_id`
    ).all(since);
    const out = new Map();
    for (const r of rows) {
      const total = r.up + r.down;
      out.set(r.id, { uptime: total ? r.up / total : null, avgPing: r.avgPing });
    }
    return out;
  }

  pruneHeartbeats(before) {
    return this.q('DELETE FROM heartbeats WHERE time < ?').run(before).changes;
  }

  // ---- notifications ------------------------------------------------------

  listNotifications() {
    return this.q('SELECT * FROM notifications ORDER BY name COLLATE NOCASE').all().map(rowToNotification);
  }

  getNotification(id) {
    const r = this.q('SELECT * FROM notifications WHERE id = ?').get(id);
    return r ? rowToNotification(r) : null;
  }

  createNotification(n) {
    const res = this.q(
      'INSERT INTO notifications (name, type, config, is_default, active) VALUES (?, ?, ?, ?, ?)'
    ).run(n.name, n.type, JSON.stringify(n.config ?? {}), n.isDefault ? 1 : 0, n.active === false ? 0 : 1);
    return Number(res.lastInsertRowid);
  }

  updateNotification(id, n) {
    this.q(
      'UPDATE notifications SET name = ?, type = ?, config = ?, is_default = ?, active = ? WHERE id = ?'
    ).run(n.name, n.type, JSON.stringify(n.config ?? {}), n.isDefault ? 1 : 0, n.active === false ? 0 : 1, id);
  }

  deleteNotification(id) {
    this.q('DELETE FROM notifications WHERE id = ?').run(id);
  }

  monitorNotificationIds(monitorId) {
    return this.q('SELECT notification_id AS id FROM monitor_notifications WHERE monitor_id = ?')
      .all(monitorId).map((r) => r.id);
  }

  setMonitorNotifications(monitorId, ids) {
    this.q('DELETE FROM monitor_notifications WHERE monitor_id = ?').run(monitorId);
    for (const nid of ids) {
      this.q('INSERT OR IGNORE INTO monitor_notifications (monitor_id, notification_id) VALUES (?, ?)').run(monitorId, nid);
    }
  }

  // ---- alert log ----------------------------------------------------------

  logAlert(a) {
    this.q(
      'INSERT INTO alerts (time, monitor_id, kind, title, message, affected, delivered) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(a.time, a.monitorId, a.kind, a.title, a.message, JSON.stringify(a.affected ?? []), JSON.stringify(a.delivered ?? []));
  }

  listAlerts(limit) {
    return this.q('SELECT * FROM alerts ORDER BY time DESC, id DESC LIMIT ?').all(limit).map((r) => ({
      id: r.id,
      time: r.time,
      monitorId: r.monitor_id,
      kind: r.kind,
      title: r.title,
      message: r.message,
      affected: JSON.parse(r.affected),
      delivered: JSON.parse(r.delivered),
    }));
  }

  pruneAlerts(before) {
    this.q('DELETE FROM alerts WHERE time < ?').run(before);
  }

  // ---- settings -----------------------------------------------------------

  getSettings() {
    const out = { ...DEFAULT_SETTINGS };
    for (const r of this.q('SELECT key, value FROM settings').all()) out[r.key] = JSON.parse(r.value);
    return out;
  }

  setSettings(values) {
    for (const [k, v] of Object.entries(values)) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      this.q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(k, JSON.stringify(v));
    }
  }
}
