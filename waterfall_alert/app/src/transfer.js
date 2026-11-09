// CSV export and import of monitors. Both use the same columns, so an export
// can be imported as-is into another install (or back into this one).
// The full guide is docs/csv.md; keep it in step with CSV_COLUMNS.
import { Graph } from './graph.js';
import { MONITOR_TYPES } from './checkers/index.js';
import { decodeDataUrl } from './icons.js';
import { parseCsv, toCsv } from './csv.js';
import { normalizeMonitor, normalizeTag, TAG_COLORS } from './validate.js';

const SEP = '|';
const splitList = (cell) => cell.split(SEP).map((s) => s.trim()).filter(Boolean);
const joinList = (items) => items.join(` ${SEP} `);
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });

// Every column, in export order. `field` is a monitor field; `config` a key
// in monitor.config, used only by `types` (and required for `required`).
export const CSV_COLUMNS = [
  { name: 'key', help: 'Optional. The handle other rows use for this monitor in "parents". Defaults to the name, so it is only needed when two monitors share a name (exports fill it in for those).' },
  { name: 'name', required: MONITOR_TYPES, help: 'Display name. In update and skip mode, rows are matched to existing monitors by name.' },
  { name: 'type', values: MONITOR_TYPES, help: 'Required for new monitors.' },
  { name: 'parents', help: 'Parent monitors by key or name, separated by |. Can name monitors that already exist. Blank = top level.' },
  { name: 'parent_mode', field: 'parentMode', values: ['all', 'any'], def: 'all', help: 'With several parents: all = blocked when any parent is down; any = blocked only when every parent is down.' },
  { name: 'active', field: 'active', kind: 'bool', def: 'true', help: 'false = paused.' },
  { name: 'interval', field: 'interval', kind: 'int', def: '60', help: 'Seconds between checks, 10–86400.' },
  { name: 'retries', field: 'retries', kind: 'int', def: '1', help: 'Failures in a row before it counts as down, 0–20.' },
  { name: 'retry_interval', field: 'retryInterval', kind: 'int', def: '20', help: 'Seconds between retries, 5–86400.' },
  { name: 'timeout', field: 'timeout', kind: 'int', def: '10', help: 'Seconds, 1–300.' },
  { name: 'resend_interval', field: 'resendInterval', kind: 'int', def: '0', help: 'Remind every N down checks; 0 = alert once.' },
  { name: 'description', field: 'description', help: 'Free text.' },
  { name: 'icon', field: 'icon', help: 'Blank = automatic, none, builtin:<name>, emoji:<emoji>, url:<image URL>, or a data:image/… URL (how exports carry uploaded icons).' },
  { name: 'tags', help: 'Tag names separated by |, each optionally followed by its colour: Home #60a5fa | Media. Tags that don’t exist yet are created.' },
  { name: 'notifications', help: 'Notification channel names separated by |. Blank = the channels marked as default; none = no channels. Channels are not exported (they hold secrets), so create them first.' },
  { name: 'url', config: 'url', types: ['http'], required: ['http'], help: 'The URL to request.' },
  { name: 'method', config: 'method', types: ['http'], values: ['GET', 'HEAD', 'POST', 'PUT'], def: 'GET' },
  { name: 'accepted_codes', config: 'acceptedCodes', types: ['http'], def: '200-299', help: 'Status codes and ranges, e.g. 200-299,301.' },
  { name: 'keyword', config: 'keyword', types: ['http'], help: 'Down unless the response body contains this text.' },
  { name: 'invert_keyword', config: 'invertKeyword', types: ['http'], kind: 'bool', help: 'true = down if the keyword is present.' },
  { name: 'ignore_tls', config: 'ignoreTls', types: ['http'], kind: 'bool', help: 'true = ignore certificate errors.' },
  { name: 'headers', config: 'headers', types: ['http'], help: 'Request headers as JSON, e.g. {"Authorization": "Bearer …"}.' },
  { name: 'body', config: 'body', types: ['http'], help: 'Request body.' },
  { name: 'host', config: 'host', types: ['tcp', 'ping', 'minecraft', 'snmp'], required: ['tcp', 'ping', 'minecraft', 'snmp'], help: 'Host name or IP address. For Minecraft, the address you type into the game.' },
  { name: 'port', config: 'port', types: ['tcp', 'minecraft', 'snmp'], required: ['tcp'], help: 'For Minecraft, blank = follow the SRV record (or 25565). For SNMP, blank = 161.' },
  { name: 'hostname', config: 'hostname', types: ['dns'], required: ['dns'], help: 'The name to resolve.' },
  { name: 'record_type', config: 'recordType', types: ['dns'], values: ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV'], def: 'A' },
  { name: 'server', config: 'server', types: ['dns'], help: 'Resolver to ask, e.g. 1.1.1.1. Blank = the system resolver.' },
  { name: 'expected', config: 'expected', types: ['dns'], help: 'Down unless an answer contains this. SRV answers read as target:port.' },
  { name: 'entity_id', config: 'entityId', types: ['ha_entity'], required: ['ha_entity'], help: 'e.g. binary_sensor.nas_online.' },
  { name: 'expected_state', config: 'expectedState', types: ['ha_entity'], help: 'Comma separated. Blank = up unless unavailable or unknown.' },
  { name: 'snmp_version', config: 'version', types: ['snmp'], values: ['2c', '1'], def: '2c' },
  { name: 'community', config: 'community', types: ['snmp'], help: 'SNMP read community. Blank = public. Exported as plain text.' },
  { name: 'snmp_oids', config: 'oids', types: ['snmp'], help: 'Extra values to read, as Label = OID, separated by ; or new lines.' },
  { name: 'snmp_hide', config: 'hide', types: ['snmp'], kind: 'list', help: 'Items left off the monitor’s page, separated by |, e.g. if:Gi1/0/48 | section:resources.' },
  { name: 'snmp_card', config: 'card', types: ['snmp'], kind: 'list', help: 'Up to 2 values the card in the Falls shows, separated by |, e.g. cpu | if:eth0. Blank = name and links up.' },
  { name: 'push_token', types: ['push'], help: 'The secret in the push URL. Keep it to keep the URL the same on another install; blank = generate a new one.' },
];
const COLUMN = new Map(CSV_COLUMNS.map((c) => [c.name, c]));

export const csvTemplate = () => toCsv([CSV_COLUMNS.map((c) => c.name)]);

const EXAMPLE_ROWS = [
  { name: 'WAN', type: 'ping', host: '1.1.1.1', icon: 'builtin:globe', tags: 'Network #60a5fa', description: 'Internet connection' },
  { name: 'Router', type: 'ping', parents: 'WAN', host: '192.168.1.1', icon: 'builtin:router', tags: 'Network' },
  { name: 'NAS', type: 'http', parents: 'Router', url: 'http://192.168.1.20:5000/', icon: 'builtin:nas', tags: 'Home #a78bfa' },
  { name: 'Plex', type: 'tcp', parents: 'NAS', host: '192.168.1.20', port: '32400', tags: 'Home | Media #e879f9' },
  { name: 'Nightly backup', type: 'push', parents: 'NAS', interval: '90000', retries: '0', tags: 'Home' },
  { name: 'Front door camera', type: 'ha_entity', parents: 'Router', entity_id: 'binary_sensor.front_door_camera_online', expected_state: 'on', icon: 'builtin:camera' },
  { name: 'Website DNS', type: 'dns', parents: 'WAN', hostname: 'example.com', record_type: 'A' },
  { name: 'Website', type: 'http', parents: 'WAN | Website DNS', parent_mode: 'all', url: 'https://example.com/health', accepted_codes: '200-299', keyword: 'ok' },
  { name: 'Minecraft', type: 'minecraft', parents: 'WAN', host: 'mc.example.net', icon: '' },
  { name: 'Core switch', type: 'snmp', parents: 'Router', host: '192.168.1.2', snmp_version: '2c', community: 'public', snmp_oids: 'Temperature = 1.3.6.1.4.1.9.9.13.1.3.1.3.1', icon: 'builtin:switch' },
];
export const CSV_EXAMPLE = toCsv([CSV_COLUMNS.map((c) => c.name), ...EXAMPLE_ROWS.map((r) => CSV_COLUMNS.map((c) => r[c.name] ?? ''))]);

// ---- export ---------------------------------------------------------------

export function exportCsv(store) {
  const monitors = store.listMonitors();
  const byId = new Map(monitors.map((m) => [m.id, m]));
  const graph = new Graph(monitors.map((m) => m.id), store.listEdges());
  const tagById = new Map(store.listTags().map((t) => [t.id, t]));
  const tagMap = store.monitorTagMap();
  const channelName = new Map(store.listNotifications().map((n) => [n.id, n.name]));

  // A monitor's handle is its name, unless another monitor has the same name
  // or the name contains the list separator.
  const seen = new Map();
  for (const m of monitors) seen.set(m.name, (seen.get(m.name) ?? 0) + 1);
  const ref = new Map(monitors.map((m) => [m.id,
    seen.get(m.name) > 1 || m.name.includes(SEP) ? `${m.name.replaceAll(SEP, '/')} #${m.id}` : m.name]));

  // Parents before children where possible: depth-first from the top.
  const order = [];
  const visited = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    visited.add(id);
    order.push(byId.get(id));
    graph.childrenOf(id).map((c) => byId.get(c)).sort(byName).forEach((c) => visit(c.id));
  };
  graph.roots().map((id) => byId.get(id)).sort(byName).forEach((m) => visit(m.id));

  const cell = (m, c) => {
    switch (c.name) {
      case 'key': return ref.get(m.id) === m.name ? '' : ref.get(m.id);
      case 'name': return m.name;
      case 'type': return m.type;
      case 'parents': return joinList(graph.parentsOf(m.id).map((p) => ref.get(p)));
      case 'icon': {
        const img = m.icon === 'upload' ? store.getIcon(m.id) : null;
        return img ? `data:${img.mime};base64,${Buffer.from(img.data).toString('base64')}` : m.icon;
      }
      case 'tags': return joinList((tagMap.get(m.id) ?? []).map((t) => tagById.get(t)).map((t) => `${t.name} ${t.color}`));
      case 'notifications': {
        const names = store.monitorNotificationIds(m.id).map((id) => channelName.get(id)).filter(Boolean);
        return names.length ? joinList(names) : 'none';
      }
      case 'push_token': return m.type === 'push' ? m.pushToken ?? '' : '';
      default:
    }
    if (c.field) return c.kind === 'bool' ? String(Boolean(m[c.field])) : m[c.field];
    if (!c.types.includes(m.type)) return '';
    const v = m.config[c.config];
    if (c.kind === 'list') return Array.isArray(v) ? v.join(' | ') : '';
    return c.kind === 'bool' ? String(Boolean(v)) : v ?? '';
  };
  return toCsv([CSV_COLUMNS.map((c) => c.name), ...order.map((m) => CSV_COLUMNS.map((c) => cell(m, c)))]);
}

