// What an SNMP monitor collected (GET api/monitors/:id/data), for the Falls'
// details panel (snmpSummary), the monitor's page (snmpSections) and the
// "All data" browser (renderSnmpBrowser). How it is shown (extra OIDs,
// hidden items, what the Falls card says) is the monitor's `display`, saved
// with PUT api/monitors/:id/snmp-display.
import { api, h, fill, fmtAgo, toast, confirmDialog } from './util.js';
import { oidName, oidGroup } from './snmp-names.js';
import { pickValueDialog } from './problems.js';

export const CARD_MAX = 2;

// ---- data -------------------------------------------------------------------

// The snapshot is fetched again only when the monitor has been checked since
// (`key` = its lastCheck). Returns what is cached now ({ at, data, display },
// or undefined the first time) and calls onLoad() when a newer one arrives.
const cache = new Map();
export function snmpSnapshot(id, key, onLoad) {
  const had = cache.get(id);
  if (had && had.key === key) return had.value;
  const entry = { key, value: had?.value };
  cache.set(id, entry);
  api(`monitors/${id}/data`).then((v) => {
    if (cache.get(id) !== entry) return;
    entry.value = v;
    onLoad();
  }).catch(() => {});
  return entry.value;
}

// Change display settings: shown at once, then saved (the server checks the
// monitor again, so its card text follows).
export async function saveDisplay(id, patch, rerender) {
  const snap = cache.get(id)?.value;
  const before = snap?.display;
  if (snap) snap.display = { ...before, ...patch };
  rerender();
  try {
    const display = await api(`monitors/${id}/snmp-display`, { method: 'PUT', body: patch });
    if (snap) snap.display = display;
  } catch (err) {
    if (snap) snap.display = before;
    toast(err.message, 'error');
    rerender();
  }
}

// Same format as the server: "Label = OID" per line (or ";").
function parseExtra(text) {
  return String(text ?? '').split(/[\n;]/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const i = line.lastIndexOf('=');
    const oid = (i > 0 ? line.slice(i + 1) : line).trim().replace(/^\./, '');
    return { label: i > 0 ? line.slice(0, i).trim() : oid, oid };
  });
}
const formatExtra = (list) => list.map((e) => (e.label && e.label !== e.oid ? `${e.label} = ${e.oid}` : e.oid)).join('\n');

// ---- formatting -------------------------------------------------------------

const UNITS = [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k']];
const short = (n) => (n >= 100 ? Math.round(n) : n >= 10 ? n.toFixed(1).replace(/\.0$/, '') : n.toFixed(2).replace(/\.?0+$/, ''));

export function fmtBps(b) {
  if (b == null) return '—';
  const [div, unit] = UNITS.find(([d]) => b >= d) ?? [1, ''];
  return `${short(b / div)} ${unit}bps`;
}

export function fmtBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${short(n)} ${units[i]}`;
}

export function fmtUptime(s) {
  if (s == null) return '—';
  const d = Math.floor(s / 86400);
  const hr = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${hr}h`;
  if (hr) return `${hr}h ${m}m`;
  return `${m}m`;
}

// ---- pieces -----------------------------------------------------------------

const isHidden = (display, key) => (display?.hide ?? []).includes(key);
const onCard = (display, key) => (display?.card ?? []).includes(key);

// Interfaces worth counting: enabled, not loopbacks, not hidden.
const counted = (d, display) => d.interfaces.filter((i) => i.admin === 'up' && i.kind !== 'Loopback' && !isHidden(display, `if:${i.name}`));
// Dot classes: a port that is down is usually just unplugged, so it gets the
// quiet hollow dot rather than the alarming red one.
const ifState = (i) => (i.admin !== 'up' ? 'paused' : i.oper === 'up' ? 'up' : i.oper === 'dormant' ? 'pending' : 'blocked');
const IF_LABEL = { up: 'Up', blocked: 'Down (no link)', pending: 'Dormant', paused: 'Disabled' };

function meter(fraction, title) {
  const pct = Math.max(0, Math.min(1, fraction ?? 0));
  const level = pct >= 0.9 ? ' high' : pct >= 0.75 ? ' warm' : '';
  return h('span', { class: `snmp-meter${level}`, title, 'aria-hidden': 'true' }, h('span', { style: { width: `${(pct * 100).toFixed(1)}%` } }));
}

