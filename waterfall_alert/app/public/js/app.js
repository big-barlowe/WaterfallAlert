import { api, h, toast, modal, confirmDialog, storage, store, STATUS_LABEL, BEAT_STATUS, TYPE_LABEL, fmtTime, fmtAgo, fmtPct, fmtMs, fill } from './util.js';
import { FlowView } from './flow.js';
import { heartbeatBar, responseChart } from './chart.js';
import { renderMonitorForm, renderNotificationForm } from './forms.js';

const POLL_MS = 3000;
const $ = (sel) => document.querySelector(sel);

const state = { version: 0, monitors: [], byId: new Map(), loaded: false };
const ui = {
  editMode: false,
  search: '',
  collapsed: new Set(storage('collapsed', [])),
  route: null,
  chartHours: storage('chartHours', 24),
  drag: null,
};

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
const children = (m) => m.children.map((c) => state.byId.get(c)).filter(Boolean).sort(byName);

function descendantsOf(id) {
  const seen = new Set();
  const queue = [id];
  while (queue.length) {
    for (const c of state.byId.get(queue.shift())?.children ?? []) {
      if (!seen.has(c)) {
        seen.add(c);
        queue.push(c);
      }
    }
  }
  return seen;
}

// ---- data -----------------------------------------------------------------

let pollTimer;
async function poll() {
  clearTimeout(pollTimer);
  try {
    const s = await api(`state?v=${state.version}`);
    $('#conn').hidden = true;
    if (!s.unchanged) {
      state.version = s.version;
      state.monitors = s.monitors;
      state.byId = new Map(s.monitors.map((m) => [m.id, m]));
      state.loaded = true;
      onState();
    }
  } catch {
    $('#conn').hidden = false;
  }
  pollTimer = setTimeout(poll, POLL_MS);
}

function refresh() {
  state.version = 0;
  return poll();
}

function onState() {
  renderSummary();
  if (!ui.drag) renderTree(); // re-rendering mid-drag would cancel the drag
  const r = ui.route;
  if (r?.name === 'dashboard') renderDashboard(true);
  if (r?.name === 'monitor') renderDetail(r.id, true);
}

// ---- header summary -------------------------------------------------------

function counts() {
  const c = { up: 0, down: 0, pending: 0, blocked: 0, paused: 0 };
  for (const m of state.monitors) if (m.type !== 'group') c[m.status]++;
  return c;
}

function renderSummary() {
  const c = counts();
  const el = $('#summary');
  const tone = c.down ? 'down' : c.pending ? 'pending' : 'up';
  const text = c.down
    ? `${c.down} down${c.blocked ? ` · ${c.blocked} blocked` : ''}`
    : c.pending ? `${c.pending} pending` : state.monitors.length ? 'All flowing' : 'No monitors yet';
  fill(el, h('span', { class: `dot ${tone}` }), text);
  el.className = `summary ${tone}`;
  document.title = c.down ? `(${c.down}) Waterfall Alert` : 'Waterfall Alert';
}

// ---- sidebar tree -----------------------------------------------------------

function renderTree() {
  const host = $('#tree');
  const q = ui.search.trim().toLowerCase();
  $('#tree-tools').classList.toggle('editing', ui.editMode);
  $('#edit-toggle').textContent = ui.editMode ? 'Done' : 'Edit';
  $('#edit-toggle').setAttribute('aria-pressed', String(ui.editMode));
  $('#edit-hint').hidden = !ui.editMode;

  if (!state.monitors.length) {
    fill(host, h('div', { class: 'tree-empty' },
      h('p', null, 'Nothing is flowing yet.'),
      h('a', { class: 'btn primary', href: '#/add' }, '+ Add your first monitor')));
    return;
  }

  if (q) {
    const hits = state.monitors.filter((m) => m.name.toLowerCase().includes(q) || m.target.toLowerCase().includes(q)).sort(byName);
    fill(host, hits.length ? h('div', { class: 'branch root' }, hits.map((m) => row(m, null, `s${m.id}`, 0, false))) : h('p', { class: 'muted pad' }, 'No matches.'));
    return;
  }

  const roots = state.monitors.filter((m) => !m.parents.length).sort(byName);
  fill(host, [
    ui.editMode ? h('div', {
      class: 'root-drop',
      ondragover: (e) => {
        if (!ui.drag) return;
        e.preventDefault();
        e.currentTarget.classList.add('over');
      },
      ondragleave: (e) => e.currentTarget.classList.remove('over'),
      ondrop: (e) => {
        e.preventDefault();
        e.currentTarget.classList.remove('over');
        if (ui.drag) move(ui.drag.id, ui.drag.from, null, false);
      },
    }, 'Drop here to move to the top level') : null,
    h('div', { class: 'branch root' }, roots.map((m) => branch(m, null, String(m.id), 0))),
  ]);
}

