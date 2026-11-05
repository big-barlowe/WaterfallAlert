import { svg, STATUS_LABEL, TYPE_LABEL, fmtMs, fill } from './util.js';
import { iconSvg } from './icons.js';

const NODE_W = 184;
const NODE_H = 56;
const SLOT_W = 204;
const LEVEL_H = 112;
const PAD = 28;
const SOURCE_H = 70;
const BADGE = { cx: 26, cy: 28, r: 15 };
const TEXT_X = 50;

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Everything upstream and downstream of `id`, each with its distance in hops.
export function lineage(monitors, id) {
  const byId = new Map(monitors.map((m) => [m.id, m]));
  const walk = (key) => {
    const dist = new Map();
    let frontier = [id];
    for (let d = 1; frontier.length; d++) {
      const next = [];
      for (const x of frontier) {
        for (const y of byId.get(x)?.[key] ?? []) {
          if (y === id || dist.has(y)) continue;
          dist.set(y, d);
          next.push(y);
        }
      }
      frontier = next;
    }
    return dist;
  };
  return { up: walk('parents'), down: walk('children') };
}

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

const glowFilter = (id, region) => svg('filter', { id, ...region },
  svg('feGaussianBlur', { stdDeviation: 3.2, result: 'b' }),
  svg('feMerge', {}, svg('feMergeNode', { in: 'b' }), svg('feMergeNode', { in: 'SourceGraphic' })));

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const iconKey = (i) => (i ? `${i.kind}:${i.src ?? i.name ?? i.value}` : '');

function subline(m) {
  if (m.type === 'group') return `Group · ${m.children.length} inside`;
  if (m.status === 'blocked') return 'Blocked upstream';
  if (m.status === 'down') return truncate(m.msg || 'Down', 22);
  if (m.status === 'paused') return 'Paused';
  if (m.type === 'minecraft' && /players/.test(m.msg)) return `${m.msg.split(' · ')[0]} · ${fmtMs(m.ping)}`;
  return `${TYPE_LABEL[m.type]} · ${fmtMs(m.ping)}`;
}

// Callbacks: onSelect(id) when a node is clicked, onExpand(id) for its
// expand button, onClear() for a click on empty water.
export class FlowView {
  constructor(container, { onSelect, onExpand, onClear }) {
    this.container = container;
    this.onSelect = onSelect;
    this.onExpand = onExpand;
    this.onClear = onClear;
    this.topology = null;
    this.nodeEls = new Map();
  }

  // With `focusId`, only that monitor's upstream and downstream are drawn.
  render(monitors, focusId = null) {
    if (!monitors.length) {
      fill(this.container);
      this.topology = null;
      this.nodeEls = new Map();
      return;
    }
    const focus = monitors.some((m) => m.id === focusId) ? focusId : null;
    let shown = monitors;
    let rel = null;
    if (focus != null) {
      rel = lineage(monitors, focus);
      const keep = new Set([focus, ...rel.up.keys(), ...rel.down.keys()]);
      shown = monitors.filter((m) => keep.has(m.id)).map((m) => ({ ...m, parents: m.parents.filter((p) => keep.has(p)), allParents: m.parents }));
    }
    const key = JSON.stringify([focus, shown.map((m) => [m.id, m.name, m.parents, iconKey(m.icon)])]);
    if (key !== this.topology) this.#build(shown, key, focus, rel);
    this.#paint(monitors);
  }

  #build(monitors, key, focus, rel) {
    // Where each node is on screen now, so moved nodes can glide over.
    const before = new Map([...this.nodeEls].map(([id, n]) => [id, n.pool.getBoundingClientRect()]));

    this.topology = key;
    const { pos, roots, width, height } = layout(monitors);
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
      const sub = svg('text', { class: 'sub', x: TEXT_X, y: 42 });
      const pool = svg('rect', { class: 'pool', width: NODE_W, height: NODE_H, rx: 14 });
      const parentCount = (m.allParents ?? m.parents).length;
      const role = m.id === focus ? ' focused' : rel?.up.has(m.id) ? ' upstream' : rel?.down.has(m.id) ? ' downstream' : '';
      const expand = svg('g', {
        class: 'expand',
        transform: `translate(${NODE_W - 3},3)`,
        tabindex: 0,
        role: 'button',
        'aria-label': `Show details for ${m.name}`,
        onclick: (e) => {
          e.stopPropagation();
          this.onExpand(m.id);
        },
        onkeydown: (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          e.stopPropagation();
          this.onExpand(m.id);
        },
      },
      svg('title', {}, 'Show details'),
      svg('circle', { r: 11 }),
      svg('path', { d: 'M-1 -4.5H-4.5V-1M-4.5 -4.5L-1.3 -1.3M1 4.5H4.5V1M4.5 4.5L1.3 1.3' }));