function rateCell(bps, speed) {
  if (bps == null) return h('td', { class: 'num muted' }, '—');
  const util = speed ? bps / speed : null;
  return h('td', { class: 'num' },
    h('span', { class: 'snmp-rate' }, fmtBps(bps)),
    util != null ? meter(util, `${(util * 100).toFixed(util < 0.1 ? 1 : 0)}% of ${fmtBps(speed)}`) : null);
}

function stale(at, interval) {
  return at && Date.now() - at > (interval * 2 + 30) * 1000;
}

// ---- Falls details panel ----------------------------------------------------

export function snmpSummary(m, snap) {
  const d = snap?.data;
  if (!d) return h('div', { class: 'snmp-summary' }, h('p', { class: 'muted small' }, snap ? 'No SNMP data yet.' : 'Loading SNMP data…'));
  const display = snap.display;
  const shown = (key) => !isHidden(display, key);
  const ifs = counted(d, display);
  const busiest = d.interfaces.filter((i) => shown(`if:${i.name}`) && (i.inBps ?? 0) + (i.outBps ?? 0) > 0)
    .sort((a, b) => b.inBps + b.outBps - a.inBps - a.outBps).slice(0, 3);
  const memory = d.storage.find((s) => s.kind === 'memory' && shown(`res:${s.name}`));
  const item = (label, value) => h('div', null, h('dt', null, label), h('dd', null, value));
  const fact = (key, label, value) => (value == null || value === '' || !shown(`fact:${key}`) ? null : item(label, value));
  const res = shown('section:resources');
  return h('div', { class: 'snmp-summary' },
    h('h4', null, 'Device', h('span', { class: `muted small${stale(snap.at, m.interval) ? ' snmp-stale' : ''}` }, ` · ${fmtAgo(snap.at)}`)),
    d.system.descr && shown('fact:descr') ? h('p', { class: 'snmp-descr', title: d.system.descr }, d.system.descr) : null,
    h('dl', { class: 'snmp-facts' },
      fact('name', 'Name', d.system.name),
      fact('location', 'Location', d.system.location),
      fact('uptime', 'Uptime', fmtUptime(d.system.uptime)),
      ifs.length && shown('section:interfaces') ? item('Interfaces', `${ifs.filter((i) => i.oper === 'up').length} of ${ifs.length} up`) : null,
      d.cpu && res && shown('res:cpu') ? item('CPU', h('span', { class: 'snmp-inline' }, meter(d.cpu.load / 100), `${d.cpu.load}%`)) : null,
      memory && res ? item('Memory', h('span', { class: 'snmp-inline' }, meter(memory.used / memory.size), `${Math.round((memory.used / memory.size) * 100)}%`)) : null),
    busiest.length && shown('section:interfaces') ? h('div', { class: 'snmp-busiest' },
      h('h5', null, 'Busiest'),
      busiest.map((i) => h('div', { class: 'snmp-busy-row' },
        h('span', { class: 'snmp-if-name', title: i.alias || i.descr }, i.name),
        h('span', { class: 'snmp-io' }, `↓ ${fmtBps(i.inBps)}`),
        h('span', { class: 'snmp-io' }, `↑ ${fmtBps(i.outBps)}`)))) : null);
}

// ---- monitor page -----------------------------------------------------------

