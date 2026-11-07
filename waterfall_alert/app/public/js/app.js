import { api, h, svg, toast, modal, confirmDialog, storage, store, STATUS_LABEL, BEAT_STATUS, TYPE_LABEL, fmtTime, fmtAgo, fmtPct, fmtMs, fill } from './util.js';
import { FlowView, lineage } from './flow.js';
import { iconEl } from './icons.js';
import { heartbeatBar, responseChart } from './chart.js';
import { renderMonitorForm, renderNotificationForm } from './forms.js';
import { tagPill, colorPicker, newTagDialog, matchIcon, TAG_MATCH } from './tags.js';

const POLL_MS = 3000;
const $ = (sel) => document.querySelector(sel);

const state = { version: 0, monitors: [], byId: new Map(), tags: [], tagById: new Map(), loaded: false };
const ui = {
  editMode: false,
  search: '',
  collapsed: new Set(storage('collapsed', [])),
  route: null,
  chartHours: storage('chartHours', 24),
  drag: null,
  focus: null, // falls diagram: monitor whose upstream/downstream is shown
  info: null,  // falls diagram: monitor whose details panel is open
  tagFilter: new Set(storage('tagFilter', [])), // tag ids
  tagMatch: storage('tagMatch', 'any'), // 'any' of the filter's tags (union) or 'all' of them (intersection)
  // Monitors picked for tagging or moving, in the Falls or the monitor list.
  selected: new Set(),
  selFrom: new Map(), // id -> the parent of the list row it was picked under
  selectMode: false,  // falls diagram: clicks select instead of focusing
  tagDownstream: storage('tagDownstream', false),
  flowView: {},       // falls diagram zoom and position, kept across visits
  popout: null,       // 'side' or 'falls': popped out to fill the window
};

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
const children = (m) => m.children.map((c) => state.byId.get(c)).filter(Boolean).sort(byName);

const tagsOf = (m) => m.tags.map((t) => state.tagById.get(t)).filter(Boolean);

// With a tag filter: the monitors carrying any (or all) of the tags
// (`match`), plus everything above them (`show`) so the hierarchy still
// reads. null = no filter.
function filterView() {
  if (!ui.tagFilter.size) return null;
  const wanted = [...ui.tagFilter];
  const hit = ui.tagMatch === 'all' ? (m) => wanted.every((t) => m.tags.includes(t)) : (m) => m.tags.some((t) => ui.tagFilter.has(t));
  const match = new Set(state.monitors.filter(hit).map((m) => m.id));
  const show = new Set(match);
  const queue = [...match];
  while (queue.length) {
    for (const p of state.byId.get(queue.shift())?.parents ?? []) {
      if (!show.has(p)) {
        show.add(p);
        queue.push(p);
      }
    }
  }
  return { match, show };
}

function setTagFilter(ids, match = ui.tagMatch) {
  ui.tagFilter = new Set(ids);
  ui.tagMatch = match;
  store('tagFilter', [...ui.tagFilter]);
  store('tagMatch', match);
  selectionChanged();
}

// ---- selection --------------------------------------------------------------

// Shared by the Falls and the monitor list. Only monitors that exist and
// pass the tag filter stay selected, so nothing hidden gets tagged or moved.
function pruneSelection() {
  const vis = filterView();
  for (const id of ui.selected) if (!state.byId.has(id) || (vis && !vis.show.has(id))) ui.selected.delete(id);
  for (const id of ui.selFrom.keys()) if (!ui.selected.has(id)) ui.selFrom.delete(id);
}

function selectionChanged() {
  pruneSelection();
  renderTree();
  if (ui.route?.name === 'dashboard') renderDashboard(true);
}

function setSelection(ids) {
  ui.selected = new Set(ids);
  selectionChanged();
}

// `from` is the parent of the list row it was picked under (undefined from
// the Falls, where a monitor isn't under one particular parent).
function toggleSelected(id, from) {
  if (ui.selected.has(id)) ui.selected.delete(id);
  else {
    ui.selected.add(id);
    if (from === undefined) ui.selFrom.delete(id);
    else ui.selFrom.set(id, from);
  }
  selectionChanged();
}

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
      state.tags = s.tags ?? [];
      state.tagById = new Map(state.tags.map((t) => [t.id, t]));
      const known = [...ui.tagFilter].filter((t) => state.tagById.has(t));
      if (known.length !== ui.tagFilter.size) {
        ui.tagFilter = new Set(known);
        store('tagFilter', known);
      }
      state.loaded = true;
      pruneSelection();
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

let treeView = null; // filterView() for the current tree render

function renderTree() {
  const host = $('#tree');
  const q = ui.search.trim().toLowerCase();
  const vis = filterView();
  treeView = vis;
  renderTagFilter();
  renderTreeSelect();
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
    const hits = state.monitors.filter((m) => (!vis || vis.match.has(m.id)) && (m.name.toLowerCase().includes(q) || m.target.toLowerCase().includes(q))).sort(byName);
    fill(host, hits.length ? h('div', { class: 'branch root' }, hits.map((m) => row(m, null, `s${m.id}`, 0, false))) : h('p', { class: 'muted pad' }, 'No matches.'));
    return;
  }

  if (vis && !vis.match.size) {
    fill(host, h('p', { class: 'muted pad' }, 'No monitors have ', ui.tagFilter.size > 1 ? `${ui.tagMatch} of these tags.` : 'this tag.'));
    return;
  }

  ui.anyIcons = state.monitors.some((m) => m.icon);
  const roots = state.monitors.filter((m) => !m.parents.length && (!vis || vis.show.has(m.id))).sort(byName);
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
        if (ui.drag) move(ui.drag, null, false);
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