function streamClass(m) {
  if (m.status === 'down') return 'dry';
  if (m.status === 'blocked' || m.status === 'paused') return 'still';
  return 'flow';
}

function branch(m, parentId, path, depth) {
  const kids = children(m);
  const open = !ui.collapsed.has(path);
  return h('div', { class: 'node-wrap' },
    row(m, parentId, path, depth, kids.length > 0),
    kids.length && open
      ? h('div', { class: `branch ${streamClass(m)}` }, kids.map((k) => branch(k, m.id, `${path}/${k.id}`, depth + 1)))
      : null);
}

function row(m, parentId, path, depth, hasKids) {
  const active = ui.route?.name === 'monitor' && ui.route.id === m.id;
  const open = !ui.collapsed.has(path);
  const otherParents = m.parents.filter((p) => p !== parentId).map((p) => state.byId.get(p)?.name).filter(Boolean);

  const el = h('div', {
    class: `row ${m.status}${active ? ' active' : ''}`,
    draggable: ui.editMode ? 'true' : null,
    ondragstart: (e) => {
      ui.drag = { id: m.id, from: parentId };
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', String(m.id));
      el.classList.add('dragging');
    },
    ondragend: () => {
      ui.drag = null;
      document.querySelectorAll('.drop-target,.dragging').forEach((n) => n.classList.remove('drop-target', 'dragging'));
    },
    ondragover: (e) => {
      if (!ui.drag || !canDrop(ui.drag.id, m.id)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
      el.classList.add('drop-target');
    },
    ondragleave: () => el.classList.remove('drop-target'),
    ondrop: (e) => {
      e.preventDefault();
      el.classList.remove('drop-target');
      if (ui.drag && canDrop(ui.drag.id, m.id)) move(ui.drag.id, ui.drag.from, m.id, e.altKey);
    },
  },
  h('button', {
    class: `twisty${hasKids ? '' : ' leaf'}`,
    'aria-label': open ? 'Collapse' : 'Expand',
    'aria-expanded': hasKids ? String(open) : null,
    tabindex: hasKids ? 0 : -1,
    onclick: () => {
      if (!hasKids) return;
      if (open) ui.collapsed.add(path);
      else ui.collapsed.delete(path);
      store('collapsed', [...ui.collapsed]);
      renderTree();
    },
  }, hasKids ? (open ? '▾' : '▸') : ''),
  ui.editMode ? h('span', { class: 'grip', 'aria-hidden': 'true' }, '⠿') : null,
  h('a', { class: 'row-main', href: `#/monitor/${m.id}`, draggable: 'false' },
    h('span', { class: `dot ${m.status}`, title: STATUS_LABEL[m.status] }),
    h('span', { class: 'row-name' }, m.name),
    otherParents.length ? h('span', { class: 'also', title: `Also under: ${otherParents.join(', ')}` }, '⑂') : null),
  ui.editMode
    ? h('span', { class: 'row-actions' },
      h('button', { class: 'icon-btn', title: 'Add a monitor under this one', onclick: () => go(`#/add?parent=${m.id}`) }, '+'),
      h('button', { class: 'icon-btn', title: 'Move…', onclick: () => moveDialog(m, parentId) }, '⇅'),
      h('button', { class: 'icon-btn', title: 'Edit settings', onclick: () => go(`#/monitor/${m.id}/edit`) }, '✎'),
      parentId != null ? h('button', {
        class: 'icon-btn',
        title: `Detach from ${state.byId.get(parentId)?.name}`,
        onclick: () => unlink(parentId, m.id),
      }, '⨯') : null)
    : h('span', { class: 'row-meta' },
      m.type === 'group' ? h('span', { class: 'muted small' }, `${m.children.length}`) : heartbeatBar(m.beats, 10, { compact: true }),
      m.type === 'group' ? null : h('span', { class: 'pct' }, m.uptime24 == null ? '' : fmtPct(m.uptime24).replace('.00', ''))));
  el.style.setProperty('--depth', depth);
  return el;
}

function canDrop(dragId, targetId) {
  return dragId !== targetId && !descendantsOf(dragId).has(targetId);
}

async function move(id, fromParentId, toParentId, link) {
  if (fromParentId === toParentId) return;
  try {
    await api(`monitors/${id}/move`, { method: 'POST', body: { fromParentId, toParentId, link } });
    const m = state.byId.get(id);
    const target = toParentId == null ? 'the top level' : state.byId.get(toParentId)?.name;
    toast(link ? `${m.name} is now also under ${target}` : `Moved ${m.name} to ${target}`, 'success');
    if (toParentId != null) {
      // make sure the new location is visible
      for (const k of [...ui.collapsed]) if (k.endsWith(`/${toParentId}`) || k === String(toParentId)) ui.collapsed.delete(k);
    }
    refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function unlink(parentId, childId) {
  try {
    await api('edges/remove', { method: 'POST', body: { parentId, childId } });
    toast(`Detached ${state.byId.get(childId)?.name} from ${state.byId.get(parentId)?.name}`, 'success');
    refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// Touch-friendly alternative to drag and drop.
function moveDialog(m, fromParentId) {
  const blocked = descendantsOf(m.id);
  const options = state.monitors.filter((x) => x.id !== m.id && !blocked.has(x.id)).sort(byName);
  const select = h('select', { id: 'move-target' },
    h('option', { value: '' }, '— Top level (no parent) —'),
    options.map((o) => h('option', { value: o.id, selected: o.id === fromParentId }, o.name)));
  const keep = h('input', { type: 'checkbox', id: 'move-keep' });
  modal(`Move ${m.name}`, h('div', null,
    h('div', { class: 'field' }, h('label', { for: 'move-target' }, 'Place under'), select),
    fromParentId != null ? h('label', { class: 'check' }, keep,
      h('span', null, `Keep it under ${state.byId.get(fromParentId)?.name} too (add as an extra parent)`)) : null),
  [{
    label: 'Move',
    onClick: () => move(m.id, fromParentId, select.value ? Number(select.value) : null, keep.checked && select.value !== ''),
  }]);
}

// ---- dashboard --------------------------------------------------------------

let flow;
let eventsCache = { at: 0, version: -1, list: [] };

async function renderDashboard(isUpdate = false) {
  const main = $('#main');
  if (!isUpdate || !main.querySelector('.dashboard')) {
    const flowBox = h('div', { class: 'flow-scroll' });
    flow = new FlowView(flowBox, (id) => go(`#/monitor/${id}`));
    fill(main, h('div', { class: 'dashboard' },
      h('div', { class: 'stat-row', id: 'dash-stats' }),
      h('section', { class: 'card falls' },
        h('div', { class: 'card-head' },
          h('h2', null, 'The Falls'),
          h('div', { class: 'legend' },
            h('span', { class: 'key flow' }, 'Flowing'),
            h('span', { class: 'key dry' }, 'Dry — source down'),
            h('span', { class: 'key still' }, 'Still — blocked/paused'))),
        flowBox,
        h('div', { id: 'flow-empty' })),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, 'Recent events')),
        h('div', { id: 'dash-events' }))));
  }
  const c = counts();
  fill($('#dash-stats'),
    ['up', 'down', 'blocked', 'pending', 'paused'].map((k) => h('div', { class: `stat ${k}` },
      h('div', { class: 'stat-num' }, c[k]),
      h('div', { class: 'stat-label' }, h('span', { class: `dot ${k}` }), STATUS_LABEL[k]))));

  flow.render(state.monitors);
  fill($('#flow-empty'), state.loaded && !state.monitors.length
    ? h('div', { class: 'empty' },
      h('p', null, 'Start at the top: add the thing everything else depends on (your WAN, a router), then add monitors beneath it.'),
      h('a', { class: 'btn primary', href: '#/add' }, '+ Add monitor'))
    : '');

  if (eventsCache.version !== state.version && Date.now() - eventsCache.at > 5000) {
    eventsCache = { at: Date.now(), version: state.version, list: await api('events').catch(() => []) };
  }
  const events = eventsCache.list.filter((e) => e.status !== 4).slice(0, 15);
  fill($('#dash-events'), events.length ? eventTable(events, true) : h('p', { class: 'muted' }, 'No events yet.'));
}

function eventTable(events, withName) {
  return h('div', { class: 'table-scroll' }, h('table', { class: 'events' },
    h('thead', null, h('tr', null, withName ? h('th', null, 'Monitor') : null, h('th', null, 'Status'), h('th', null, 'Time'), h('th', null, 'Message'))),
    h('tbody', null, events.map((e) => {
      const s = BEAT_STATUS[e.status];
      return h('tr', null,
        withName ? h('td', null, h('a', { href: `#/monitor/${e.monitorId}` }, e.name)) : null,
        h('td', null, h('span', { class: `badge ${s}` }, STATUS_LABEL[s])),
        h('td', { class: 'nowrap' }, fmtTime(e.time)),
        h('td', { class: 'msg' }, e.msg));
    }))));
}

// ---- monitor detail ---------------------------------------------------------

let detailCache = { id: null, at: 0, uptime: null, events: [], chartKey: '' };

async function renderDetail(id, isUpdate = false) {
  const m = state.byId.get(id);
  const main = $('#main');
  if (!m) {
    if (state.loaded) fill(main, h('div', { class: 'card' }, h('p', null, 'Monitor not found.'), h('a', { href: '#/' }, 'Back to the falls')));
    return;
  }
  if (detailCache.id !== id) detailCache = { id, at: 0, uptime: null, events: [], chartKey: '' };
  const stale = Date.now() - detailCache.at > 15000 || !isUpdate;

  let chartBox = main.querySelector('.detail .chart-box');
  if (!chartBox || !isUpdate) chartBox = h('div', { class: 'chart-box' });

  const parents = m.parents.map((p) => state.byId.get(p)).filter(Boolean).sort(byName);
  const kids = children(m);
  const allDown = descendantsOf(m.id).size;
  const relChips = (list) => list.length
    ? h('div', { class: 'chips' }, list.map((x) => h('a', { class: 'chip link', href: `#/monitor/${x.id}` }, h('span', { class: `dot ${x.status}` }), x.name)))
    : h('p', { class: 'muted small' }, 'None');

  fill(main, h('div', { class: 'detail' },
    h('div', { class: 'detail-head' },
      h('div', null,
        h('div', { class: 'crumbs' }, parents.length
          ? parents.map((p, i) => [i ? ' · ' : '', h('a', { href: `#/monitor/${p.id}` }, p.name)]).flat().concat(' ↓')
          : 'Top level'),
        h('h1', null, m.name, ' ', h('span', { class: `badge big ${m.status}` }, STATUS_LABEL[m.status])),
        h('div', { class: 'target' }, TYPE_LABEL[m.type], m.target && m.type !== 'push' ? ` · ${m.target}` : ''),
        m.description ? h('p', { class: 'muted' }, m.description) : null),
      h('div', { class: 'actions' },
        m.type !== 'group' ? h('button', { class: 'btn', onclick: () => action(`monitors/${id}/check`, 'Checked') }, 'Check now') : null,
        h('button', { class: 'btn', onclick: () => action(`monitors/${id}/${m.active ? 'pause' : 'resume'}`, m.active ? 'Paused' : 'Resumed') }, m.active ? 'Pause' : 'Resume'),
        h('a', { class: 'btn', href: `#/add?parent=${id}` }, '+ Dependent'),
        h('a', { class: 'btn primary', href: `#/monitor/${id}/edit` }, 'Edit'),
        h('button', {
          class: 'btn danger ghost',
          onclick: () => confirmDialog(`Delete ${m.name}?`, `Its heartbeat history will be deleted.${kids.length ? ` Its ${kids.length} dependent monitor(s) will move up a level.` : ''}`, 'Delete', async () => {
            await api(`monitors/${id}`, { method: 'DELETE' });
            toast(`Deleted ${m.name}`, 'success');
            go('#/');
            refresh();
          }),
        }, 'Delete'))),

    m.status === 'blocked' ? h('div', { class: 'banner blocked' },
      h('strong', null, 'Not being checked. '), `${m.msg || 'Something upstream is down'}. It will be re-checked as soon as that recovers.`) : null,
    m.status === 'down' && allDown ? h('div', { class: 'banner down' },
      h('strong', null, `${m.msg || 'Down'}. `), `${allDown} downstream monitor${allDown === 1 ? ' is' : 's are'} on hold until this recovers.`) : null,

    m.type === 'group' ? null : h('div', { class: 'stat-row' },
      tile('Response', fmtMs(m.ping), 'latest'),
      tile('Avg response', fmtMs(detailCache.uptime?.day.avgPing), '24 hours'),
      tile('Uptime', fmtPct(detailCache.uptime?.day.uptime), '24 hours'),
      tile('Uptime', fmtPct(detailCache.uptime?.month.uptime), '30 days')),

    m.type === 'group' ? null : h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', null, 'Heartbeats'),
        h('span', { class: 'muted small' }, `checked ${fmtAgo(m.lastCheck)} · every ${m.interval}s`)),
      heartbeatBar(m.beats, 40),
      m.msg ? h('p', { class: 'muted small last-msg' }, m.msg) : null),

    m.type === 'group' ? null : h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', null, 'Response time'),
        h('div', { class: 'tabs', role: 'tablist' }, [1, 24, 168, 720].map((hrs) => h('button', {
          class: `tab${ui.chartHours === hrs ? ' on' : ''}`,
          role: 'tab',
          'aria-selected': String(ui.chartHours === hrs),
          onclick: () => {
            ui.chartHours = hrs;
            store('chartHours', hrs);
            detailCache.chartKey = '';
            renderDetail(id);
          },
        }, hrs < 24 ? `${hrs}h` : hrs === 24 ? '24h' : `${hrs / 24}d`)))),
      chartBox),

    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Hierarchy')),
      h('div', { class: 'rel-grid' },
        h('div', { class: 'rel' }, h('h4', null, h('span', { class: 'rel-icon up' }, '↑'), 'Parent monitors'), relChips(parents),
          parents.length > 1 ? h('p', { class: 'muted small' }, m.parentMode === 'any' ? 'Blocked only when every parent is down.' : 'Blocked when any parent is down.') : null),
        h('div', { class: 'rel' }, h('h4', null, h('span', { class: 'rel-icon down' }, '↓'), 'Dependent monitors'), relChips(kids),
          allDown > kids.length ? h('p', { class: 'muted small' }, `${allDown} monitors downstream in total.`) : null))),

    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Events')),
      h('div', { class: 'events-box' }, detailCache.events.length ? eventTable(detailCache.events, false) : h('p', { class: 'muted' }, 'No status changes yet.')))));

  if (stale) {
    detailCache.at = Date.now();
    const [uptime, events] = await Promise.all([api(`monitors/${id}/uptime`), api(`monitors/${id}/events`)]).catch(() => [null, []]);
    if (ui.route?.id !== id) return;
    detailCache.uptime = uptime;
    detailCache.events = events;
    return renderDetail(id, true);
  }
  const chartKey = `${id}:${ui.chartHours}:${Math.floor(Date.now() / 30000)}`;
  if (m.type !== 'group' && (detailCache.chartKey !== chartKey || !chartBox.firstChild)) {
    detailCache.chartKey = chartKey;
    const beats = await api(`monitors/${id}/heartbeats?hours=${ui.chartHours}`).catch(() => []);
    if (ui.route?.id === id) responseChart(main.querySelector('.detail .chart-box') || chartBox, beats, { hours: ui.chartHours });
  }
}