// opts: { showAll, onToggleAll, editing, onToggleEdit, rerender, browseHref }
export function snmpSections(m, snap, opts) {
  const d = snap?.data;
  const { editing } = opts;
  // Title and its details on the left, buttons (`right`) on the right.
  const head = (title, left = [], right = []) => h('div', { class: 'card-head snmp-head' }, h('h2', null, title), left, h('span', { class: 'snmp-head-right' }, right));
  const browse = h('a', { class: 'btn small', href: opts.browseHref, title: 'Everything the device reports, read live' }, 'All data');
  const customize = h('button', { class: `btn small${editing ? ' primary' : ''}`, onclick: opts.onToggleEdit, 'aria-pressed': String(editing) }, editing ? 'Done' : 'Customize');
  if (!d) {
    return h('section', { class: 'card' }, head('Device', [], [browse]),
      h('p', { class: 'muted' }, snap ? 'No SNMP data yet. It is collected with every successful check.' : 'Loading…'));
  }
  const display = snap.display ?? { oids: '', hide: [], card: [] };
  const save = (patch) => saveDisplay(m.id, patch, opts.rerender);
  const toggleHide = (key) => save({ hide: isHidden(display, key) ? display.hide.filter((k) => k !== key) : [...display.hide, key] });
  const toggleCard = (key) => save({ card: onCard(display, key) ? display.card.filter((k) => k !== key) : [...display.card, key] });
  const full = display.card.length >= CARD_MAX;

  // Edit controls: hide/show, and put on (or take off) the Falls card.
  const hideBtn = (key) => h('button', { class: 'snmp-ctl', onclick: () => toggleHide(key), title: isHidden(display, key) ? 'Show it on this page again' : 'Hide it from this page' },
    isHidden(display, key) ? 'Show' : 'Hide');
  const cardBtn = (key) => {
    const on = onCard(display, key);
    return h('button', {
      class: `snmp-ctl card${on ? ' on' : ''}`,
      'aria-pressed': String(on),
      disabled: !on && full,
      title: on ? 'Take it off the card in the Falls' : full ? `The card shows at most ${CARD_MAX} values` : 'Show it on the card in the Falls',
      onclick: () => toggleCard(key),
    }, on ? '✓ Card' : '+ Card');
  };
  const ctls = (...btns) => (editing ? h('span', { class: 'snmp-ctls' }, btns) : null);
  const keep = (key) => editing || !isHidden(display, key);
  const faded = (key) => (isHidden(display, key) ? ' snmp-hidden' : '');
  const sectionHead = (name, title, left = [], right = []) => head(title, left, [...right, editing ? hideBtn(`section:${name}`) : null]);

  const old = stale(snap.at, m.interval);
  const fact = (key, label, value, { cls = '', card = false } = {}) => (value == null || value === '' || !keep(`fact:${key}`) ? null
    : h('div', { class: `snmp-fact${faded(`fact:${key}`)}${cls === 'snmp-wide' ? ' wide' : ''}` },
      h('dt', null, label, ctls(hideBtn(`fact:${key}`), card ? cardBtn(key) : null)),
      h('dd', { class: cls }, value)));

  const device = h('section', { class: 'card' },
    head('Device',
      [h('span', { class: `muted small${old ? ' snmp-stale' : ''}` }, `${old ? 'last ' : ''}collected ${fmtAgo(snap.at)}`)],
      [browse, customize]),
    editing ? h('div', { class: 'snmp-edit-note' },
      h('div', null, h('strong', null, 'Falls card: '), h('span', { class: 'snmp-card-preview' }, m.msg || '—')),
      h('div', { class: 'muted small' }, `Hide what you don’t need on this page, and pick up to ${CARD_MAX} values for the card with + Card. With none picked, the card shows the name and how many links are up. For more values, use All data.`)) : null,
    h('dl', { class: 'snmp-grid' },
      fact('name', 'Name', d.system.name, { card: true }),
      fact('location', 'Location', d.system.location, { card: true }),
      fact('contact', 'Contact', d.system.contact),
      fact('uptime', 'Uptime', fmtUptime(d.system.uptime), { card: true }),
      fact('descr', 'Description', d.system.descr, { cls: 'snmp-wide' }),
      fact('objectId', 'Object ID', d.system.objectId, { cls: 'mono' })),
    d.notes?.length ? h('ul', { class: 'snmp-notes' }, d.notes.map((n) => h('li', null, n))) : null);

  // Interfaces: in edit mode all of them, so any can be hidden or shown.
  const ifs = d.interfaces;
  const countedIfs = counted(d, display);
  const visible = ifs.filter((i) => !isHidden(display, `if:${i.name}`));
  const list = editing ? ifs : visible.filter((i) => opts.showAll || (i.admin === 'up' && i.kind !== 'Loopback'));
  const toggleAll = editing ? null
    : visible.length > list.length ? h('button', { class: 'linkish snmp-toggle', onclick: opts.onToggleAll }, `Show all ${visible.length}`)
    : opts.showAll && visible.length > countedIfs.length ? h('button', { class: 'linkish snmp-toggle', onclick: opts.onToggleAll }, 'Only enabled') : null;
  const interfaces = ifs.length && keep('section:interfaces') ? h('section', { class: `card${faded('section:interfaces')}` },
    sectionHead('interfaces', 'Interfaces',
      [h('span', { class: 'muted small' }, `${countedIfs.filter((i) => i.oper === 'up').length} of ${countedIfs.length} up`), ctls(cardBtn('ifs'))],
      [toggleAll]),
    h('div', { class: 'table-scroll' }, h('table', { class: 'snmp-ifs' },
      h('thead', null, h('tr', null,
        h('th', null, 'Interface'), h('th', null, 'Type'), h('th', { class: 'num' }, 'Speed'),
        h('th', { class: 'num' }, 'In'), h('th', { class: 'num' }, 'Out'), h('th', { class: 'num' }, 'Errors'),
        editing ? h('th', null) : null)),
      h('tbody', null, list.map((i) => {
        const st = ifState(i);
        const key = `if:${i.name}`;
        const errors = (i.inErrors ?? 0) + (i.outErrors ?? 0);
        return h('tr', { class: `${st === 'paused' ? 'snmp-off' : ''}${faded(key)}` },
          h('td', null,
            h('div', { class: 'snmp-if' },
              h('span', { class: `dot ${st}`, title: IF_LABEL[st] }),
              h('div', null,
                h('div', { class: 'snmp-if-name' }, i.name),
                i.alias || (i.descr && i.descr !== i.name) ? h('div', { class: 'muted small' }, i.alias || i.descr) : null))),
          h('td', { class: 'muted' }, i.kind || '—'),
          h('td', { class: 'num' }, i.speed ? fmtBps(i.speed) : '—'),
          rateCell(i.inBps, i.speed),
          rateCell(i.outBps, i.speed),
          h('td', { class: `num${errors ? ' snmp-errors' : ' muted'}` }, i.inErrors == null ? '—' : errors.toLocaleString()),
          editing ? h('td', { class: 'snmp-row-ctls' }, ctls(hideBtn(key), cardBtn(key))) : null);
      }))))) : null;

  const res = [];
  if (d.cpu) res.push({ key: 'res:cpu', card: 'cpu', label: 'CPU', used: d.cpu.load, size: 100, detail: d.cpu.cores ? `${d.cpu.load}% · ${d.cpu.cores} core${d.cpu.cores === 1 ? '' : 's'}` : `${d.cpu.load}%` });
  let firstMemory = true;
  for (const s of d.storage) {
    const card = s.kind === 'memory' ? (firstMemory ? 'memory' : null) : `disk:${s.name}`;
    if (s.kind === 'memory') firstMemory = false;
    res.push({ key: `res:${s.name}`, card, label: s.name, used: s.used, size: s.size, detail: `${fmtBytes(s.used)} of ${fmtBytes(s.size)} · ${Math.round((s.used / s.size) * 100)}%` });
  }
  const resShown = res.filter((r) => keep(r.key));
  const resources = resShown.length && keep('section:resources') ? h('section', { class: `card${faded('section:resources')}` },
    sectionHead('resources', 'Resources'),
    h('div', { class: 'snmp-res-grid' }, resShown.map((r) => h('div', { class: `snmp-res${faded(r.key)}` },
      h('div', { class: 'snmp-res-head' }, h('span', null, r.label), h('span', { class: 'muted small' }, r.detail)),
      meter(r.used / r.size),
      ctls(hideBtn(r.key), r.card ? cardBtn(r.card) : null))))) : null;

  const extra = parseExtra(display.oids);
  const removeValue = (oid) => save({
    oids: formatExtra(extra.filter((e) => e.oid !== oid)),
    card: display.card.filter((k) => k !== `value:${oid}`),
  });
  const custom = d.custom?.length && keep('section:values') ? h('section', { class: `card${faded('section:values')}` },
    sectionHead('values', 'Values'),
    h('div', { class: 'table-scroll' }, h('table', { class: 'snmp-values' },
      h('tbody', null, d.custom.map((c) => h('tr', null,
        h('td', null, c.label),
        h('td', { class: 'snmp-value' }, c.value == null ? h('span', { class: 'muted' }, c.type === 'error' ? 'error' : 'not available') : String(c.text ?? c.value)),
        h('td', { class: 'mono muted small' }, c.oid),
        editing ? h('td', { class: 'snmp-row-ctls' }, h('span', { class: 'snmp-ctls' },
          cardBtn(`value:${c.oid}`),
          h('button', { class: 'snmp-ctl', title: 'Stop reading this value', onclick: () => removeValue(c.oid) }, 'Remove'))) : null)))))) : null;

  return [device, interfaces, resources, custom];
}

