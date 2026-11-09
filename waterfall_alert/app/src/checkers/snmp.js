// SNMP (v1/v2c): up when the device answers a GET for its system group.
// Every check also collects what it advertises (interfaces with traffic
// rates, CPU, memory and disks, extra OIDs from the config) and returns it as
// `data`, which the engine keeps as the monitor's latest snapshot. Rates are
// worked out from the previous snapshot, which the engine passes back in.
import { SnmpClient, MISSING, isOid } from '../snmp.js';

const SYSTEM = {
  descr: '1.3.6.1.2.1.1.1.0',
  objectId: '1.3.6.1.2.1.1.2.0',
  uptime: '1.3.6.1.2.1.1.3.0',
  contact: '1.3.6.1.2.1.1.4.0',
  name: '1.3.6.1.2.1.1.5.0',
  location: '1.3.6.1.2.1.1.6.0',
};

// Interface columns (IF-MIB ifTable and ifXTable).
const IF_COLUMNS = {
  descr: '1.3.6.1.2.1.2.2.1.2',
  type: '1.3.6.1.2.1.2.2.1.3',
  speed: '1.3.6.1.2.1.2.2.1.5',
  mac: '1.3.6.1.2.1.2.2.1.6',
  admin: '1.3.6.1.2.1.2.2.1.7',
  oper: '1.3.6.1.2.1.2.2.1.8',
  inOctets32: '1.3.6.1.2.1.2.2.1.10',
  inErrors: '1.3.6.1.2.1.2.2.1.14',
  outOctets32: '1.3.6.1.2.1.2.2.1.16',
  outErrors: '1.3.6.1.2.1.2.2.1.20',
  name: '1.3.6.1.2.1.31.1.1.1.1',
  inOctets64: '1.3.6.1.2.1.31.1.1.1.6',
  outOctets64: '1.3.6.1.2.1.31.1.1.1.10',
  highSpeed: '1.3.6.1.2.1.31.1.1.1.15',
  alias: '1.3.6.1.2.1.31.1.1.1.18',
};

// HOST-RESOURCES-MIB: servers, NAS boxes and some firewalls have it.
const HR = {
  cpu: '1.3.6.1.2.1.25.3.3.1.2',
  storageType: '1.3.6.1.2.1.25.2.3.1.2',
  storageDescr: '1.3.6.1.2.1.25.2.3.1.3',
  storageUnits: '1.3.6.1.2.1.25.2.3.1.4',
  storageSize: '1.3.6.1.2.1.25.2.3.1.5',
  storageUsed: '1.3.6.1.2.1.25.2.3.1.6',
};
const STORAGE_KINDS = { 2: 'memory', 4: 'disk', 9: 'disk', 10: 'disk' }; // hrStorageRam, FixedDisk, FlashMemory, NetworkDisk
// Linux reports pseudo and container filesystems as fixed disks too.
const PSEUDO_MOUNT = /^\/(dev|proc|sys|run|etc|snap)(\/|$)/;
// UCD-SNMP-MIB ssCpuIdle: net-snmp's CPU idle %, for agents without
// hrProcessorLoad (or before it has a minute of samples).
const CPU_IDLE = '1.3.6.1.4.1.2021.11.11.0';

const OPER = { 1: 'up', 2: 'down', 3: 'testing', 4: 'unknown', 5: 'dormant', 6: 'notPresent', 7: 'lowerLayerDown' };
const IF_TYPES = { 1: 'Other', 6: 'Ethernet', 24: 'Loopback', 53: 'Virtual', 71: 'Wi-Fi', 117: 'Ethernet', 131: 'Tunnel', 135: 'VLAN', 136: 'VLAN', 161: 'LAG', 209: 'Bridge' };

// Config keys that only change what is shown, not what is checked: extra
// OIDs, items hidden from the monitor's page, and what the Falls card shows.
export const DISPLAY_KEYS = ['oids', 'hide', 'card'];
export const CARD_MAX = 2;

// Octet strings: text when they read as text, otherwise hex (MAC addresses).
export function octetText(buf, sep = ' ') {
  if (!Buffer.isBuffer(buf)) return buf == null ? '' : String(buf);
  const s = buf.toString('utf8');
  // eslint-disable-next-line no-control-regex
  if (!/[\x00-\x08\x0e-\x1f\x7f�]/.test(s.replace(/\0+$/, ''))) return s.replace(/\0+$/, '');
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join(sep);
}

// "Label = OID" (or just an OID) per line or separated by ";".
export function parseExtraOids(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/[\n;]/)) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.lastIndexOf('=');
    const label = i > 0 ? line.slice(0, i).trim() : '';
    const oid = (i > 0 ? line.slice(i + 1) : line).trim().replace(/^\./, '');
    if (!isOid(oid)) throw new Error(`"${line}" is not "Label = OID"`);
    out.push({ label: label || oid, oid });
  }
  return out;
}

const plain = (vb) => {
  if (!vb || MISSING.has(vb.type)) return null;
  if (vb.type === 'octets' || vb.type === 'opaque') return octetText(vb.value);
  return vb.value;
};