function tile(label, value, sub) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-num' }, value), h('div', { class: 'stat-sub' }, sub));
}

async function action(path, done) {
  try {
    await api(path, { method: 'POST' });
    toast(done, 'success');
    refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---- alerts log -------------------------------------------------------------

async function renderAlerts() {
  const list = await api('alerts');
  fill($('#main'), h('div', { class: 'stack' },
    h('div', { class: 'page-head' }, h('h1', null, 'Alerts sent'),
      h('p', { class: 'muted' }, 'One alert per root cause. Everything cut off downstream is listed in the body instead of alerting on its own.')),
    list.length ? list.map((a) => h('article', { class: `card alert ${a.kind}` },
      h('div', { class: 'card-head' },
        h('h3', null, h('span', { class: `badge ${a.kind === 'down' ? 'down' : 'up'}` }, a.kind === 'down' ? 'Alert' : 'Resolved'), ' ', a.title),
        h('span', { class: 'muted small nowrap' }, fmtTime(a.time))),
      h('pre', { class: 'alert-body' }, a.message),
      h('div', { class: 'delivered' },
        a.delivered.length
          ? a.delivered.map((d) => h('span', { class: `chip ${d.ok ? 'ok' : 'fail'}`, title: d.error || 'Delivered' }, d.ok ? '✓ ' : '✗ ', d.name))
          : h('span', { class: 'muted small' }, 'No notification channels on this monitor')))) : h('div', { class: 'card' }, h('p', { class: 'muted' }, 'No alerts yet. Calm waters.'))));
}

// ---- notifications ----------------------------------------------------------

async function renderNotifications(editing) {
  const [list, catalog] = await Promise.all([api('notifications'), api('notification-types')]);
  const main = $('#main');
  const formBox = h('div');
  fill(main, h('div', { class: 'stack' },
    h('div', { class: 'page-head' },
      h('h1', null, 'Notifications'),
      h('button', { class: 'btn primary', onclick: () => showForm(null) }, '+ Add channel')),
    formBox,
    list.length ? h('div', { class: 'notif-list' }, list.map((n) => h('div', { class: 'card notif' },
      h('div', null,
        h('h3', null, n.name),
        h('div', { class: 'muted small' }, catalog[n.type]?.label ?? n.type, n.isDefault ? ' · default for new monitors' : '', n.active ? '' : ' · inactive')),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => showForm(n) }, 'Edit'),
        h('button', {
          class: 'btn danger ghost',
          onclick: () => confirmDialog(`Delete ${n.name}?`, 'Monitors using it will stop sending to it.', 'Delete', async () => {
            await api(`notifications/${n.id}`, { method: 'DELETE' });
            renderNotifications();
          }),
        }, 'Delete'))))) : h('div', { class: 'card' }, h('p', { class: 'muted' }, 'No channels yet. Home Assistant notify services work out of the box when running as an add-on.'))));

  function showForm(n) {
    renderNotificationForm(formBox, { catalog, existing: n, onDone: () => renderNotifications() });
    formBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  if (editing) showForm(null);
}