function renderTagFilter() {
  const box = $('#tag-filter');
  box.hidden = !state.tags.length;
  if (!state.tags.length) return fill(box);
  const on = ui.tagFilter.size > 0;
  fill(box,
    h('span', { class: 'tag-filter-label' }, 'Tags'),
    state.tags.map((t) => {
      const active = ui.tagFilter.has(t.id);
      return tagPill(t, {
        cls: active ? 'on' : on ? 'off' : '',
        pressed: String(active),
        title: active ? `Stop filtering by ${t.name}` : `Show only monitors tagged ${t.name}`,
        onclick: () => {
          const next = new Set(ui.tagFilter);
          if (active) next.delete(t.id);
          else next.add(t.id);
          setTagFilter(next);
        },
      });
    }),
    on && state.tags.length > 1 ? matchToggle() : null,
    on ? h('button', { class: 'linkish', onclick: () => setTagFilter([]) }, 'Clear') : null,
    h('a', { class: 'linkish', href: '#/tags' }, 'Manage'));
}

// Any of the tags (union) or all of them (intersection).
function matchToggle() {
  return h('span', { class: 'match-toggle', role: 'radiogroup', 'aria-label': 'Monitors must have' },
    Object.entries(TAG_MATCH).map(([mode, { label, title }]) => h('button', {
      type: 'button',
      class: `match-btn${ui.tagMatch === mode ? ' on' : ''}`,
      role: 'radio',
      'aria-checked': String(ui.tagMatch === mode),
      'aria-label': label,
      title,
      onclick: () => setTagFilter(ui.tagFilter, mode),
    }, matchIcon(mode))));
}

function tagDots(m) {
  const tags = tagsOf(m);
  if (!tags.length) return null;
  return h('span', { class: 'row-tags', title: `Tags: ${tags.map((t) => t.name).join(', ')}` },
    tags.slice(0, 5).map((t) => h('span', { class: 'tag-dot', style: { '--tag': t.color } })));
}