// Index (last arc) -> value for one walked column.
const byIndex = (vbs, base) => new Map(vbs.map((vb) => [vb.oid.slice(base.length + 1), vb]));

export async function checkSnmp(monitor, { previous } = {}) {
  const c = monitor.config ?? {};
  if (!c.host) throw new Error('Host is required');
  const extra = parseExtraOids(c.oids);
  const budget = monitor.timeout * 1000;
  const client = new SnmpClient({
    host: String(c.host).trim(),
    port: c.port,
    community: c.community || 'public',
    version: String(c.version) === '1' ? '1' : '2c',
    timeout: Math.max(500, budget / 2),
    retries: 1,
  });
  try {
    // The uptime check.
    const t0 = performance.now();
    const sys = await client.get(Object.values(SYSTEM));
    const ping = Math.round(performance.now() - t0);
    const system = Object.fromEntries(Object.keys(SYSTEM).map((k, i) => [k, plain(sys[i])]));
    if (system.uptime != null) system.uptime = Math.round(system.uptime / 100); // ticks -> seconds

    // The rest, best effort within what is left of the time allowed.
    const deadline = Date.now() + budget + 3000;
    const notes = [];
    const opts = () => ({ timeout: Math.max(300, Math.min(2500, deadline - Date.now())), retries: 1 });
    const walk = async (base) => {
      if (Date.now() > deadline) return [];
      try {
        return await client.walk(base, { opts: opts() });
      } catch (err) {
        notes.push(`${base}: ${err.message}`);
        return [];
      }
    };
    const cols = {};
    for (const [key, base] of Object.entries(IF_COLUMNS)) cols[key] = byIndex(await walk(base), base);
    const hr = {};
    for (const [key, base] of Object.entries(HR)) hr[key] = byIndex(await walk(base), base);
    if (!hr.cpu.size && Date.now() < deadline) {
      try {
        const [idle] = await client.get([CPU_IDLE], opts());
        if (typeof idle.value === 'number' && !MISSING.has(idle.type)) hr.idle = 100 - idle.value;
      } catch {
        // no UCD-SNMP-MIB either: no CPU
      }
    }
    let custom = [];
    if (extra.length && Date.now() < deadline) {
      try {
        const vbs = await client.get(extra.map((e) => e.oid), opts());
        custom = extra.map((e, i) => ({ ...e, type: vbs[i].type, value: plain(vbs[i]) }));
      } catch (err) {
        notes.push(`Extra values: ${err.message}`);
        custom = extra.map((e) => ({ ...e, type: 'error', value: null }));
      }
    }
    if (Date.now() > deadline) notes.push('Ran out of time; some values are missing');

    const at = Date.now();
    const interfaces = interfacesFrom(cols);
    addRates(interfaces, previous, at, system.uptime);
    const data = { at, system, interfaces, ...resourcesFrom(hr), custom, notes };
    return { ok: true, ping, msg: cardText(data, c) || 'SNMP OK', data };
  } finally {
    client.close();
  }
}

// ---- the Falls card --------------------------------------------------------