      const inner = svg('g', { class: 'node-inner' },
        title,
        pool,
        svg('g', { class: `node-badge${m.icon ? ` kind-${m.icon.kind}` : ''}` },
          svg('circle', { class: 'ring-ripple', cx: BADGE.cx, cy: BADGE.cy, r: BADGE.r }),
          svg('circle', { class: 'ring', cx: BADGE.cx, cy: BADGE.cy, r: BADGE.r }),
          iconSvg(m.icon, BADGE.cx, BADGE.cy, 18) ?? svg('circle', { class: 'dot', cx: BADGE.cx, cy: BADGE.cy, r: 5 })),
        svg('text', { class: 'name', x: TEXT_X, y: 24 }, truncate(m.name, 17)),
        sub,
        parentCount > 1 ? svg('text', { class: 'multi', x: NODE_W - 12, y: 42, 'text-anchor': 'end' }, `⑂${parentCount}`) : null,
        expand);
      const g = svg('g', {
        class: 'node',
        transform: `translate(${x},${y})`,
        tabindex: 0,
        role: 'button',
        'aria-pressed': String(m.id === focus),
        'aria-label': m.id === focus ? `${m.name}, focused. Activate to show everything.` : `Focus on ${m.name}`,
        onclick: () => this.onSelect(m.id),
        onkeydown: (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          this.onSelect(m.id);
        },
      }, inner);
      nodes.append(g);
      this.nodeEls.set(m.id, { g, inner, pool, title, sub, role });
    }

    const source = svg('g', { class: 'source' },
      svg('circle', { cx: srcX, cy: srcY, r: 10, class: 'spring' }),
      svg('circle', { cx: srcX, cy: srcY, r: 10, class: 'spring-ring' }));

    const root = svg('svg', {
      class: `flow-svg${focus != null ? ' focusing' : ''}`,
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      role: 'group',
      'aria-label': 'Monitor hierarchy flow diagram',
      onclick: (e) => {
        if (!e.target.closest('.node')) this.onClear();
      },
    },
    svg('defs', {},
      // Streams need a user-space region: a bounding-box one is zero-wide on
      // a perfectly vertical stream and would clip it away entirely.
      glowFilter('glow', { filterUnits: 'userSpaceOnUse', x: 0, y: 0, width, height }),
      glowFilter('glow-box', { x: '-50%', y: '-50%', width: '200%', height: '200%' })),
    edges, nodes, source);
    fill(this.container, root);

    if (focus != null) {
      const p = pos.get(focus);
      this.container.scrollLeft = p.x + NODE_W / 2 - this.container.clientWidth / 2;
    }
    if (before.size && !reducedMotion()) this.#animate(before, edges);
  }

  // FLIP: start each surviving node where it was and let it glide into place;
  // new nodes and the streams fade in once things have settled.
  #animate(before, edges) {
    for (const [id, n] of this.nodeEls) {
      const was = before.get(id);
      if (!was) {
        n.inner.animate([{ opacity: 0, transform: 'translateY(-10px)' }, { opacity: 1, transform: 'none' }],
          { duration: 380, delay: 220, easing: 'ease-out', fill: 'backwards' });
        continue;
      }
      const now = n.pool.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (Math.abs(dx) + Math.abs(dy) < 1) continue;
      n.inner.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: 520, easing: 'cubic-bezier(.2,.75,.25,1)' });
    }
    edges.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, delay: 380, easing: 'ease-out', fill: 'backwards' });
  }

  // Update colours and text in place so the flow animation never restarts.
  #paint(monitors) {
    const byId = new Map(monitors.map((m) => [m.id, m]));
    for (const { parentId, childId, g } of this.edgeEls) {
      const state = parentId == null ? 'flow' : streamState(byId.get(parentId));
      const child = byId.get(childId);
      g.setAttribute('class', `stream ${state} to-${child?.status}`);
    }
    for (const [id, { g, title, sub, role }] of this.nodeEls) {
      const m = byId.get(id);
      if (!m) continue;
      g.setAttribute('class', `node ${m.status} type-${m.type}${role}`);
      sub.textContent = subline(m);
      title.textContent = `${m.name} — ${STATUS_LABEL[m.status]}${m.msg ? `\n${m.msg}` : ''}`;
    }
  }
}