function branch(m, parentId, path, depth) {
  const kids = children(m).filter((k) => !treeView || treeView.show.has(k.id));
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
    class: `row ${m.status}${active ? ' active' : ''}${ui.selected.has(m.id) ? ' selected' : ''}${treeView && !treeView.match.has(m.id) ? ' context' : ''}`,
    draggable: ui.editMode ? 'true' : null,
    ondragstart: (e) => {
      ui.drag = dragSet(m.id, parentId);
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', ui.drag.ids.join(','));
      el.classList.add('dragging');
      if (ui.drag.ids.length > 1) {
        document.querySelectorAll('#tree .row.selected').forEach((r) => r.classList.add('dragging'));
        const ghost = h('div', { class: 'drag-ghost' }, `${ui.drag.ids.length} monitors`);
        document.body.append(ghost);
        e.dataTransfer.setDragImage(ghost, 14, 14);
        setTimeout(() => ghost.remove());
      }
    },
    ondragend: () => {
      ui.drag = null;
      document.querySelectorAll('.drop-target,.dragging').forEach((n) => n.classList.remove('drop-target', 'dragging'));
    },
    ondragover: (e) => {
      if (!ui.drag || !canDrop(ui.drag, m.id)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
      el.classList.add('drop-target');
    },
    ondragleave: () => el.classList.remove('drop-target'),
    ondrop: (e) => {
      e.preventDefault();
      el.classList.remove('drop-target');
      if (ui.drag && canDrop(ui.drag, m.id)) move(ui.drag, m.id, e.altKey);
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
  h('a', {
    class: 'row-main',
    href: `#/monitor/${m.id}`,
    draggable: 'false',
    onclick: (e) => {
      if (!e.shiftKey && !e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      toggleSelected(m.id, parentId);
    },
  },
    // With icons, the status dot sits on the icon's corner to save width.
    ui.anyIcons
      ? h('span', { class: `row-icon${m.icon ? '' : ' bare'}` }, iconEl(m.icon, 18), h('span', { class: `dot ${m.status}`, title: STATUS_LABEL[m.status] }))
      : h('span', { class: `dot ${m.status}`, title: STATUS_LABEL[m.status] }),
    h('span', { class: 'row-name' }, m.name),
    tagDots(m),
    otherParents.length ? h('span', { class: 'also', title: `Also under: ${otherParents.join(', ')}` }, '⑂') : null),
  ui.editMode
    ? h('span', { class: 'row-actions' },
      h('button', { class: 'icon-btn', title: 'Add a monitor under this one', onclick: () => go(`#/add?parent=${m.id}`) }, '+'),
      h('button', { class: 'icon-btn', title: 'Move…', onclick: () => moveDialog(dragSet(m.id, parentId)) }, '⇅'),
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

// What dragging (or ⇅ on) a row moves: the row's monitor, or the whole
// selection when the row is part of it. `from` maps each id to the parent
// it is moved away from (undefined = all of them, for monitors picked in
// the Falls).
function dragSet(id, parentId) {
  const ids = ui.selected.has(id) && ui.selected.size > 1 ? [...ui.selected] : [id];
  const from = new Map(ids.map((x) => [x, ui.selFrom.get(x)]));
  from.set(id, parentId);
  return { ids, from };
}

const selectionSet = () => ({ ids: [...ui.selected], from: new Map([...ui.selected].map((x) => [x, ui.selFrom.get(x)])) });

function canDrop({ ids }, targetId) {
  return !ids.includes(targetId) && !ids.some((id) => descendantsOf(id).has(targetId));
}

async function move({ ids, from }, toParentId, link) {
  if (ids.length === 1 && from.get(ids[0]) === toParentId) return;
  try {
    const res = await api('monitors/move', {
      method: 'POST',
      body: { moves: ids.map((id) => ({ id, fromParentId: from.get(id) })), toParentId, link },
    });
    const target = toParentId == null ? 'the top level' : state.byId.get(toParentId)?.name;
    const what = ids.length === 1 ? state.byId.get(ids[0])?.name : `${res.moved} monitor${res.moved === 1 ? '' : 's'}`;
    const along = res.along ? `, with ${res.along} more under ${res.moved === 1 ? 'it' : 'them'}` : '';
    toast(link ? `${what} ${res.moved === 1 ? 'is' : 'are'} now also under ${target}${along}` : `Moved ${what} to ${target}${along}`, 'success');
    if (!link) for (const id of ids) ui.selFrom.delete(id); // they are under new parents now
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

// Touch-friendly alternative to drag and drop, also for the whole selection.
function moveDialog(set) {
  const { ids, from } = set;
  const blocked = new Set(ids.flatMap((id) => [id, ...descendantsOf(id)]));
  const options = state.monitors.filter((x) => !blocked.has(x.id)).sort(byName);
  const one = ids.length === 1 ? state.byId.get(ids[0]) : null;
  const fromParentId = one ? from.get(one.id) : undefined;
  const select = h('select', { id: 'move-target' },
    h('option', { value: '' }, '— Top level (no parent) —'),
    options.map((o) => h('option', { value: o.id, selected: o.id === fromParentId }, o.name)));
  const keep = h('input', { type: 'checkbox', id: 'move-keep' });
  modal(one ? `Move ${one.name}` : `Move ${ids.length} monitors`, h('div', null,
    h('div', { class: 'field' }, h('label', { for: 'move-target' }, 'Place under'), select),
    one && fromParentId != null ? h('label', { class: 'check' }, keep,
      h('span', null, `Keep it under ${state.byId.get(fromParentId)?.name} too (add as an extra parent)`)) : null,
    one ? null : [
      h('label', { class: 'check' }, keep, h('span', null, 'Keep their current parents too (add as an extra parent)')),
      h('p', { class: 'muted small' }, 'A selected monitor whose parent is selected too stays under it, so whole branches move together.'),
    ]),
  [{
    label: 'Move',
    onClick: () => move(set, select.value ? Number(select.value) : null, keep.checked && select.value !== ''),
  }]);
}

function renderTreeSelect() {
  const box = $('#tree-select');
  const n = ui.selected.size;
  box.hidden = !n;
  if (!n) return fill(box);
  fill(box,
    h('div', { class: 'tree-select-head' },
      h('strong', null, `${n} selected`),
      h('button', { class: 'btn small', onclick: () => moveDialog(selectionSet()) }, 'Move…'),
      h('button', { class: 'btn small ghost', onclick: () => setSelection([]) }, 'Clear')),
    h('p', { class: 'muted small' }, ui.editMode ? 'Drag any of them to move them all.' : 'Shift-click to add or remove more. Tag them in the Falls.'));
}

// ---- layout: list width and pop-out -------------------------------------------

const SIDE_W = { min: 240, def: 340 };

function setSideWidth(px, save = true) {
  const handle = $('#side-resize');
  const max = Math.max(SIDE_W.min, Math.min(900, Math.round(window.innerWidth * 0.6)));
  const w = Math.round(Math.min(max, Math.max(SIDE_W.min, px)));
  document.documentElement.style.setProperty('--side-w', `${w}px`);
  handle.setAttribute('aria-valuemin', SIDE_W.min);
  handle.setAttribute('aria-valuemax', max);
  handle.setAttribute('aria-valuenow', w);
  if (save) store('sideWidth', w);
}

// Drag the handle (or use the arrow keys on it); double-click resets.
function initSideResize() {
  const handle = $('#side-resize');
  setSideWidth(storage('sideWidth', SIDE_W.def), false);
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = { x: e.clientX, w: $('.side').getBoundingClientRect().width };
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // pointer already gone
    }
    document.body.classList.add('resizing');
    const move = (ev) => setSideWidth(start.w + ev.clientX - start.x, false);
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      document.body.classList.remove('resizing');
      setSideWidth($('.side').getBoundingClientRect().width);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
  handle.addEventListener('dblclick', () => setSideWidth(SIDE_W.def));
  handle.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -16, ArrowRight: 16 }[e.key];
    if (!step) return;
    e.preventDefault();
    setSideWidth($('.side').getBoundingClientRect().width + step * (e.shiftKey ? 4 : 1));
  });
}

const popIcon = (out) => svg('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true' },
  svg('path', { d: out ? 'M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9' : 'M13.5 6.5h-4v-4M9.5 6.5L14 2M2.5 9.5h4v4M6.5 9.5L2 14' }));

function paintPopButton(btn, which, name) {
  if (!btn) return;
  const on = ui.popout === which;
  btn.setAttribute('aria-pressed', String(on));
  btn.title = on ? 'Back to the normal view (Esc)' : `Pop out the ${name}`;
  btn.setAttribute('aria-label', btn.title);
  fill(btn, popIcon(!on));
}

// Pop the monitor list or the Falls out to fill the window (null = neither).
function setPopout(which) {
  ui.popout = which;
  document.body.classList.toggle('popout', Boolean(which));
  document.body.classList.toggle('popout-side', which === 'side');
  document.body.classList.toggle('popout-falls', which === 'falls');
  paintPopButton($('#side-pop'), 'side', 'monitor list');
  paintPopButton($('#falls-pop'), 'falls', 'Falls');
  flow?.setExpanded(which === 'falls');
}

// ---- dashboard --------------------------------------------------------------

let flow;
let eventsCache = { at: 0, version: -1, list: [] };

async function renderDashboard(isUpdate = false) {
  const main = $('#main');
  if (!isUpdate || !main.querySelector('.dashboard')) {
    const flowBox = h('div', { class: 'flow-map' });
    flow = new FlowView(flowBox, {
      onSelect: selectNode,
      onExpand: expandNode,
      onClear: () => (ui.selected.size ? setSelection([]) : setFocus(null, null)),
      onToggle: (id) => toggleSelected(id),
      onMarquee: setSelection,
      view: ui.flowView,
    });
    fill(main, h('div', { class: 'dashboard' },
      h('div', { class: 'stat-row', id: 'dash-stats' }),
      h('section', { class: 'card falls' },
        h('div', { class: 'card-head' },
          h('div', { class: 'falls-title' }, h('h2', null, 'The Falls'), h('div', { id: 'flow-focus', class: 'flow-focus', 'aria-live': 'polite' })),
          h('div', { class: 'falls-tools' },
            h('div', { class: 'legend' },
              h('span', { class: 'key flow' }, 'Flowing'),
              h('span', { class: 'key dry' }, 'Dry — source down'),
              h('span', { class: 'key still' }, 'Still — blocked/paused')),
            h('button', {
              id: 'falls-pop',
              class: 'btn small pop-btn',
              onclick: () => setPopout(ui.popout === 'falls' ? null : 'falls'),
            }),
            h('button', {
              id: 'select-toggle',
              class: 'btn small',
              title: 'Select monitors to tag or move them. Shortcut: shift-click, or hold shift and drag a box.',
              onclick: () => {
                ui.selectMode = !ui.selectMode;
                if (!ui.selectMode) ui.selected.clear();
                renderDashboard(true);
              },
            }, 'Select'))),
        h('div', { id: 'falls-body', class: 'falls-body' },
          h('div', { class: 'falls-diagram' }, flowBox, h('div', { id: 'flow-empty' })),
          h('aside', { id: 'flow-info', class: 'flow-info', 'aria-label': 'Monitor details', hidden: true })),
        // Below the diagram and sticky, so it never pushes the nodes around.
        h('div', { id: 'flow-select', class: 'flow-select', 'aria-live': 'polite', hidden: true })),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, 'Recent events')),
        h('div', { id: 'dash-events' }))));
    paintPopButton($('#falls-pop'), 'falls', 'Falls');
  }
  const c = counts();
  fill($('#dash-stats'),
    ['up', 'down', 'blocked', 'pending', 'paused'].map((k) => h('div', { class: `stat ${k}` },
      h('div', { class: 'stat-num' }, c[k]),
      h('div', { class: 'stat-label' }, h('span', { class: `dot ${k}` }), STATUS_LABEL[k]))));

  const vis = filterView();
  if (!state.byId.has(ui.focus) || (vis && !vis.show.has(ui.focus))) ui.focus = null;
  if (!state.byId.has(ui.info)) ui.info = null;
  const shown = state.monitors.filter((m) => !vis || vis.show.has(m.id))
    .map((m) => ({ ...m, tagList: tagsOf(m), context: Boolean(vis && !vis.match.has(m.id)) }));
  flow.render(shown, ui.focus, { selected: ui.selected, selectMode: ui.selectMode });
  const toggle = $('#select-toggle');
  toggle.setAttribute('aria-pressed', String(ui.selectMode));
  toggle.textContent = ui.selectMode ? 'Done selecting' : 'Select';
  renderFocusBar(vis);
  renderSelectBar();
  renderInfo();
  fill($('#flow-empty'), state.loaded && state.monitors.length && !shown.length
    ? h('div', { class: 'empty' }, h('p', null, 'No monitors have the tags you are filtering by.'),
      h('button', { class: 'btn', onclick: () => setTagFilter([]) }, 'Clear the filter'))
    : state.loaded && !state.monitors.length
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

// Clicking a node traces its lineage; clicking it again shows everything.
function selectNode(id) {
  if (ui.focus === id) setFocus(null, null);
  else setFocus(id, ui.info == null ? null : id);
}

function expandNode(id) {
  setFocus(id, ui.info === id ? null : id);
}

async function applyTag(tag, ids, remove) {
  try {
    const res = await api(`tags/${tag.id}/apply`, { method: 'POST', body: { monitorIds: ids, downstream: ui.tagDownstream, remove } });
    const n = res.monitors === 1 ? '1 monitor' : `${res.monitors} monitors`;
    toast(remove ? `Removed ${tag.name} from ${n}` : `Tagged ${n} with ${tag.name}`, 'success');
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// Shown while monitors are selected: each tag's state across the selection
// (and with "Include downstream", everything below it too).
function renderSelectBar() {
  const box = $('#flow-select');
  const ids = [...ui.selected];
  box.hidden = !ids.length && !ui.selectMode;
  if (box.hidden) return fill(box);
  if (!ids.length) {
    return fill(box, h('span', { class: 'muted small' },
      'Tap monitors to select them, or drag a box around them. Then pick tags to add or remove. Two fingers move and zoom the map.'));
  }
  const targets = new Set(ids);
  if (ui.tagDownstream) for (const id of ids) for (const d of descendantsOf(id)) targets.add(d);
  const list = [...targets].map((id) => state.byId.get(id)).filter(Boolean);
  const extra = list.length - ids.length;
  fill(box,
    h('div', { class: 'sel-head' },
      h('strong', null, `${ids.length} selected`),
      extra ? h('span', { class: 'muted small' }, ` + ${extra} downstream`) : null,
      h('label', { class: 'check sel-down' },
        h('input', {
          type: 'checkbox',
          checked: ui.tagDownstream,
          onchange: (e) => {
            ui.tagDownstream = e.target.checked;
            store('tagDownstream', ui.tagDownstream);
            renderSelectBar();
          },
        }),
        h('span', null, 'Include downstream')),
      h('button', { class: 'btn small ghost', onclick: () => setSelection([]) }, 'Clear')),
    h('div', { class: 'sel-tags' },
      state.tags.map((t) => {
        const n = list.filter((m) => m.tags.includes(t.id)).length;
        const all = n === list.length;
        return tagPill(t, {
          cls: `sel-tag ${all ? 'on' : n ? 'some' : 'none'}`,
          pressed: all ? 'true' : n ? 'mixed' : 'false',
          title: all ? `Remove ${t.name} from all ${list.length}` : n ? `Add ${t.name} to the other ${list.length - n}` : `Add ${t.name} to ${list.length === 1 ? 'it' : `all ${list.length}`}`,
          extra: h('span', { class: 'tag-state', 'aria-hidden': 'true' }, all ? '✓' : n ? `${n}/${list.length}` : '+'),
          onclick: () => applyTag(t, ids, all),
        });
      }),
      h('button', { class: 'btn small ghost', onclick: () => newTagDialog(state.tags, (tag) => applyTag(tag, ids, false)) }, '+ New tag')));
}

function setFocus(focus, info) {
  ui.focus = focus;
  ui.info = info;
  // Keep the URL shareable without triggering a re-route (which would
  // rebuild the diagram and skip the animation).
  const qs = new URLSearchParams();
  if (focus != null) qs.set('focus', focus);
  if (info != null) qs.set('info', info);
  history.replaceState(null, '', `#/${qs.size ? `?${qs}` : ''}`);
  renderDashboard(true);
  if (info != null && matchMedia('(max-width: 1100px)').matches) $('#flow-info')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderFocusBar(vis) {
  const f = state.byId.get(ui.focus);
  const filtered = state.tags.filter((t) => ui.tagFilter.has(t.id));
  const filterChip = vis ? h('span', { class: 'focus-chip filter-chip' },
    filtered.length > 1 ? h('span', { class: 'filter-match', title: TAG_MATCH[ui.tagMatch].title }, matchIcon(ui.tagMatch)) : null,
    filtered.map((t) => tagPill(t)),
    h('span', { class: 'muted' }, `${vis.match.size} of ${state.monitors.length}`),
    h('button', { class: 'chip-x', 'aria-label': 'Clear the tag filter', title: 'Clear the tag filter', onclick: () => setTagFilter([]) }, '×')) : null;
  if (!f) {
    fill($('#flow-focus'), filterChip, state.monitors.length && !vis ? h('span', { class: 'muted small' }, 'Click a monitor to trace what it depends on') : null);
    return;
  }
  const rel = lineage(state.monitors, f.id);
  fill($('#flow-focus'),
    filterChip,
    h('span', { class: 'focus-chip' },
      h('span', { class: `dot ${f.status}` }),
      h('span', null, f.name),
      h('span', { class: 'muted' }, ` · ${rel.up.size} upstream · ${rel.down.size} downstream`)),
    h('button', { class: 'btn small', onclick: () => setFocus(null, null) }, 'Show all'));
}

function renderInfo() {
  const box = $('#flow-info');
  const m = state.byId.get(ui.info);
  $('#falls-body').classList.toggle('with-info', Boolean(m));
  box.hidden = !m;
  if (!m) return fill(box);

  const rel = lineage(state.monitors, m.id);
  // closest first
  const ordered = (dist) => [...dist].map(([id, d]) => [state.byId.get(id), d]).filter(([x]) => x)
    .sort((a, b) => a[1] - b[1] || byName(a[0], b[0])).map(([x]) => x);
  const chips = (list, empty) => list.length
    ? h('div', { class: 'chips' }, list.map((x) => h('button', {
      type: 'button',
      class: 'chip link',
      title: `Focus on ${x.name}`,
      onclick: () => setFocus(x.id, x.id),
    }, h('span', { class: `dot ${x.status}` }), iconEl(x.icon, 14), x.name)))
    : h('p', { class: 'muted small' }, empty);
  const up = ordered(rel.up);
  const down = ordered(rel.down);
  const stat = (label, value) => h('div', null, h('dt', null, label), h('dd', null, value));

  fill(box,
    h('div', { class: 'info-head' },
      iconEl(m.icon, 30),
      h('div', { class: 'info-title' },
        h('h3', null, m.name),
        h('div', { class: 'target' }, TYPE_LABEL[m.type], m.target && m.type !== 'push' ? ` · ${m.target}` : '')),
      h('button', { class: 'icon-btn', 'aria-label': 'Close details', title: 'Close', onclick: () => setFocus(ui.focus, null) }, '×')),
    h('div', { class: 'info-status' },
      h('span', { class: `badge ${m.status}` }, STATUS_LABEL[m.status]),
      m.type === 'group' ? null : h('span', { class: 'muted small' }, `checked ${fmtAgo(m.lastCheck)} · every ${m.interval}s`)),
    m.msg ? h('p', { class: 'info-msg' }, m.msg) : null,
    m.description ? h('p', { class: 'muted small' }, m.description) : null,
    h('div', { class: 'info-tags' },
      tagsOf(m).map((t) => tagPill(t)),
      h('button', {
        class: 'linkish',
        title: 'Select this monitor to add or remove tags',
        onclick: () => {
          setSelection([m.id]);
          $('#flow-select')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        },
      }, m.tags.length ? 'Edit tags' : '+ Add tags')),
    m.type === 'group' ? null : [
      h('dl', { class: 'info-stats' },
        stat('Response', fmtMs(m.ping)),
        stat('Avg · 24h', fmtMs(m.avgPing24)),
        stat('Uptime · 24h', fmtPct(m.uptime24))),
      heartbeatBar(m.beats, 30),
    ],
    h('div', { class: 'info-rel' },
      h('h4', null, h('span', { class: 'rel-icon up' }, '↑'), 'Depends on', h('span', { class: 'count' }, up.length)),
      chips(up, 'Nothing. This is a top-level monitor.'),
      m.parents.length > 1 ? h('p', { class: 'muted small' }, m.parentMode === 'any' ? 'Blocked only when every parent is down.' : 'Blocked when any parent is down.') : null),
    h('div', { class: 'info-rel' },
      h('h4', null, h('span', { class: 'rel-icon down' }, '↓'), 'Feeds', h('span', { class: 'count' }, down.length)),
      chips(down, 'Nothing depends on this.')),
    h('div', { class: 'info-actions' },
      m.type !== 'group' ? h('button', { class: 'btn small', onclick: () => action(`monitors/${m.id}/check`, 'Checked') }, 'Check now') : null,
      h('a', { class: 'btn small', href: `#/monitor/${m.id}/edit` }, 'Edit'),
      h('a', { class: 'btn small primary', href: `#/monitor/${m.id}` }, 'Full details →')));
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
        h('h1', null, iconEl(m.icon, 30), m.name, ' ', h('span', { class: `badge big ${m.status}` }, STATUS_LABEL[m.status])),
        h('div', { class: 'target' }, TYPE_LABEL[m.type], m.target && m.type !== 'push' ? ` · ${m.target}` : ''),
        m.tags.length ? h('div', { class: 'detail-tags' }, tagsOf(m).map((t) => tagPill(t, {
          title: `Show everything tagged ${t.name}`,
          onclick: () => {
            setTagFilter([t.id]);
            go('#/');
          },
        }))) : null,
        m.description ? h('p', { class: 'muted' }, m.description) : null),
      h('div', { class: 'actions' },
        m.type !== 'group' ? h('button', { class: 'btn', onclick: () => action(`monitors/${id}/check`, 'Checked') }, 'Check now') : null,
        h('button', {
          class: 'btn',
          title: 'Show what this depends on and what depends on it',
          onclick: () => go(`#/?focus=${id}`),
        }, 'Trace in Falls'),
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

// ---- tags -------------------------------------------------------------------

async function renderTags() {
  const tags = await api('tags');
  const reload = async () => {
    await refresh();
    if (ui.route?.name === 'tags') renderTags();
  };
  const editor = (t) => {
    const save = async (patch) => {
      try {
        await api(`tags/${t.id}`, { method: 'PUT', body: { name: t.name, color: t.color, ...patch } });
      } catch (err) {
        toast(err.message, 'error');
      }
      reload();
    };
    return h('div', { class: 'tag-item' },
      h('div', { class: 'tag-item-name' },
        tagPill(t),
        h('input', {
          value: t.name,
          maxlength: 32,
          'aria-label': `Rename ${t.name}`,
          onchange: (e) => save({ name: e.target.value }),
          onkeydown: (e) => e.key === 'Enter' && e.target.blur(),
        })),
      colorPicker(t.color, (c) => save({ color: c }), `Colour for ${t.name}`),
      h('div', { class: 'tag-item-meta' },
        t.count
          ? h('button', {
            class: 'btn small',
            title: `Show the monitors tagged ${t.name} in the Falls`,
            onclick: () => {
              setTagFilter([t.id]);
              go('#/');
            },
          }, `${t.count} monitor${t.count === 1 ? '' : 's'} →`)
          : h('span', { class: 'muted small' }, 'Not on any monitor'),
        h('button', {
          class: 'btn small danger ghost',
          onclick: () => confirmDialog(`Delete ${t.name}?`,
            t.count ? `It comes off ${t.count === 1 ? 'the 1 monitor' : `all ${t.count} monitors`} using it. The monitors themselves are not touched.` : 'No monitor uses it.',
            'Delete', async () => {
              await api(`tags/${t.id}`, { method: 'DELETE' });
              toast(`Deleted ${t.name}`, 'success');
              reload();
            }),
        }, 'Delete')));
  };
  fill($('#main'), h('div', { class: 'stack' },
    h('div', { class: 'page-head' },
      h('h1', null, 'Tags'),
      h('button', { class: 'btn primary', onclick: () => newTagDialog(tags, reload) }, '+ New tag'),
      h('p', { class: 'muted' }, 'Group monitors across the hierarchy, by site, owner or anything else. Filter by tag in the sidebar: pick several tags and choose whether a monitor needs any of them or all of them. To tag several monitors at once, select them: shift-click them in the Falls or the monitor list, or shift-drag a box in the Falls.')),
    tags.length
      ? h('div', { class: 'card tag-list' }, tags.map(editor))
      : h('div', { class: 'card' }, h('p', { class: 'muted' }, 'No tags yet.'))));
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
    csvCard(),
    h('div', { class: 'card' },
      h('h3', null, 'About'),
      h('p', null, `Waterfall Alert ${info.version}${info.addon ? ' · running as a Home Assistant add-on' : ' · standalone'}`),
      h('p', { class: 'muted' }, 'Monitors are checked top-down. When something fails, its parents are re-checked first, so you get one alert for the real cause listing everything downstream of it.'))));
}

const CSV_GUIDE = 'https://github.com/big-barlowe/WaterfallAlert/blob/main/docs/csv.md';

const IMPORT_MODES = [
  ['add', 'Add every row as a new monitor', 'For a new install, or when the file only has new monitors.'],
  ['update', 'Update monitors with the same name', 'Edit monitors in bulk: export, change the file, import. Rows with new names are added.'],
  ['skip', 'Skip monitors that already exist', 'Only add the rows whose name isn’t taken yet.'],
];

function csvCard() {
  let text = null;
  let fileName = '';
  let mode = 'add';
  const result = h('div', { class: 'csv-result', 'aria-live': 'polite' });
  const fileInput = h('input', {
    type: 'file',
    id: 'csv-file',
    accept: '.csv,text/csv',
    onchange: async (e) => {
      const file = e.target.files[0];
      text = file ? await file.text() : null;
      fileName = file?.name ?? '';
      check();
    },
  });

  const issueList = (items, cls) => h('ul', { class: `csv-issues ${cls}` },
    items.slice(0, 50).map((i) => h('li', null, i.line ? h('span', { class: 'csv-line' }, `Line ${i.line}`) : null, i.message)),
    items.length > 50 ? h('li', { class: 'muted' }, `…and ${items.length - 50} more`) : null);
  const counts = (r, verbs) => [
    r.created && `${r.created} ${verbs[0]}`,
    r.updated && `${r.updated} ${verbs[1]}`,
    r.skipped && `${r.skipped} skipped`,
    r.tagsCreated && `${r.tagsCreated} new tag${r.tagsCreated === 1 ? '' : 's'}`,
  ].filter(Boolean).join(' · ') || 'nothing to change';

  async function check() {
    if (!text) return fill(result);
    fill(result, h('p', { class: 'muted small' }, 'Checking…'));
    try {
      const r = await api('csv/import', { method: 'POST', body: { csv: text, mode, dryRun: true } });
      if (!r.ok) {
        return fill(result, h('div', { class: 'csv-box bad' },
          h('strong', null, `${fileName}: ${r.errors.length} problem${r.errors.length === 1 ? '' : 's'}. Nothing will be imported until they are fixed.`),
          issueList(r.errors, 'errors'),
          r.warnings.length ? [h('p', { class: 'small' }, 'Also:'), issueList(r.warnings, 'warnings')] : null));
      }
      fill(result, h('div', { class: 'csv-box ok' },
        h('strong', null, `${fileName}: ${counts(r, ['to add', 'to update'])}`),
        r.warnings.length ? issueList(r.warnings, 'warnings') : null,
        h('div', { class: 'form-actions' },
          h('button', { type: 'button', class: 'btn primary', disabled: !(r.created || r.updated), onclick: run }, 'Import'))));
    } catch (err) {
      fill(result, h('div', { class: 'csv-box bad' }, err.message));
    }
  }

  async function run() {
    try {
      const r = await api('csv/import', { method: 'POST', body: { csv: text, mode } });
      if (!r.applied) return check();
      toast(`Imported: ${counts(r, ['added', 'updated'])}`, 'success');
      fill(result, h('div', { class: 'csv-box ok' }, h('strong', null, `Done: ${counts(r, ['added', 'updated'])}.`), ' ', h('a', { href: '#/' }, 'See them in the Falls →')));
      text = null;
      fileInput.value = '';
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  const reference = h('div', { class: 'table-scroll' }, h('p', { class: 'muted small' }, 'Loading…'));
  const loadReference = async () => {
    const cols = await api('csv/columns');
    const label = (types) => types.map((t) => TYPE_LABEL[t] ?? t).join(', ');
    fill(reference, h('table', { class: 'csv-columns' },
      h('thead', null, h('tr', null, h('th', null, 'Column'), h('th', null, 'Used by'), h('th', null, 'Values'), h('th', null, 'Notes'))),
      h('tbody', null, cols.map((c) => h('tr', null,
        h('td', null, h('code', null, c.name)),
        h('td', null, c.types ? label(c.types) : 'All',
          c.required ? h('div', { class: 'csv-req' }, !c.types || c.required.length === c.types.length ? 'required' : `required for ${label(c.required)}`) : null),
        h('td', null, c.values ? c.values.map((v) => h('code', { class: 'csv-val' }, v)) : null,
          c.def != null ? h('div', { class: 'muted small' }, 'default ', h('code', null, String(c.def))) : null),
        h('td', { class: 'csv-help' }, c.help ?? ''))))));
  };

  return h('section', { class: 'card csv-card' },
    h('h3', null, 'Import & export monitors'),
    h('p', { class: 'muted' }, 'Move monitors to another install, or edit many at once in a spreadsheet. Exports and imports use the same columns, so an exported file imports as it is: hierarchy, settings, tags, icons and notification choices included. Notification channels themselves are not exported, since they hold passwords and tokens; create them on the new install first, with the same names.'),
    h('div', { class: 'csv-downloads' },
      h('a', { class: 'btn primary', href: 'api/csv/export', download: '' }, 'Export all monitors (CSV)'),
      h('a', { class: 'btn', href: 'api/csv/template', download: '' }, 'Blank template'),
      h('a', { class: 'btn', href: 'api/csv/example', download: '' }, 'Example file')),
    h('h4', null, 'Import'),
    h('div', { class: 'field' }, h('label', { for: 'csv-file' }, 'CSV file'), fileInput),
    h('fieldset', { class: 'csv-modes' },
      h('legend', null, 'When a monitor with the same name already exists'),
      IMPORT_MODES.map(([value, title, help]) => h('label', { class: 'check' },
        h('input', {
          type: 'radio',
          name: 'csv-mode',
          value,
          checked: value === mode,
          onchange: () => {
            mode = value;
            check();
          },
        }),
        h('span', null, title, h('small', null, help))))),
    h('p', { class: 'help' }, 'Choosing a file only checks it. Nothing changes until you press Import, and a file with any problem imports nothing.'),
    result,
    h('details', { class: 'csv-ref', ontoggle: (e) => e.target.open && loadReference() },
      h('summary', null, 'Column reference'),
      h('p', { class: 'small' }, 'One row per monitor; the first row holds the column names. Only ', h('code', null, 'name'), ' is needed in every file, and columns can be in any order. ',
        'Lists (parents, tags, notifications) are separated by ', h('code', null, '|'), '. A column that is missing keeps the current value (or the default, for new monitors); a column that is there but blank means the default. ',
        h('a', { href: CSV_GUIDE, target: '_blank', rel: 'noopener' }, 'Full guide with examples on GitHub ↗')),
      reference));
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
  if (parts[0] === 'tags') return { name: 'tags' };
  const num = (k) => (params.get(k) ? Number(params.get(k)) : null);
  return { name: 'dashboard', focus: num('focus'), info: num('info') };
}

async function route() {
  if (ui.popout) setPopout(null);
  ui.route = parseRoute();
  const r = ui.route;
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('on', a.dataset.route === (r.name === 'monitor' || r.name === 'edit' || r.name === 'add' ? 'dashboard' : r.name)));
  document.body.classList.toggle('show-tree', r.name === 'dashboard');
  renderTree();
  window.scrollTo({ top: 0 });
  if (r.name === 'dashboard') {
    ui.focus = r.focus;
    ui.info = r.info;
  }
  try {
    if (r.name === 'dashboard') await renderDashboard();
    else if (r.name === 'monitor') await renderDetail(r.id);
    else if (r.name === 'edit') await renderMonitorForm($('#main'), { state, id: r.id, navigate: go });
    else if (r.name === 'add') await renderMonitorForm($('#main'), { state, presetParent: r.parent, navigate: go });
    else if (r.name === 'alerts') await renderAlerts();
    else if (r.name === 'notifications') await renderNotifications();
    else if (r.name === 'settings') await renderSettings();
    else if (r.name === 'tags') await renderTags();
  } catch (err) {
    fill($('#main'), h('div', { class: 'card' }, h('p', null, `Something went wrong: ${err.message}`)));
  }
}

// ---- boot -------------------------------------------------------------------

$('#side-pop').addEventListener('click', () => setPopout(ui.popout === 'side' ? null : 'side'));
initSideResize();
setPopout(null);
$('#edit-toggle').addEventListener('click', () => {
  ui.editMode = !ui.editMode;
  renderTree();
});
$('#search').addEventListener('input', (e) => {
  ui.search = e.target.value;
  renderTree();
});
window.addEventListener('hashchange', route);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.querySelector('.modal-back')) return;
  if (ui.selected.size) return setSelection([]);
  // Undo the Falls' own state first, unless only the list is in view.
  if (ui.route?.name === 'dashboard' && ui.popout !== 'side') {
    if (ui.selectMode) {
      ui.selectMode = false;
      return renderDashboard(true);
    }
    if (ui.info != null) return setFocus(ui.focus, null);
    if (ui.focus != null) return setFocus(null, null);
  }
  if (ui.popout) setPopout(null);
});
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