const compact = (n, unit = '') => {
  if (n == null) return '—';
  const [div, u] = [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k']].find(([d]) => n >= d) ?? [1, ''];
  const v = n / div;
  return `${v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1).replace(/\.0$/, '') : v.toFixed(2).replace(/\.?0+$/, '')}${u}${unit}`;
};

export function fmtUptime(s) {
  if (s == null) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

const hidden = (config, key) => (config?.hide ?? []).includes(key);
const counted = (data, config) => data.interfaces.filter((i) => i.admin === 'up' && i.kind !== 'Loopback' && !hidden(config, `if:${i.name}`));
const pct = (s) => Math.round((s.used / s.size) * 100);

// One item of the card, by key: name, uptime, ifs, cpu, memory, disk:<name>,
// if:<interface name>, value:<oid>. null if the data doesn't have it.
export function cardItem(data, key, config) {
  const [kind, ...rest] = key.split(':');
  const arg = rest.join(':');
  switch (kind) {
    case 'name': return data.system.name || null;
    case 'location': return data.system.location || null;
    case 'uptime': return data.system.uptime == null ? null : `up ${fmtUptime(data.system.uptime)}`;
    case 'ifs': {
      const list = counted(data, config);
      return list.length ? `${list.filter((i) => i.oper === 'up').length}/${list.length} links up` : null;
    }
    case 'cpu': return data.cpu ? `CPU ${data.cpu.load}%` : null;
    case 'memory': {
      const m = data.storage.find((s) => s.kind === 'memory');
      return m ? `Mem ${pct(m)}%` : null;
    }
    case 'disk': {
      const d = data.storage.find((s) => s.name === arg);
      return d ? `${d.name} ${pct(d)}%` : null;
    }
    case 'if': {
      const i = data.interfaces.find((x) => x.name === arg);
      if (!i) return null;
      return i.inBps == null ? `${i.name} ${i.oper}` : `${i.name} ↓${compact(i.inBps)} ↑${compact(i.outBps)}`;
    }
    case 'value': {
      const v = data.custom?.find((x) => x.oid === arg);
      return v && v.value != null ? `${v.label} ${v.value}` : null;
    }
    default: return null;
  }
}

// What the card in the Falls shows (and the check's message): the picked
// items, or how many interfaces are up.
export function cardText(data, config) {
  const keys = config?.card?.length ? config.card : ['name', 'ifs'];
  return keys.map((k) => cardItem(data, k, config)).filter(Boolean).join(' · ');
}

// ---- browsing everything --------------------------------------------------

// For the "All data" view: a page of everything the device reports, from
// `start` (exclusive) on. `next` is where the following page starts, or null.
export async function snmpBrowse(monitor, { start, limit = 2000 } = {}) {
  const c = monitor.config ?? {};
  const client = new SnmpClient({
    host: String(c.host).trim(),
    port: c.port,
    community: c.community || 'public',
    version: String(c.version) === '1' ? '1' : '2c',
    timeout: Math.min(3000, monitor.timeout * 1000),
    retries: 1,
  });
  try {
    const deadline = Date.now() + 20000;
    const rows = await client.walk('1.3.6.1', { start, max: limit, deadline });
    const entries = rows.map((vb) => ({
      oid: vb.oid,
      type: vb.type,
      value: vb.type === 'octets' || vb.type === 'opaque' ? octetText(vb.value) : vb.value,
    }));
    // a full page, or cut short by the deadline: there is more
    const more = entries.length && (entries.length >= limit || Date.now() > deadline);
    return { entries, next: more ? entries[entries.length - 1].oid : null };
  } finally {
    client.close();
  }
}

function interfacesFrom(cols) {
  const indexes = new Set([...cols.descr.keys(), ...cols.name.keys()]);
  const out = [];
  for (const index of indexes) {
    const v = (k) => plain(cols[k].get(index));
    const hc = cols.inOctets64.has(index);
    const high = v('highSpeed');
    const type = v('type');
    const macVb = cols.mac.get(index);
    out.push({
      index: Number(index),
      name: v('name') || v('descr') || `#${index}`,
      descr: v('descr') || '',
      alias: v('alias') || '',
      kind: IF_TYPES[type] ?? (type == null ? '' : `type ${type}`),
      mac: Buffer.isBuffer(macVb?.value) && macVb.value.length ? [...macVb.value].map((b) => b.toString(16).padStart(2, '0')).join(':') : '',
      admin: { 1: 'up', 2: 'down', 3: 'testing' }[v('admin')] ?? 'unknown',
      oper: OPER[v('oper')] ?? 'unknown',
      speed: high ? high * 1e6 : v('speed') ?? null, // bits per second
      inOctets: hc ? v('inOctets64') : v('inOctets32'),
      outOctets: hc ? v('outOctets64') : v('outOctets32'),
      hc,
      inErrors: v('inErrors'),
      outErrors: v('outErrors'),
      inBps: null,
      outBps: null,
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

// Bits per second since the previous snapshot. A 32-bit counter that went
// backwards wrapped; a 64-bit one (or a device that rebooted) was reset.
export function addRates(interfaces, previous, at, uptime) {
  if (!previous?.interfaces || previous.at == null || at <= previous.at) return;
  if (uptime != null && previous.system?.uptime != null && uptime < previous.system.uptime) return;
  const dt = (at - previous.at) / 1000;
  const before = new Map(previous.interfaces.map((i) => [i.index, i]));
  const rate = (now, was, hc) => {
    if (now == null || was == null) return null;
    let d = now - was;
    if (d < 0) {
      if (hc) return null;
      d += 2 ** 32;
    }
    return Math.round((d * 8) / dt);
  };
  for (const i of interfaces) {
    const p = before.get(i.index);
    if (!p || p.hc !== i.hc) continue;
    i.inBps = rate(i.inOctets, p.inOctets, i.hc);
    i.outBps = rate(i.outOctets, p.outOctets, i.hc);
  }
}

function resourcesFrom(hr) {
  const loads = [...hr.cpu.values()].map(plain).filter((n) => typeof n === 'number');
  const storage = [];
  for (const [index, typeVb] of hr.storageType) {
    const kind = STORAGE_KINDS[String(typeVb.value).split('.').pop()];
    const units = plain(hr.storageUnits.get(index)) || 1;
    const size = plain(hr.storageSize.get(index));
    const name = plain(hr.storageDescr.get(index)) || `#${index}`;
    if (!kind || !size || (kind === 'disk' && PSEUDO_MOUNT.test(name))) continue;
    storage.push({
      kind,
      name,
      size: size * units, // bytes
      used: (plain(hr.storageUsed.get(index)) ?? 0) * units,
    });
  }
  const cpu = loads.length ? { cores: loads.length, load: Math.round(loads.reduce((a, b) => a + b, 0) / loads.length) }
    : hr.idle != null ? { cores: null, load: Math.round(hr.idle) } : null;
  return {
    cpu,
    storage,
  };
}
