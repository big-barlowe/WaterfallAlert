import { svg, STATUS_LABEL, TYPE_LABEL, fmtMs, fill } from './util.js';

const NODE_W = 172;
const NODE_H = 54;
const SLOT_W = 192;
const LEVEL_H = 112;
const PAD = 28;
const SOURCE_H = 70;

// Layered "waterfall" layout: roots at the top, every child strictly below
// all of its parents. Each node hangs under its deepest parent (its
// "primary" parent) for a tidy tree; extra parents get secondary streams.
function layout(monitors) {
  const byId = new Map(monitors.map((m) => [m.id, m]));
  const level = new Map();
  const levelOf = (id) => {
    if (level.has(id)) return level.get(id);
    level.set(id, 0); // guard; the server rejects cycles
    const m = byId.get(id);
    const l = m.parents.length ? 1 + Math.max(...m.parents.map(levelOf)) : 0;
    level.set(id, l);
    return l;
  };
  monitors.forEach((m) => levelOf(m.id));

  const byName = (a, b) => byId.get(a).name.localeCompare(byId.get(b).name, undefined, { numeric: true });
  const primary = new Map();
  for (const m of monitors) {
    if (!m.parents.length) continue;
    const deepest = [...m.parents].sort((a, b) => level.get(b) - level.get(a) || byName(a, b))[0];
    primary.set(m.id, deepest);
  }
  const kids = new Map(monitors.map((m) => [m.id, []]));
  for (const [child, parent] of primary) kids.get(parent).push(child);
  for (const list of kids.values()) list.sort(byName);

  const slot = new Map();
  let next = 0;
  const place = (id) => {
    const k = kids.get(id);
    if (!k.length) {
      slot.set(id, next++);
      return;
    }
    k.forEach(place);
    slot.set(id, (slot.get(k[0]) + slot.get(k[k.length - 1])) / 2);
  };
  const roots = monitors.filter((m) => !m.parents.length).map((m) => m.id).sort(byName);
  roots.forEach((r, i) => {
    if (i) next += 0.25;
    place(r);
  });

  const pos = new Map();
  for (const m of monitors) {
    pos.set(m.id, { x: PAD + slot.get(m.id) * SLOT_W, y: PAD + SOURCE_H + level.get(m.id) * LEVEL_H });
  }
  const maxLevel = Math.max(0, ...level.values());
  return {
    pos,
    roots,
    primary,
    width: PAD * 2 + Math.max(1, next) * SLOT_W - (SLOT_W - NODE_W),
    height: PAD * 2 + SOURCE_H + maxLevel * LEVEL_H + NODE_H,
  };
}

// What a parent sends downstream: flowing water, a dry bed, or still water.
function streamState(m) {
  if (!m) return 'flow';
  if (m.type === 'group') return m.status === 'blocked' ? 'still' : 'flow';
  if (m.status === 'down') return 'dry';
  if (m.status === 'blocked' || m.status === 'paused') return 'still';
  return 'flow';
}