// ---- import ---------------------------------------------------------------

class Rollback extends Error {}

function parseBool(raw, column) {
  const v = raw.toLowerCase();
  if (['true', 'yes', 'y', '1', 'on'].includes(v)) return true;
  if (['false', 'no', 'n', '0', 'off'].includes(v)) return false;
  throw new Error(`${column} must be true or false, not "${raw}"`);
}

function pickValue(c, raw) {
  const hit = c.values.find((x) => x.toLowerCase() === raw.toLowerCase());
  if (!hit) throw new Error(`${c.name} must be one of ${c.values.join(', ')}, not "${raw}"`);
  return hit;
}

// Modes, for rows whose name matches an existing monitor:
//   add    - create it anyway (names are not unique)
//   update - overwrite the existing monitor with the columns in the file
//   skip   - leave the existing monitor alone
// Columns missing from the file keep their current value (update) or get
// the default (new monitors). Everything happens in one transaction, which
// is rolled back on any error, or always with `dryRun`.
export function importCsv(store, text, { mode = 'add', dryRun = false } = {}) {
  const result = { ok: false, applied: false, created: 0, updated: 0, skipped: 0, tagsCreated: 0, errors: [], warnings: [], affected: [], uploads: [] };
  const error = (line, message) => result.errors.push({ line, message });
  const warn = (line, message) => result.warnings.push({ line, message });

  let records;
  try {
    records = parseCsv(text).filter((r) => r.cells.some((c) => c.trim()));
  } catch (err) {
    error(null, err.message);
    return result;
  }
  if (!records.length) {
    error(null, 'The file is empty');
    return result;
  }
  const header = records.shift();
  const cols = header.cells.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  cols.forEach((c, i) => {
    if (c && !COLUMN.has(c)) warn(header.line, `Unknown column "${header.cells[i]}" is ignored`);
    if (c && cols.indexOf(c) !== i) error(header.line, `The "${c}" column appears twice`);
  });
  if (!cols.includes('name')) error(header.line, 'There is no "name" column');
  if (!records.length) error(null, 'There are no monitors in the file, only the header');
  if (result.errors.length) return result;
  const has = (name) => cols.includes(name);
  const rows = records.map((r) => {
    const v = {};
    cols.forEach((c, i) => {
      if (COLUMN.has(c)) v[c] = (r.cells[i] ?? '').trim();
    });
    return { line: r.line, v, id: null, match: null, bad: false };
  });

  try {
    store.tx(() => {
      const existing = new Map();
      for (const m of store.listMonitors()) existing.set(m.name, [...(existing.get(m.name) ?? []), m]);
      const channels = new Map(store.listNotifications().map((n) => [n.name.toLowerCase(), n]));
      const defaultChannels = store.listNotifications().filter((n) => n.isDefault).map((n) => n.id);
      const fileKeys = new Map();
      const fileNames = new Map();

      // Who is who.
      for (const row of rows) {
        const { name } = row.v;
        if (!name) {
          error(row.line, 'Name is required');
          row.bad = true;
          continue;
        }
        row.key = row.v.key || name;
        const other = fileKeys.get(row.key);
        if (other) {
          error(row.line, `"${row.key}" is also used on line ${other.line}. Give one of them a different key`);
          row.bad = true;
          continue;
        }
        fileKeys.set(row.key, row);
        fileNames.set(name, [...(fileNames.get(name) ?? []), row]);
        const matches = mode === 'add' ? [] : existing.get(name) ?? [];
        if (matches.length > 1) {
          error(row.line, `${matches.length} existing monitors are called "${name}", so it can't be matched. Rename them or import in "add" mode`);
          row.bad = true;
          continue;
        }
        row.match = matches[0] ?? null;
      }

      let tagCount = store.listTags().length;
      const tagFor = (spec) => {
        const [, name, color] = /^(.*?)\s*(#[0-9a-f]{6})?$/i.exec(spec);
        const found = store.findTagByName(name.trim());
        if (found) return found.id;
        const t = normalizeTag({ name, color: color ?? TAG_COLORS[tagCount % TAG_COLORS.length] });
        tagCount++;
        result.tagsCreated++;
        return store.createTag(t);
      };

      const writeRow = (row) => {
        const { v } = row;
        const base = row.match;
        const type = v.type ? pickValue(COLUMN.get('type'), v.type) : base?.type;
        if (!type) throw new Error('Type is required for a new monitor');

        const body = { name: v.name, type };
        for (const c of CSV_COLUMNS) {
          if (!c.field || c.name === 'icon' || !has(c.name)) continue;
          const raw = v[c.name] === '' ? c.def ?? '' : v[c.name];
          if (c.kind === 'int' && !/^\d+$/.test(raw)) throw new Error(`${c.name} must be a whole number, not "${raw}"`);
          body[c.field] = c.kind === 'bool' ? parseBool(raw, c.name) : c.values ? pickValue(c, raw) : raw;
        }

        const config = base && base.type === type ? { ...base.config } : {};
        for (const c of CSV_COLUMNS) {
          if (!c.config || !has(c.name)) continue;
          const raw = v[c.name];
          if (!c.types.includes(type)) {
            if (raw) warn(row.line, `${c.name} doesn't apply to ${type} monitors and is ignored`);
            continue;
          }
          if (raw === '') delete config[c.config];
          else if (c.kind === 'list') config[c.config] = raw.split('|').map((x) => x.trim()).filter(Boolean);
          else config[c.config] = c.kind === 'bool' ? parseBool(raw, c.name) : c.values ? pickValue(c, raw) : raw;
        }
        for (const c of CSV_COLUMNS) {
          if (!c.config || !c.types.includes(type)) continue;
          if (config[c.config] == null && c.def != null) config[c.config] = c.def;
          if (c.required?.includes(type) && !String(config[c.config] ?? '').trim()) throw new Error(`${c.name} is required for ${type} monitors`);
        }
        body.config = config;

        let upload = null;
        if (has('icon')) {
          const raw = v.icon;
          if (/^data:/i.test(raw)) {
            upload = decodeDataUrl(raw);
            body.icon = 'upload';
          } else if (raw === 'upload' && base?.icon !== 'upload') {
            warn(row.line, 'icon "upload" needs the image itself (a data:image/… URL); using the automatic icon');
            body.icon = '';
          } else body.icon = raw;
        }

        const data = normalizeMonitor(body, base);
        if (base) {
          store.updateMonitor(base.id, data);
          row.id = base.id;
          result.updated++;
        } else {
          row.id = store.createMonitor(data);
          result.created++;
        }
        result.affected.push(row.id);
        if (upload) result.uploads.push({ id: row.id, img: upload });

        if (type === 'push' && v.push_token) {
          const owner = store.getMonitorByPushToken(v.push_token);
          if (!/^[\w-]{8,64}$/.test(v.push_token)) warn(row.line, 'push_token should be 8–64 letters, digits, _ or -; a new one was generated');
          else if (owner && owner.id !== row.id) warn(row.line, `push_token is already used by "${owner.name}"; a new one was generated`);
          else store.setPushToken(row.id, v.push_token);
        }

        if (has('notifications') || !base) {
          const raw = v.notifications ?? '';
          let ids = defaultChannels;
          if (raw.toLowerCase() === 'none') ids = [];
          else if (raw) {
            ids = splitList(raw).flatMap((n) => {
              const ch = channels.get(n.toLowerCase());
              if (!ch) warn(row.line, `There is no notification channel called "${n}"; skipped`);
              return ch ? [ch.id] : [];
            });
          }
          store.setMonitorNotifications(row.id, ids);
        }

        if (has('tags')) store.setMonitorTags(row.id, [...new Set(splitList(v.tags).map(tagFor))]);
      };

      for (const row of rows) {
        if (row.bad) continue;
        if (row.match && mode === 'skip') {
          row.id = row.match.id;
          result.skipped++;
          continue;
        }
        try {
          writeRow(row);
        } catch (err) {
          error(row.line, err.message);
          row.bad = true;
        }
      }

      // Parents, now that every row has an id. References are tried as a
      // key in the file, a name in the file, then an existing monitor.
      const resolve = (ref, row) => {
        const keyed = fileKeys.get(ref);
        if (keyed) return keyed.bad ? null : keyed.id;
        const named = fileNames.get(ref) ?? existing.get(ref) ?? [];
        if (named.length === 1) return named[0].bad ? null : named[0].id;
        error(row.line, named.length
          ? `Parent "${ref}" is ambiguous: ${named.length} monitors have that name. Give them keys and use those`
          : `Parent "${ref}" isn't in the file and no monitor has that name`);
        return null;
      };
      for (const row of rows) {
        if (row.bad || !has('parents') || (row.match && mode === 'skip')) continue;
        const ids = [];
        for (const ref of splitList(row.v.parents)) {
          const id = resolve(ref, row);
          if (id === row.id) error(row.line, 'A monitor cannot be its own parent');
          else if (id != null && !ids.includes(id)) ids.push(id);
        }
        store.setParents(row.id, ids);
      }

      if (new Graph(store.listMonitors().map((m) => m.id), store.listEdges()).hasCycle()) {
        error(null, 'The parents form a loop: some monitor would end up upstream of itself');
      }
      if (result.errors.length || dryRun) throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  result.errors.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  result.ok = !result.errors.length;
  result.applied = result.ok && !dryRun;
  if (!result.applied) {
    result.affected = [];
    result.uploads = [];
  }
  return result;
}