// ---- settings ---------------------------------------------------------------

async function renderSettings() {
  const [settings, info] = await Promise.all([api('settings'), api('info')]);
  const retention = h('input', { id: 's-ret', type: 'number', min: 1, value: settings.retentionDays });
  fill($('#main'), h('div', { class: 'stack' },
    h('div', { class: 'page-head' }, h('h1', null, 'Settings')),
    h('form', {
      class: 'card form',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('settings', { method: 'PUT', body: { retentionDays: Number(retention.value) } });
          toast('Saved', 'success');
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    },
    h('h3', null, 'Data'),
    h('div', { class: 'field' }, h('label', { for: 's-ret' }, 'Keep heartbeat history for (days)'), retention),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save'))),
    h('div', { class: 'card' },
      h('h3', null, 'About'),
      h('p', null, `Waterfall Alert ${info.version}${info.addon ? ' · running as a Home Assistant add-on' : ' · standalone'}`),
      h('p', { class: 'muted' }, 'Monitors are checked top-down. When something fails, its parents are re-checked first, so you get one alert for the real cause listing everything downstream of it.'))));
}

// ---- routing ----------------------------------------------------------------

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function parseRoute() {
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  const params = new URLSearchParams(qs);
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'monitor' && parts[2] === 'edit') return { name: 'edit', id: Number(parts[1]) };
  if (parts[0] === 'monitor') return { name: 'monitor', id: Number(parts[1]) };
  if (parts[0] === 'add') return { name: 'add', parent: params.get('parent') ? Number(params.get('parent')) : null };
  if (parts[0] === 'alerts') return { name: 'alerts' };
  if (parts[0] === 'notifications') return { name: 'notifications' };
  if (parts[0] === 'settings') return { name: 'settings' };
  return { name: 'dashboard' };
}