function curve(x1, y1, x2, y2) {
  const ym = (y1 + y2) / 2;
  return `M${x1},${y1} C${x1},${ym} ${x2},${ym} ${x2},${y2}`;
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function subline(m) {
  if (m.type === 'group') return `Group · ${m.children.length} inside`;
  if (m.status === 'blocked') return 'Blocked upstream';
  if (m.status === 'down') return truncate(m.msg || 'Down', 24);
  if (m.status === 'paused') return 'Paused';
  return `${TYPE_LABEL[m.type]} · ${fmtMs(m.ping)}`;
}

export class FlowView {
  constructor(container, onOpen) {
    this.container = container;
    this.onOpen = onOpen;
    this.topology = null;
  }

  render(monitors) {
    if (!monitors.length) {
      fill(this.container);
      this.topology = null;
      return;
    }
    const key = JSON.stringify(monitors.map((m) => [m.id, m.name, m.parents]));
    if (key !== this.topology) this.#build(monitors, key);
    this.#paint(monitors);
  }

  #build(monitors, key) {
    this.topology = key;
    const { pos, roots, width, height } = layout(monitors);
    const byId = new Map(monitors.map((m) => [m.id, m]));
    const srcX = (Math.min(...roots.map((r) => pos.get(r).x)) + Math.max(...roots.map((r) => pos.get(r).x))) / 2 + NODE_W / 2;
    const srcY = PAD + 14;

    const edges = svg('g', { class: 'edges' });
    const nodes = svg('g', { class: 'nodes' });
    this.edgeEls = [];
    this.nodeEls = new Map();

    const addEdge = (parentId, childId, d) => {
      const g = svg('g', { class: 'stream' },
        svg('path', { class: 'bed', d }),
        svg('path', { class: 'water', d }),
        svg('path', { class: 'sparkle', d }));
      edges.append(g);
      this.edgeEls.push({ parentId, childId, g });
    };

    for (const r of roots) {
      const p = pos.get(r);
      addEdge(null, r, curve(srcX, srcY + 10, p.x + NODE_W / 2, p.y));
    }
    for (const m of monitors) {
      const c = pos.get(m.id);
      for (const parentId of m.parents) {
        const p = pos.get(parentId);
        if (!p) continue;
        addEdge(parentId, m.id, curve(p.x + NODE_W / 2, p.y + NODE_H, c.x + NODE_W / 2, c.y));
      }
    }

    for (const m of monitors) {
      const { x, y } = pos.get(m.id);
      const title = svg('title');
      const name = svg('text', { class: 'name', x: 30, y: 23 }, truncate(m.name, 18));
      const sub = svg('text', { class: 'sub', x: 30, y: 41 });
      const g = svg('g', {
        class: 'node',
        transform: `translate(${x},${y})`,
        tabindex: 0,
        role: 'link',
        'aria-label': m.name,
        onclick: () => this.onOpen(m.id),
        onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && this.onOpen(m.id),
      },
      title,
      svg('rect', { class: 'pool', width: NODE_W, height: NODE_H, rx: 14 }),
      svg('circle', { class: 'ripple', cx: 16, cy: 27, r: 5 }),
      svg('circle', { class: 'dot', cx: 16, cy: 27, r: 5 }),
      name,
      sub,
      byId.get(m.id).parents.length > 1 ? svg('text', { class: 'multi', x: NODE_W - 12, y: 18, 'text-anchor': 'end' }, `⑂${m.parents.length}`) : null);
      nodes.append(g);
      this.nodeEls.set(m.id, { g, title, sub });
    }

    const source = svg('g', { class: 'source' },
      svg('circle', { cx: srcX, cy: srcY, r: 10, class: 'spring' }),
      svg('circle', { cx: srcX, cy: srcY, r: 10, class: 'spring-ring' }));

    const root = svg('svg', {
      class: 'flow-svg',
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': 'Monitor hierarchy flow diagram',
    },
    svg('defs', {},
      svg('filter', { id: 'glow', x: '-50%', y: '-50%', width: '200%', height: '200%' },
        svg('feGaussianBlur', { stdDeviation: 3.2, result: 'b' }),
        svg('feMerge', {}, svg('feMergeNode', { in: 'b' }), svg('feMergeNode', { in: 'SourceGraphic' })))),
    edges, nodes, source);
    fill(this.container, root);
  }

  // Update colours and text in place so the flow animation never restarts.
  #paint(monitors) {
    const byId = new Map(monitors.map((m) => [m.id, m]));
    for (const { parentId, childId, g } of this.edgeEls) {
      const state = parentId == null ? 'flow' : streamState(byId.get(parentId));
      const child = byId.get(childId);
      g.setAttribute('class', `stream ${state} to-${child?.status}`);
    }
    for (const [id, { g, title, sub }] of this.nodeEls) {
      const m = byId.get(id);
      if (!m) continue;
      g.setAttribute('class', `node ${m.status} type-${m.type}`);
      sub.textContent = subline(m);
      title.textContent = `${m.name} — ${STATUS_LABEL[m.status]}${m.msg ? `\n${m.msg}` : ''}`;
    }
  }
}