// ---- MIB library ------------------------------------------------------------

// Lookup sites for an OID nothing here describes. Opened by the user, in a
// new tab; nothing is sent anywhere on its own.
const OIDREF = (oid) => `https://oidref.com/${oid}`;
const OBSERVIUM = (oid) => `https://mibs.observium.org/?q=.${oid}`;
const ext = (href, text, title) => h('a', { class: 'snmp-ext', href, target: '_blank', rel: 'noopener noreferrer', title }, text, ' ↗');

// Uploads MIB files (a FileList or array). Returns the server's answer
// ({ added, errors, modules }) or null.
export async function uploadMibs(files) {
  if (!files.length) return null;
  try {
    const payload = await Promise.all([...files].map(async (f) => ({ filename: f.name, text: await f.text() })));
    const r = await api('mibs', { method: 'POST', body: { files: payload } });
    if (r.added.length) toast(`Added ${r.added.map((a) => a.name).join(', ')}`, 'success');
    for (const e of r.errors) toast(`${e.filename}: ${e.error}`, 'error');
    return r;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

// Modules just added that import modules nobody has.
const stillNeeded = (r) => [...new Set(r.modules.filter((m) => r.added.some((a) => a.name === m.name)).flatMap((m) => m.missing))].sort();

function uploadButton(onDone, { label = 'Add MIB files…', cls = 'btn' } = {}) {
  const input = h('input', {
    type: 'file',
    multiple: true,
    hidden: true,
    onchange: async () => {
      const r = await uploadMibs(input.files);
      input.value = '';
      if (r) onDone(r);
    },
  });
  return h('span', { class: 'mib-upload' }, input, h('button', { class: cls, type: 'button', onclick: () => input.click() }, label));
}

function neededNote(missing) {
  return missing.length ? h('p', { class: 'mib-needed' },
    h('strong', null, 'Also needed: '), missing.map((m, i) => [i ? ', ' : '', h('code', null, m)]),
    '. These are imported by what you added; until they are here, some of its objects can’t be placed.') : null;
}

// The Settings card: uploaded modules, upload, and the built-in list.
export function mibLibraryCard() {
  const body = h('div', { class: 'mib-body' }, h('p', { class: 'muted' }, 'Loading…'));
  let missing = [];
  const render = (modules) => {
    const mine = modules.filter((m) => m.source === 'uploaded');
    const bundled = modules.filter((m) => m.source === 'bundled');
    const remove = (m) => confirmDialog(`Remove ${m.name}?`, 'Values it names show as numbers again. You can add it back at any time.', 'Remove', async () => {
      try {
        render((await api(`mibs/${encodeURIComponent(m.name)}`, { method: 'DELETE' })).modules);
      } catch (err) {
        toast(err.message, 'error');
        return false;
      }
    });
    fill(body,
      mine.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'mib-table' },
        h('thead', null, h('tr', null, h('th', null, 'Module'), h('th', null, 'File'), h('th', { class: 'num' }, 'Objects'), h('th', null, 'Added'), h('th', null))),
        h('tbody', null, mine.map((m) => h('tr', null,
          h('td', null,
            h('div', { class: 'mib-name' }, m.name),
            m.missing.length ? h('div', { class: 'mib-warn' }, `Needs ${m.missing.join(', ')}`) : null,
            m.unresolved ? h('div', { class: 'muted small' }, `${m.unresolved} object${m.unresolved === 1 ? '' : 's'} can’t be placed yet`) : null,
            m.errors.length ? h('div', { class: 'mib-warn', title: m.errors.join('\n') }, `${m.errors.length} part${m.errors.length === 1 ? '' : 's'} couldn’t be read`) : null),
          h('td', { class: 'muted small' }, m.filename),
          h('td', { class: 'num' }, m.objects.toLocaleString()),
          h('td', { class: 'muted small' }, fmtAgo(m.addedAt)),
          h('td', { class: 'num' }, h('button', { class: 'btn small ghost', onclick: () => remove(m) }, 'Remove'))))))) : h('p', { class: 'muted' }, 'No MIBs added yet.'),
      neededNote(missing),
      h('div', { class: 'mib-actions' }, uploadButton((r) => {
        missing = stillNeeded(r);
        render(r.modules);
      }, { cls: 'btn primary' })),
      h('details', { class: 'mib-builtin' },
        h('summary', null, `${bundled.length} standard MIBs are built in`),
        h('p', null, bundled.map((m) => h('code', { class: 'csv-val' }, m.name)))));
  };
  api('mibs').then((r) => render(r.modules)).catch((err) => fill(body, h('p', { class: 'snmp-notes' }, err.message)));
  return h('section', { class: 'card mib-card' },
    h('h3', null, 'MIB library'),
    h('p', { class: 'muted' }, 'MIB files tell the SNMP “All data” view what a device’s values are called, their units and what their numbers mean. The standard ones are built in; add your devices’ own (vendor) MIBs here, and they apply to every SNMP monitor. A vendor MIB usually imports others from the same vendor, so add those too when it says it needs them.'),
    body);
}