async function route() {
  ui.route = parseRoute();
  const r = ui.route;
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('on', a.dataset.route === (r.name === 'monitor' || r.name === 'edit' || r.name === 'add' ? 'dashboard' : r.name)));
  document.body.classList.toggle('show-tree', r.name === 'dashboard');
  renderTree();
  window.scrollTo({ top: 0 });
  try {
    if (r.name === 'dashboard') await renderDashboard();
    else if (r.name === 'monitor') await renderDetail(r.id);
    else if (r.name === 'edit') await renderMonitorForm($('#main'), { state, id: r.id, navigate: go });
    else if (r.name === 'add') await renderMonitorForm($('#main'), { state, presetParent: r.parent, navigate: go });
    else if (r.name === 'alerts') await renderAlerts();
    else if (r.name === 'notifications') await renderNotifications();
    else if (r.name === 'settings') await renderSettings();
  } catch (err) {
    fill($('#main'), h('div', { class: 'card' }, h('p', null, `Something went wrong: ${err.message}`)));
  }
}

// ---- boot -------------------------------------------------------------------

$('#edit-toggle').addEventListener('click', () => {
  ui.editMode = !ui.editMode;
  renderTree();
});
$('#search').addEventListener('input', (e) => {
  ui.search = e.target.value;
  renderTree();
});
window.addEventListener('hashchange', route);
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (ui.route?.name === 'monitor') {
      detailCache.chartKey = '';
      renderDetail(ui.route.id, true);
    }
  }, 250);
});

await poll();
route();
