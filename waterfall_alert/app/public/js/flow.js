import { h, svg, STATUS_LABEL, TYPE_LABEL, fmtMs, fill } from './util.js';
import { iconSvg } from './icons.js';

const NODE_W = 184;
const NODE_H = 56;
const TAGGED_H = 70; // every node gets a tag row once any shown node has tags
const SLOT_W = 204;
const LEVEL_H = 112;
const PAD = 28;
const SOURCE_H = 70;
const BADGE = { cx: 26, cy: 28, r: 15 };
const TEXT_X = 50;
const TAG = { x: 12, y: 52, h: 13, pad: 5, gap: 4 };
const TAG_FONT = '600 9px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

const ZOOM = { min: 0.2, max: 2.5, step: 1.25 };
const FIT_MIN = 0.6; // fitting never shrinks below this; zoom out for the overview
const VIEW_MIN_H = 320;
const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

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
function layout(monitors, nodeH) {
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
    height: PAD * 2 + SOURCE_H + maxLevel * LEVEL_H + nodeH,
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

let measureCtx;
function textWidth(s) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = TAG_FONT;
  return measureCtx.measureText(s).width;
}

function fitText(s, width) {
  if (textWidth(s) <= width) return s;
  let n = s.length;
  while (n > 1 && textWidth(`${s.slice(0, n)}…`) > width) n--;
  return `${s.slice(0, n)}…`;
}