// ---- "All data" browser -----------------------------------------------------

let browse = null; // { id, entries, objects, next, loading, error, filter, open, missing }
const SHOW_MAX = 1500;

function valueText(e) {
  if (e.text != null) return e.text;
  if (e.value == null) return e.type;
  if (e.type === 'timeticks') return `${fmtUptime(Math.round(e.value / 100))} (${e.value})`;
  if (e.type === 'oid') {
    const name = oidName(e.value);
    return name ? `${name} (${e.value})` : e.value;
  }
  return String(e.value);
}

// Where the values nobody names live: the deepest known node above each
// and the arc below it, most values first.
function unnamed(entries) {
  const groups = new Map();
  let total = 0;
  for (const e of entries) {
    if (e.name || oidName(e.oid)) continue;
    total++;
    const oid = e.near?.oid ?? e.oid.split('.').slice(0, 7).join('.');
    const g = groups.get(oid) ?? { oid, under: e.near?.under, n: 0 };
    g.n++;
    groups.set(oid, g);
  }
  return { total, top: [...groups.values()].sort((a, b) => b.n - a.n).slice(0, 5) };
}

// A page of its own (#/monitor/:id/snmp): walk the device, a page at a time,
// search it, and add values to the monitor's page or its card.
// `pick`: opened from "Pick a value" for that problem definition (id).
export async function renderSnmpBrowser(main, m, { pick = null, navigate = (hash) => { location.hash = hash; } } = {}) {
  if (!m) return fill(main, h('div', { class: 'card' }, h('p', null, 'Loading…')));
  if (browse?.id !== m.id) browse = { id: m.id, entries: [], objects: {}, next: null, loading: false, error: null, filter: '', started: false, open: new Set(), missing: [] };
  const b = browse;
  if (!cache.get(m.id)?.value) {
    const value = await api(`monitors/${m.id}/data`).catch(() => null);
    if (value) cache.set(m.id, { key: m.lastCheck, value });
  }
  const disp = cache.get(m.id)?.value?.display ?? { oids: '', hide: [], card: [] };
  // only while the browser is still the page on screen
  const redraw = () => location.hash.startsWith(`#/monitor/${m.id}/snmp`) && renderSnmpBrowser(main, m, { pick, navigate });
  if (!pick) b.pickFor = null;
  else if (b.pickFor?.id !== pick) {
    b.pickFor = { id: pick, def: null };
    api('problems').then((list) => {
      b.pickFor.def = list.find((p) => p.id === pick) ?? null;
      redraw();
    }).catch(() => {});
  }

  const load = async () => {
    b.started = true;
    b.loading = true;
    b.error = null;
    redraw();
    try {
      const page = await api(`monitors/${m.id}/snmp/walk${b.next ? `?start=${b.next}` : ''}`);
      if (browse !== b) return;
      b.entries.push(...page.entries);
      Object.assign(b.objects, page.objects);
      b.next = page.next;
    } catch (err) {
      b.error = err.message;
    }
    b.loading = false;
    redraw();
  };
  // New MIBs: names come from the server, so read the device again.
  const reread = (r) => {
    b.missing = stillNeeded(r);
    Object.assign(b, { entries: [], objects: {}, next: null, started: false });
    load();
  };
  if (!b.started) return load();

  const pinned = new Map(parseExtra(disp.oids).map((e) => [e.oid, e]));
  const labelOf = (e, name) => (name ?? e.oid).replace(/\.0$/, '');
  const togglePage = (e, name) => {
    const list = parseExtra(disp.oids);
    if (pinned.has(e.oid)) return saveDisplay(m.id, { oids: formatExtra(list.filter((x) => x.oid !== e.oid)), card: disp.card.filter((k) => k !== `value:${e.oid}`) }, redraw);
    return saveDisplay(m.id, { oids: formatExtra([...list, { label: labelOf(e, name), oid: e.oid }]) }, redraw);
  };
  const toggleCard = (e, name) => {
    const key = `value:${e.oid}`;
    if (disp.card.includes(key)) return saveDisplay(m.id, { card: disp.card.filter((k) => k !== key) }, redraw);
    const oids = pinned.has(e.oid) ? disp.oids : formatExtra([...parseExtra(disp.oids), { label: labelOf(e, name), oid: e.oid }]);
    return saveDisplay(m.id, { oids, card: [...disp.card, key] }, redraw);
  };
  const toggleOpen = (oid) => {
    if (b.open.has(oid)) b.open.delete(oid);
    else b.open.add(oid);
    redraw();
  };

  const sysObjectId = b.entries.find((e) => e.oid === '1.3.6.1.2.1.1.2.0')?.value ?? cache.get(m.id)?.value?.data?.system?.objectId ?? null;
  const usePick = (e, name, obj) => {
    const g = oidGroup(e.oid);
    const vendor = e.oid.startsWith('1.3.6.1.4.1.') && g !== 'Enterprise' ? g : obj?.module ?? '';
    pickValueDialog({ monitor: m, entry: { oid: e.oid, name, value: e.value, text: valueText(e) }, sysObjectId, pickId: pick, vendor, navigate });
  };

  const q = b.filter.trim().toLowerCase();
  const full = disp.card.length >= CARD_MAX;
  const rows = [];
  let group = null;
  let matches = 0;
  for (const e of b.entries) {
    const name = e.name ?? oidName(e.oid);
    const obj = e.obj ? b.objects[e.obj] : null;
    const text = valueText(e);
    if (q && !`${name ?? ''} ${obj?.module ?? ''} ${e.oid} ${text}`.toLowerCase().includes(q)) continue;
    if (++matches > SHOW_MAX) continue;
    const g = oidGroup(e.oid);
    if (g !== group) {
      group = g;
      rows.push(h('tr', { class: 'snmp-group-row' }, h('th', { colspan: 4 }, g)));
    }
    const isPinned = pinned.has(e.oid);
    const isCard = disp.card.includes(`value:${e.oid}`);
    const open = obj && b.open.has(e.oid);
    rows.push(h('tr', { class: `${isPinned ? 'snmp-pinned' : ''}${open ? ' snmp-open' : ''}` },
      h('td', null,
        h('div', { class: 'snmp-oid-name' },
          !name ? h('span', { class: 'muted' }, '—')
          : obj ? h('button', { class: 'linkish snmp-obj-btn', 'aria-expanded': String(!!open), title: obj.desc ? `${obj.desc.slice(0, 300)}${obj.desc.length > 300 ? '…' : ''}` : 'Details', onclick: () => toggleOpen(e.oid) }, name)
          : name),
        h('div', { class: 'mono muted small' },
          obj ? `${obj.module} · ` : null,
          name ? e.oid : h('a', { class: 'snmp-lookup', href: OBSERVIUM(e.oid), target: '_blank', rel: 'noopener noreferrer', title: 'Look this OID up on mibs.observium.org' }, e.oid))),
      h('td', { class: 'snmp-value' }, text, e.raw != null ? h('span', { class: 'muted snmp-raw' }, ` (${e.raw})`) : null),
      h('td', { class: 'muted small', title: obj?.type ?? '' }, obj?.type?.replace(/ \(.*\)$/, '') ?? e.type),
      h('td', { class: 'snmp-row-ctls' }, h('span', { class: 'snmp-ctls' },
        h('button', { class: `snmp-ctl${isPinned ? ' on' : ''}`, 'aria-pressed': String(isPinned), title: isPinned ? 'Take it off the monitor’s page' : 'Show it on the monitor’s page, under Values', onclick: () => togglePage(e, name) }, isPinned ? '✓ Page' : '+ Page'),
        h('button', { class: `snmp-ctl card${isCard ? ' on' : ''}`, 'aria-pressed': String(isCard), disabled: !isCard && full, title: isCard ? 'Take it off the card in the Falls' : full ? `The card shows at most ${CARD_MAX} values` : 'Show it on the card in the Falls', onclick: () => toggleCard(e, name) }, isCard ? '✓ Card' : '+ Card'),
        e.value != null ? h('button', { class: `snmp-ctl problem${pick ? ' picking' : ''}`, title: 'Use it in a problem definition: alert when it has certain values', onclick: () => usePick(e, name, obj) }, '+ Problem') : null))));
    if (open) {
      const item = (label, value) => (value ? h('div', null, h('dt', null, label), h('dd', null, value)) : null);
      rows.push(h('tr', { class: 'snmp-detail-row' }, h('td', { colspan: 4 },
        h('dl', { class: 'snmp-obj' },
          item('Object', obj.name), item('MIB', obj.module), item('Type', obj.type), item('Units', obj.units), item('Access', obj.access), item('Status', obj.status)),
        obj.desc ? h('p', { class: 'snmp-desc' }, obj.desc) : null)));
    }
  }

  const unknown = b.loading && !b.entries.length ? { total: 0 } : unnamed(b.entries);
  const unknownBox = unknown.total ? h('div', { class: 'snmp-unknown' },
    h('p', null,
      h('strong', null, `${unknown.total.toLocaleString()} of ${b.entries.length.toLocaleString()} values have no name.`),
      ' They come from MIBs that aren’t here, usually the device maker’s own. Look up where they are to find the MIB, download it (from the maker, or the lookup page), and add it.'),
    h('ul', null, unknown.top.map((t) => {
      const vendor = oidGroup(t.oid);
      return h('li', null,
        h('span', { class: 'mono' }, t.oid),
        vendor !== 'Other' && vendor !== 'Enterprise' ? h('span', null, ` ${vendor}`) : null,
        t.under && t.under !== 'enterprises' ? h('span', { class: 'muted' }, ` under ${t.under}`) : null,
        h('span', { class: 'muted' }, ` · ${t.n.toLocaleString()} value${t.n === 1 ? '' : 's'} · `),
        ext(OIDREF(t.oid), 'oidref.com', 'Which MIB defines this, with downloads'), ' ',
        ext(OBSERVIUM(t.oid), 'Observium', 'Search mibs.observium.org for this OID'));
    }))) : null;

  const search = h('input', {
    class: 'snmp-search',
    type: 'search',
    placeholder: 'Search names, OIDs and values',
    value: b.filter,
    'aria-label': 'Search',
    oninput: (ev) => {
      b.filter = ev.target.value;
      const pos = ev.target.selectionStart;
      redraw();
      const el = main.querySelector('.snmp-search');
      el?.focus();
      el?.setSelectionRange(pos, pos);
    },
  });
  fill(main, h('div', { class: 'detail snmp-browser' },
    h('div', { class: 'detail-head' },
      h('div', null,
        h('div', { class: 'crumbs' }, h('a', { href: `#/monitor/${m.id}` }, `← ${m.name}`)),
        h('h1', null, 'All SNMP data'),
        h('p', { class: 'muted' }, `Everything ${m.name} reports, read live. Click a name for what it means. + Page adds a value to the monitor’s page, + Card to its card in the Falls (at most ${CARD_MAX}), + Problem to a problem definition, to alert on it.`)),
      h('div', { class: 'actions' },
        uploadButton(reread),
        h('a', { class: 'btn ghost', href: '#/settings', title: 'MIB library (Settings)' }, 'MIBs'),
        h('a', { class: 'btn', href: `#/monitor/${m.id}` }, 'Back'))),
    b.pickFor ? h('div', { class: 'banner pick-banner' },
      h('div', null,
        h('strong', null, `Picking a value for ${b.pickFor.def?.name ?? 'a problem definition'}. `),
        b.pickFor.def ? `${m.name} answers none of its readings (${b.pickFor.def.config.readings.map((r) => r.label || r.oid || r.source).join(', ')}). ` : null,
        'Find the value that shows it (searching helps, such as “battery”, “output” or “status”), then press + Problem on its row.'),
      h('a', { class: 'btn small ghost', href: `#/monitor/${m.id}/snmp` }, 'Stop picking')) : null,
    neededNote(b.missing),
    unknownBox,
    h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        search,
        h('span', { class: 'muted small' },
          b.loading ? `Reading… ${b.entries.length.toLocaleString()} so far` : `${(q ? matches : b.entries.length).toLocaleString()} ${q ? (matches === 1 ? 'match' : 'matches') : 'values'}${b.next ? ' so far' : ''}`)),
      b.error ? h('p', { class: 'snmp-notes' }, b.error) : null,
      rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'snmp-ifs snmp-walk' },
        h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Value'), h('th', null, 'Type'), h('th', null))),
        h('tbody', null, rows))) : b.loading ? null : h('p', { class: 'muted' }, q ? 'Nothing matches.' : 'The device reported nothing.'),
      matches > SHOW_MAX ? h('p', { class: 'muted small' }, `Showing the first ${SHOW_MAX.toLocaleString()} of ${matches.toLocaleString()}. Search to narrow it down.`) : null,
      b.next && !b.loading ? h('div', { class: 'snmp-more' }, h('button', { class: 'btn', onclick: load }, 'Load more')) : null)));
}
