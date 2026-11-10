import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

export const MIGRATIONS = [
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
  // v5: the latest data a check collected (SNMP), as JSON.
  `
  CREATE TABLE monitor_data (
    monitor_id INTEGER PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
    updated_at INTEGER NOT NULL,
    data       TEXT NOT NULL
  );
  `,
  // v6: MIB modules uploaded to the MIB library, one row per module.
  `
  CREATE TABLE mibs (
    name     TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    text     TEXT NOT NULL,
    added_at INTEGER NOT NULL
  );
  `,
  // v7: notification rules. "Alert <channels> when <problems> for <tags>"
  // replaces choosing channels on each monitor. Problems are objects of their
  // own; for now there is the one built in (a monitor is down). The old
  // per-monitor choices become rules: a channel every monitor used is sent
  // everything, and a channel only some used gets a tag on those monitors.
  (db) => {
    db.exec(`
    CREATE TABLE problems (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      kind   TEXT NOT NULL,
      name   TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}'
    );
    INSERT INTO problems (kind, name, config) VALUES ('down', 'Monitor down', '{"recovery":true}');

    CREATE TABLE notification_rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_ids TEXT    NOT NULL DEFAULT '[]',
      problem_ids TEXT    NOT NULL DEFAULT '[]',
      tag_ids     TEXT    NOT NULL DEFAULT '[]',
      tag_match   TEXT    NOT NULL DEFAULT 'any',
      tag_expr    TEXT    NOT NULL DEFAULT '',
      downstream  INTEGER NOT NULL DEFAULT 1
    );
    `);
    const monitors = db.prepare('SELECT id FROM monitors').all().map((r) => r.id);
    const channels = db.prepare('SELECT id, name, is_default FROM notifications ORDER BY id').all();
    const uses = new Map(channels.map((c) => [c.id, []]));
    for (const r of db.prepare('SELECT monitor_id, notification_id FROM monitor_notifications ORDER BY monitor_id').all()) {
      uses.get(r.notification_id)?.push(r.monitor_id);
    }
    const everyone = [];
    const groups = new Map(); // the same monitors -> channels
    for (const c of channels) {
      const ids = uses.get(c.id);
      if (monitors.length ? ids.length === monitors.length : c.is_default) everyone.push(c.id);
      else if (ids.length) {
        const key = ids.join(',');
        if (!groups.has(key)) groups.set(key, { monitors: ids, channels: [] });
        groups.get(key).channels.push(c);
      }
    }
    const addRule = db.prepare('INSERT INTO notification_rules (channel_ids, tag_ids, downstream) VALUES (?, ?, ?)');
    if (everyone.length) addRule.run(JSON.stringify(everyone), '[]', 1);
    const taken = new Set(db.prepare('SELECT name FROM tags').all().map((t) => t.name.toLowerCase()));
    const addTag = db.prepare("INSERT INTO tags (name, color) VALUES (?, '#94a3b8')");
    const tagMonitor = db.prepare('INSERT OR IGNORE INTO monitor_tags (monitor_id, tag_id) VALUES (?, ?)');
    for (const g of groups.values()) {
      const base = `Alerts: ${g.channels.map((c) => c.name).join(', ')}`;
      let name = base;
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (${n})`;
      taken.add(name.toLowerCase());
      const tagId = Number(addTag.run(name).lastInsertRowid);
      for (const m of g.monitors) tagMonitor.run(m, tagId);
      // Before, only the monitor at fault chose; keep it that way.
      addRule.run(JSON.stringify(g.channels.map((c) => c.id)), JSON.stringify([tagId]), 0);
    }
    db.exec('DROP TABLE monitor_notifications; ALTER TABLE notifications DROP COLUMN is_default;');
  },
  // v8: problems get a severity, and value problems (kind 'value') keep an
  // open/ok/unknown state per monitor. Rules can ask for "this severe or worse".
  `
  ALTER TABLE problems ADD COLUMN severity TEXT NOT NULL DEFAULT 'warning';
  UPDATE problems SET severity = 'severe' WHERE kind = 'down';
  CREATE TABLE problem_state (
    problem_id INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    state      TEXT    NOT NULL,
    since      INTEGER NOT NULL,
    value      TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (problem_id, monitor_id)
  );
  ALTER TABLE notification_rules ADD COLUMN min_severity TEXT NOT NULL DEFAULT '';
  ALTER TABLE alerts ADD COLUMN problem_id INTEGER;
  ALTER TABLE alerts ADD COLUMN severity TEXT;
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
    active: Boolean(r.active),
  };
}

function rowToRule(r) {
  return {
    id: r.id,
    channelIds: JSON.parse(r.channel_ids),
    problemIds: JSON.parse(r.problem_ids),
    minSeverity: r.min_severity ?? '',
    tagIds: JSON.parse(r.tag_ids),
    tagMatch: r.tag_match,
    tagExpr: r.tag_expr,
    downstream: Boolean(r.downstream),
  };
}

const rowToProblem = (r) => ({ id: r.id, kind: r.kind, name: r.name, severity: r.kind === 'down' ? 'severe' : r.severity, config: JSON.parse(r.config) });

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
        if (typeof MIGRATIONS[v] === 'function') MIGRATIONS[v](this.db);
        else this.db.exec(MIGRATIONS[v]);
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

  // ---- collected data (SNMP) --------------------------------------------

  setMonitorData(id, data, now) {
    this.q('INSERT INTO monitor_data (monitor_id, updated_at, data) VALUES (?, ?, ?) ON CONFLICT(monitor_id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data')
      .run(id, now, JSON.stringify(data));
  }

  // { at, data } or null.
  getMonitorData(id) {
    const row = this.q('SELECT updated_at, data FROM monitor_data WHERE monitor_id = ?').get(id);
    return row ? { at: row.updated_at, data: JSON.parse(row.data) } : null;
  }

  clearMonitorData(id) {
    this.q('DELETE FROM monitor_data WHERE monitor_id = ?').run(id);
  }

  // ---- hierarchy edges ----------------------------------------------------

  // ---- MIB library ------------------------------------------------------

  listMibs() {
    return this.q('SELECT name, filename, text, added_at AS addedAt FROM mibs ORDER BY name').all();
  }

  putMib({ name, filename, text }, now = Date.now()) {
    this.q('INSERT INTO mibs (name, filename, text, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET filename = excluded.filename, text = excluded.text, added_at = excluded.added_at')
      .run(name, filename, text, now);
  }

  deleteMib(name) {
    return this.q('DELETE FROM mibs WHERE name = ?').run(name).changes > 0;
  }

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
      'INSERT INTO notifications (name, type, config, active) VALUES (?, ?, ?, ?)'
    ).run(n.name, n.type, JSON.stringify(n.config ?? {}), n.active === false ? 0 : 1);
    return Number(res.lastInsertRowid);
  }

  updateNotification(id, n) {
    this.q(
      'UPDATE notifications SET name = ?, type = ?, config = ?, active = ? WHERE id = ?'
    ).run(n.name, n.type, JSON.stringify(n.config ?? {}), n.active === false ? 0 : 1, id);
  }

  deleteNotification(id) {
    this.q('DELETE FROM notifications WHERE id = ?').run(id);
  }

  // ---- notification rules and problems -------------------------------------

  listRules() {
    return this.q('SELECT * FROM notification_rules ORDER BY id').all().map(rowToRule);
  }

  getRule(id) {
    const r = this.q('SELECT * FROM notification_rules WHERE id = ?').get(id);
    return r ? rowToRule(r) : null;
  }

  #ruleValues(r) {
    return [JSON.stringify(r.channelIds ?? []), JSON.stringify(r.problemIds ?? []), JSON.stringify(r.tagIds ?? []),
      r.tagMatch === 'all' ? 'all' : 'any', r.tagExpr ?? '', r.downstream === false ? 0 : 1, r.minSeverity ?? ''];
  }

  createRule(r) {
    return Number(this.q(
      'INSERT INTO notification_rules (channel_ids, problem_ids, tag_ids, tag_match, tag_expr, downstream, min_severity) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(...this.#ruleValues(r)).lastInsertRowid);
  }

  updateRule(id, r) {
    this.q(
      'UPDATE notification_rules SET channel_ids = ?, problem_ids = ?, tag_ids = ?, tag_match = ?, tag_expr = ?, downstream = ?, min_severity = ? WHERE id = ?'
    ).run(...this.#ruleValues(r), id);
  }

  deleteRule(id) {
    return this.q('DELETE FROM notification_rules WHERE id = ?').run(id).changes > 0;
  }

  listProblems() {
    return this.q('SELECT * FROM problems ORDER BY id').all().map(rowToProblem);
  }

  getProblem(id) {
    const r = this.q('SELECT * FROM problems WHERE id = ?').get(id);
    return r ? rowToProblem(r) : null;
  }

  createProblem(p) {
    return Number(this.q('INSERT INTO problems (kind, name, severity, config) VALUES (?, ?, ?, ?)')
      .run(p.kind, p.name, p.severity ?? 'warning', JSON.stringify(p.config ?? {})).lastInsertRowid);
  }

  updateProblem(id, p) {
    this.q('UPDATE problems SET name = ?, severity = ?, config = ? WHERE id = ?').run(p.name, p.severity ?? 'warning', JSON.stringify(p.config ?? {}), id);
  }

  deleteProblem(id) {
    return this.q("DELETE FROM problems WHERE id = ? AND kind != 'down'").run(id).changes > 0;
  }

  // Value problems' state per monitor: [{ problemId, monitorId, state, since, value }].
  listProblemState() {
    return this.q('SELECT * FROM problem_state').all()
      .map((r) => ({ problemId: r.problem_id, monitorId: r.monitor_id, state: r.state, since: r.since, value: r.value }));
  }

  setProblemState(s) {
    this.q(`INSERT INTO problem_state (problem_id, monitor_id, state, since, value) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (problem_id, monitor_id) DO UPDATE SET state = excluded.state, since = excluded.since, value = excluded.value`)
      .run(s.problemId, s.monitorId, s.state, s.since, s.value ?? '');
  }

  deleteProblemState(problemId, monitorId) {
    this.q('DELETE FROM problem_state WHERE problem_id = ? AND monitor_id = ?').run(problemId, monitorId);
  }

  // ---- alert log ----------------------------------------------------------

  logAlert(a) {
    this.q(
      'INSERT INTO alerts (time, monitor_id, kind, title, message, affected, delivered, problem_id, severity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(a.time, a.monitorId, a.kind, a.title, a.message, JSON.stringify(a.affected ?? []), JSON.stringify(a.delivered ?? []), a.problemId ?? null, a.severity ?? null);
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
      problemId: r.problem_id,
      severity: r.severity,
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