// A row of tag pills along the bottom of a node; whatever doesn't fit
// becomes "+N" (the node's tooltip lists every tag).
function tagRow(tags) {
  const g = svg('g', { class: 'node-tags' });
  const right = NODE_W - TAG.x;
  const pill = (x, label, color) => {
    const w = textWidth(label) + TAG.pad * 2;
    g.append(svg('g', { class: `tag${color ? '' : ' more'}`, style: color ? `--tag:${color}` : null },
      svg('rect', { x, y: TAG.y, width: w, height: TAG.h, rx: TAG.h / 2 }),
      svg('text', { x: x + w / 2, y: TAG.y + TAG.h / 2 + 0.5, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, label)));
    return x + w + TAG.gap;
  };
  let x = TAG.x;
  for (let i = 0; i < tags.length; i++) {
    const left = tags.length - i - 1;
    const reserve = left ? textWidth(`+${left}`) + TAG.pad * 2 + TAG.gap : 0;
    const room = right - x - reserve - TAG.pad * 2;
    if (textWidth(tags[i].name) <= room) {
      x = pill(x, tags[i].name, tags[i].color);
    } else if (i === 0 || room > 36) {
      x = pill(x, fitText(tags[i].name, room), tags[i].color);
    } else {
      pill(x, `+${left + 1}`, null);
      break;
    }
  }
  return g;
}

function subline(m) {
  if (m.type === 'group') return `Group · ${m.children.length} inside`;
  if (m.status === 'blocked') return 'Blocked upstream';
  if (m.status === 'down') return truncate(m.msg || 'Down', 22);
  if (m.status === 'paused') return 'Paused';
  if (m.type === 'minecraft' && /players/.test(m.msg)) return `${m.msg.split(' · ')[0]} · ${fmtMs(m.ping)}`;
  return `${TYPE_LABEL[m.type]} · ${fmtMs(m.ping)}`;
}

// Callbacks: onSelect(id) when a node is clicked, onExpand(id) for its
// expand button, onClear() for a click on empty water, onToggle(id) for a
// shift/ctrl/⌘-click (or any click in select mode) and onMarquee(ids) with
// the new selection after shift-dragging a box.
//
// The diagram is a map: drag to pan, ctrl/⌘ + scroll or pinch to zoom.
// `view` ({k, x, y, h, key, auto}) holds the zoom and position; pass the
// same object to a new FlowView to keep them. While `auto`, the view fits
// the diagram, and it fits again whenever the focus or the set of shown
// monitors changes.
export class FlowView {
  constructor(container, { onSelect, onExpand, onClear, onToggle, onMarquee, view }) {
    this.container = container;
    this.onSelect = onSelect;
    this.onExpand = onExpand;
    this.onClear = onClear;
    this.onToggle = onToggle;
    this.onMarquee = onMarquee;
    this.view = view ?? {};
    this.topology = null;
    this.nodeEls = new Map();
    this.selected = new Set();
    this.selectMode = false;
    this.pointers = new Map();
    this.gesture = null;

    const button = (label, title, onclick, cls = '') => h('button', { type: 'button', class: `map-btn${cls}`, title, 'aria-label': title, onclick }, label);
    this.zoomLabel = button('100%', 'Actual size', () => this.#zoomBy(1 / this.view.k), ' map-zoom');
    this.controls = h('div', { class: 'map-controls' },
      button('−', 'Zoom out', () => this.#zoomBy(1 / ZOOM.step)),
      this.zoomLabel,
      button('+', 'Zoom in', () => this.#zoomBy(ZOOM.step)),
      button(svg('svg', { class: 'map-fit', viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true' },
        svg('path', { d: 'M1.5 5.5v-4h4M10.5 1.5h4v4M14.5 10.5v4h-4M5.5 14.5h-4v-4' })), 'Fit to view', () => this.#fit(true)));
    this.hint = h('div', { class: 'map-hint', 'aria-hidden': 'true' },
      `Hold ${isMac ? '⌘' : 'Ctrl'} and scroll to zoom · drag to move around`);
    this.width = 0;
    this.resizer = new ResizeObserver(() => {
      if (!container.isConnected) return this.resizer.disconnect();
      if (container.clientWidth === this.width) return;
      this.width = container.clientWidth;
      if (this.svgEl) this.view.auto ? this.#fit(false) : this.#apply(false);
    });
    this.resizer.observe(container);
  }

  // With `focusId`, only that monitor's upstream and downstream are drawn.
  // Monitors may carry `tagList` ([{name, color}]) and `context` (shown only
  // because something below them matches the filter; drawn faded).
  render(monitors, focusId = null, { selected = new Set(), selectMode = false } = {}) {
    this.selected = selected;
    this.selectMode = selectMode;
    if (!monitors.length) {
      fill(this.container);
      this.container.style.height = '';
      this.topology = null;
      this.svgEl = null;
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
    const key = JSON.stringify([focus, shown.map((m) => [m.id, m.name, m.parents, iconKey(m.icon), m.tagList?.map((t) => t.name + t.color)])]);
    if (key !== this.topology) this.#build(shown, key, focus, rel);
    this.#paint(monitors);
  }

  #build(monitors, key, focus, rel) {
    // Where each node is on screen now, so moved nodes can glide over.
    const before = new Map([...this.nodeEls].map(([id, n]) => [id, n.pool.getBoundingClientRect()]));

    this.topology = key;
    const nodeH = monitors.some((m) => m.tagList?.length) ? TAGGED_H : NODE_H;
    const { pos, roots, width, height } = layout(monitors, nodeH);
    this.boxes = new Map([...pos].map(([id, p]) => [id, { ...p, w: NODE_W, h: nodeH }]));
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
        addEdge(parentId, m.id, curve(p.x + NODE_W / 2, p.y + nodeH, c.x + NODE_W / 2, c.y));
      }
    }

    for (const m of monitors) {
      const { x, y } = pos.get(m.id);
      const title = svg('title');
      const sub = svg('text', { class: 'sub', x: TEXT_X, y: 42 });
      const pool = svg('rect', { class: 'pool', width: NODE_W, height: nodeH, rx: 14 });
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
          if (!this.#swallowClick()) this.onExpand(m.id);
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
        svg('rect', { class: 'sel-ring', x: -4, y: -4, width: NODE_W + 8, height: nodeH + 8, rx: 18 }),
        pool,
        svg('g', { class: `node-badge${m.icon ? ` kind-${m.icon.kind}` : ''}` },
          svg('circle', { class: 'ring-ripple', cx: BADGE.cx, cy: BADGE.cy, r: BADGE.r }),
          svg('circle', { class: 'ring', cx: BADGE.cx, cy: BADGE.cy, r: BADGE.r }),
          iconSvg(m.icon, BADGE.cx, BADGE.cy, 18) ?? svg('circle', { class: 'dot', cx: BADGE.cx, cy: BADGE.cy, r: 5 })),
        svg('text', { class: 'name', x: TEXT_X, y: 24 }, truncate(m.name, 17)),
        sub,
        parentCount > 1 ? svg('text', { class: 'multi', x: NODE_W - 12, y: 42, 'text-anchor': 'end' }, `⑂${parentCount}`) : null,
        m.tagList?.length ? tagRow(m.tagList) : null,
        svg('g', { class: 'sel-mark', transform: 'translate(2,2)', 'aria-hidden': 'true' },
          svg('circle', { r: 8 }),
          svg('path', { d: 'M-3.5 0.2L-1 2.7L3.6 -2.2' })),
        expand);
      const toggle = (e) => e.shiftKey || e.metaKey || e.ctrlKey || this.selectMode;
      const g = svg('g', {
        class: 'node',
        transform: `translate(${x},${y})`,
        tabindex: 0,
        role: 'button',
        'aria-pressed': String(m.id === focus),
        'aria-label': m.id === focus ? `${m.name}, focused. Activate to show everything.` : `Focus on ${m.name}`,
        onclick: (e) => {
          if (this.#swallowClick()) return;
          if (toggle(e)) this.onToggle(m.id);
          else this.onSelect(m.id);
        },
        onkeydown: (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          if (toggle(e)) this.onToggle(m.id);
          else this.onSelect(m.id);
        },
      }, inner);
      nodes.append(g);
      this.nodeEls.set(m.id, { g, inner, pool, title, sub, role, tags: m.tagList ?? [] });
    }

    const source = svg('g', { class: 'source' },
      svg('circle', { cx: srcX, cy: srcY, r: 10, class: 'spring' }),
      svg('circle', { cx: srcX, cy: srcY, r: 10, class: 'spring-ring' }));

    this.viewEl = svg('g', { class: 'viewport' }, edges, nodes, source);
    const root = svg('svg', {
      class: `flow-svg${focus != null ? ' focusing' : ''}`,
      role: 'group',
      'aria-label': 'Monitor hierarchy flow diagram. Drag to move around; hold Ctrl or ⌘ and scroll, or pinch, to zoom.',
      onclick: (e) => {
        if (this.#swallowClick()) return;
        if (!e.target.closest('.node')) this.onClear();
      },
      onpointerdown: (e) => this.#down(e),
      onpointermove: (e) => this.#move(e),
      onpointerup: (e) => this.#up(e),
      onpointercancel: (e) => this.#up(e),
      // Tabbing to a node that is off screen brings it into view.
      onfocusin: (e) => {
        const node = e.target.closest('.node');
        if (node?.matches(':focus-visible')) this.#reveal([...this.nodeEls].find(([, n]) => n.g === node)?.[0]);
      },
    },
    svg('defs', {},
      // Streams need a user-space region: a bounding-box one is zero-wide on
      // a perfectly vertical stream and would clip it away entirely.
      glowFilter('glow', { filterUnits: 'userSpaceOnUse', x: 0, y: 0, width, height }),
      glowFilter('glow-box', { x: '-50%', y: '-50%', width: '200%', height: '200%' })),
    this.viewEl);
    root.addEventListener('wheel', (e) => this.#wheel(e), { passive: false });
    fill(this.container, root, this.controls, this.hint);
    this.svgEl = root;
    this.gesture = null;
    this.pointers.clear();

    this.content = { width, height, anchor: focus != null ? { x: pos.get(focus).x + NODE_W / 2, y: pos.get(focus).y + nodeH / 2 } : null };
    const fitKey = JSON.stringify([focus, monitors.map((m) => m.id)]);
    if (this.view.key !== fitKey || this.view.k == null) {
      this.view.key = fitKey;
      this.view.auto = true;
    }
    this.width = this.container.clientWidth;
    if (this.view.auto) this.#fit(false);
    else this.#apply(false);
    if (before.size && !reducedMotion()) this.#animate(before, edges);
  }

  // ---- map navigation -------------------------------------------------------

  // Fit the whole diagram (or, when focused and too big, the part around the
  // focused monitor), never larger than actual size.
  #fit(animate) {
    const W = this.container.clientWidth;
    if (!W || !this.content) return;
    const { width: cw, height: ch, anchor } = this.content;
    const maxH = Math.max(VIEW_MIN_H, Math.round(window.innerHeight * (W < 600 ? 0.6 : 0.72)));
    const k = clamp(Math.min(1, W / cw, maxH / ch), FIT_MIN, 1);
    const H = clamp(Math.ceil(ch * k), VIEW_MIN_H, maxH);
    const place = (size, total, at) => (total * k <= size ? (size - total * k) / 2 : at == null ? 0 : clamp(size / 2 - at * k, size - total * k, 0));
    Object.assign(this.view, {
      k,
      x: cw * k <= W ? (W - cw * k) / 2 : place(W, cw, anchor?.x ?? cw / 2),
      y: place(H, ch, anchor?.y),
      h: H,
      auto: true,
    });
    this.#apply(animate);
  }

  #apply(animate) {
    const v = this.view;
    if (!this.viewEl) return;
    this.container.style.height = `${v.h}px`;
    const glide = animate && !reducedMotion();
    this.viewEl.classList.toggle('glide', glide);
    clearTimeout(this.glideTimer);
    if (glide) this.glideTimer = setTimeout(() => this.viewEl?.classList.remove('glide'), 320);
    this.viewEl.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
    this.zoomLabel.textContent = `${Math.round(v.k * 100)}%`;
  }

  // Zoom by `factor` keeping the point (sx, sy) of the diagram where it is.
  #zoomAt(factor, sx, sy, animate) {
    const v = this.view;
    const k = clamp(v.k * factor, ZOOM.min, ZOOM.max);
    if (Math.abs(k - v.k) < 1e-4) return;
    v.x = sx - (sx - v.x) * (k / v.k);
    v.y = sy - (sy - v.y) * (k / v.k);
    v.k = k;
    v.auto = false;
    this.#apply(animate);
  }

  #zoomBy(factor) {
    this.#zoomAt(factor, this.container.clientWidth / 2, this.view.h / 2, true);
  }

  #panTo(x, y, animate) {
    Object.assign(this.view, { x, y, auto: false });
    this.#apply(animate);
  }

  #reveal(id) {
    const b = this.boxes.get(id);
    if (!b) return;
    const v = this.view;
    const W = this.container.clientWidth;
    const left = v.x + b.x * v.k;
    const top = v.y + b.y * v.k;
    if (left >= 0 && top >= 0 && left + b.w * v.k <= W && top + b.h * v.k <= v.h) return;
    this.#panTo(W / 2 - (b.x + b.w / 2) * v.k, v.h / 2 - (b.y + b.h / 2) * v.k, true);
  }

  // Pinch-zoom on a trackpad arrives as a wheel event with ctrlKey set.
  // A plain wheel scrolls the page as usual, with a hint.
  #wheel(e) {
    if (!(e.ctrlKey || e.metaKey)) {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) this.#showHint();
      return;
    }
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const r = this.svgEl.getBoundingClientRect();
    this.#zoomAt(Math.exp(-dy * (Math.abs(dy) < 40 ? 0.012 : 0.002)), e.clientX - r.left, e.clientY - r.top, false);
  }

  #showHint() {
    this.hint.classList.add('show');
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => this.hint.classList.remove('show'), 1400);
  }

  // A click that ends a drag or a pinch is not a click.
  #swallowClick() {
    const s = this.suppressClick;
    this.suppressClick = false;
    return s;
  }

  // Diagram coordinates of a pointer.
  #point(e) {
    const r = this.svgEl.getBoundingClientRect();
    const v = this.view;
    return { x: (e.clientX - r.left - v.x) / v.k, y: (e.clientY - r.top - v.y) / v.k };
  }

  // One pointer: drag pans, and with shift/ctrl/⌘ (or in select mode) draws
  // a selection box instead; Alt/⌥ makes the box take away from the
  // selection. Two pointers: pinch to zoom and pan.
  #down(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      this.#endMarquee();
      this.svgEl.classList.remove('panning');
      const [a, b] = [...this.pointers.values()];
      const r = this.svgEl.getBoundingClientRect();
      this.gesture = {
        type: 'pinch',
        d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mx: (a.x + b.x) / 2 - r.left,
        my: (a.y + b.y) / 2 - r.top,
        view: { ...this.view },
      };
      for (const id of this.pointers.keys()) this.#capture(id);
      return;
    }
    if (this.pointers.size > 2) return;
    this.suppressClick = false;
    const select = e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || this.selectMode;
    this.gesture = {
      type: select ? 'marquee' : 'pan',
      id: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      threshold: e.pointerType === 'touch' ? 8 : 4,
      active: false,
      view: { x: this.view.x, y: this.view.y },
      mode: e.altKey ? 'remove' : 'add',
      start: this.#point(e),
      base: new Set(this.selected),
      result: null,
      rect: null,
    };
    if (!e.target.closest('.node')) e.preventDefault(); // no text selection while dragging
  }

  #move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    const g = this.gesture;
    if (!g) return;
    if (g.type === 'pinch') {
      const [a, b] = [...this.pointers.values()];
      const r = this.svgEl.getBoundingClientRect();
      const mx = (a.x + b.x) / 2 - r.left;
      const my = (a.y + b.y) / 2 - r.top;
      const k = clamp(g.view.k * Math.hypot(a.x - b.x, a.y - b.y) / g.d, ZOOM.min, ZOOM.max);
      // the diagram point that was under the fingers stays under them
      this.view.k = k;
      this.#panTo(mx - (g.mx - g.view.x) * (k / g.view.k), my - (g.my - g.view.y) * (k / g.view.k), false);
      return;
    }
    if (e.pointerId !== g.id) return;
    if (!g.active) {
      if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < g.threshold) return;
      g.active = true;
      this.#capture(e.pointerId); // keep the drag going outside the diagram
      if (g.type === 'pan') this.svgEl.classList.add('panning');
      else {
        g.rect = svg('rect', { class: 'marquee', rx: 4 });
        this.viewEl.append(g.rect);
      }
    }
    if (g.type === 'pan') {
      this.#panTo(g.view.x + e.clientX - g.sx, g.view.y + e.clientY - g.sy, false);
      return;
    }
    const q = this.#point(e);
    const box = { x: Math.min(q.x, g.start.x), y: Math.min(q.y, g.start.y), w: Math.abs(q.x - g.start.x), h: Math.abs(q.y - g.start.y) };
    g.rect.setAttribute('x', box.x);
    g.rect.setAttribute('y', box.y);
    g.rect.setAttribute('width', box.w);
    g.rect.setAttribute('height', box.h);
    const hits = [...this.boxes].filter(([, b]) => b.x < box.x + box.w && b.x + b.w > box.x && b.y < box.y + box.h && b.y + b.h > box.y).map(([id]) => id);
    g.result = new Set(g.base);
    for (const id of hits) {
      if (g.mode === 'remove') g.result.delete(id);
      else g.result.add(id);
    }
    for (const [id, n] of this.nodeEls) n.g.classList.toggle('selected', g.result.has(id));
  }

  #up(e) {
    if (!this.pointers.delete(e.pointerId)) return;
    const g = this.gesture;
    if (!g) return;
    if (g.type === 'pinch') {
      // the finger left behind doesn't start a pan
      this.gesture = null;
      this.suppressClick = true;
      return;
    }
    if (e.pointerId !== g.id) return;
    this.gesture = null;
    this.svgEl.classList.remove('panning');
    if (!g.active) return;
    this.suppressClick = e.type === 'pointerup';
    if (g.type === 'marquee') {
      g.rect.remove();
      this.onMarquee([...g.result]);
    }
  }

  #endMarquee() {
    const g = this.gesture;
    if (g?.type !== 'marquee' || !g.active) return;
    g.rect.remove();
    for (const [id, n] of this.nodeEls) n.g.classList.toggle('selected', this.selected.has(id));
  }

  #capture(pointerId) {
    try {
      this.svgEl.setPointerCapture(pointerId);
    } catch {
      // pointer already gone
    }
  }

  // FLIP: start each surviving node where it was and let it glide into place;
  // new nodes and the streams fade in once things have settled.
  #animate(before, edges) {
    const k = this.view.k; // the nodes' own coordinates are scaled by the zoom
    for (const [id, n] of this.nodeEls) {
      const was = before.get(id);
      if (!was) {
        n.inner.animate([{ opacity: 0, transform: 'translateY(-10px)' }, { opacity: 1, transform: 'none' }],
          { duration: 380, delay: 220, easing: 'ease-out', fill: 'backwards' });
        continue;
      }
      const now = n.pool.getBoundingClientRect();
      const dx = (was.left - now.left) / k;
      const dy = (was.top - now.top) / k;
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
    this.svgEl?.classList.toggle('selecting', this.selectMode);
    for (const [id, { g, title, sub, role, tags }] of this.nodeEls) {
      const m = byId.get(id);
      if (!m) continue;
      const sel = this.selected.has(id) ? ' selected' : '';
      g.setAttribute('class', `node ${m.status} type-${m.type}${role}${sel}${m.context ? ' context' : ''}`);
      sub.textContent = subline(m);
      title.textContent = `${m.name} — ${STATUS_LABEL[m.status]}${m.msg ? `\n${m.msg}` : ''}${tags.length ? `\nTags: ${tags.map((t) => t.name).join(', ')}` : ''}`;
    }
  }
}
