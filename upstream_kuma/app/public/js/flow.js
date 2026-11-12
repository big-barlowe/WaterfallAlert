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
const MAP_H = { min: 200, max: 4000 }; // dragged heights
// Zoomed out below `details`, the small text, tags and sparkles are left out
// (names stay). With more than `animate` streams on screen the water stops
// moving: hundreds of animated streams cost more than they show.
const LOD = { details: 0.3, animate: 300 };
// Downstream of a traced monitor: each step away is this much smaller.
const SHRINK = { step: 0.9, min: 0.65 };
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

// The focus id for the source itself: tracing it keeps every monitor and
// sizes each one by how far it is from the source, like a traced monitor's
// downstream.
export const SOURCE = 'source';

// Each monitor's distance from the source (1 for the top level), along the
// shortest path.
function fromSource(monitors) {
  const byId = new Map(monitors.map((m) => [m.id, m]));
  const dist = new Map();
  let frontier = monitors.filter((m) => !m.parents.some((p) => byId.has(p))).map((m) => m.id);
  for (const id of frontier) dist.set(id, 1);
  for (let d = 2; frontier.length; d++) {
    const next = [];
    for (const x of frontier) {
      for (const c of byId.get(x).children ?? []) {
        if (!byId.has(c) || dist.has(c)) continue;
        dist.set(c, d);
        next.push(c);
      }
    }
    frontier = next;
  }
  return { up: new Map(), down: dist };
}

// What both layouts share: each node's level (one below its deepest
// parent), its "primary" parent (that deepest one, so the hierarchy reads as
// a tidy tree; extra parents get secondary streams), and its slot: leaves
// numbered left to right, a parent in the middle of its children, a little
// space between the trees under different roots.
function structure(monitors) {
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

  return { level, roots, kids, byName, slot, slots: Math.max(1, next) };
}

// Both layouts take `scaleOf(id)`, a monitor's size relative to a full card
// (smaller downstream of a traced monitor), and return each card's box
// `{x, y, w, h, s}`.

// The "waterfall": roots at the top, every child strictly below all of its
// parents, the source above the roots. A smaller card sits in the middle of
// its full-size cell.
function treeLayout(monitors, nodeH, scaleOf = () => 1) {
  const { level, roots, slot, slots } = structure(monitors);
  const pos = new Map();
  for (const m of monitors) {
    const s = scaleOf(m.id);
    const w = NODE_W * s;
    const h = nodeH * s;
    pos.set(m.id, { x: PAD + slot.get(m.id) * SLOT_W + (NODE_W - w) / 2, y: PAD + SOURCE_H + level.get(m.id) * LEVEL_H + (nodeH - h) / 2, w, h, s });
  }
  const maxLevel = Math.max(0, ...level.values());
  const xs = roots.map((r) => pos.get(r).x + pos.get(r).w / 2);
  const source = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: PAD + 14 };
  return {
    pos,
    source,
    width: PAD * 2 + slots * SLOT_W - (SLOT_W - NODE_W),
    height: PAD * 2 + SOURCE_H + maxLevel * LEVEL_H + nodeH,
    stream: (from, to) => (from
      ? curve(from.x + from.w / 2, from.y + from.h, to.x + to.w / 2, to.y)
      : curve(source.x, source.y + 10, to.x + to.w / 2, to.y)),
  };
}

// Rings: the first monitor that branches (the core switch, say) in the
// middle, with the chain above it (WAN, firewall, ...) as a trunk feeding in
// from the top, and everything else spread around it. Each subtree keeps its
// own wedge, in the tree's order. A monitor's devices with nothing below them
// are stacked a few rows deep instead of along one long arc. Distances are
// flexible: each monitor sits just beyond its parent, pushed out only as far
// as it takes to clear what is already placed, so the shape stays compact
// rather than perfectly round. A small diagram opens downward as a fan.
// Room the source takes up (the warbling hole, HOLE.scale × node.svg's rim).
const HOLE_BOX = { w: 80, h: 80 };
const RING = { gap: NODE_H + 36, margin: 10, perSlot: (40 * Math.PI) / 180, top: (44 * Math.PI) / 180 };

function ringLayout(monitors, nodeH, scaleOf = () => 1) {
  const { level, roots, kids, byName } = structure(monitors);

  // The trunk: from a lone root down to where it first branches.
  const trunk = [];
  let hub = null;
  if (roots.length === 1) {
    hub = roots[0];
    while (kids.get(hub).length === 1) {
      trunk.push(hub);
      hub = kids.get(hub)[0];
    }
  }

  // Slots (angles to be): leaves stacked in staggered rows, a parent in the
  // middle of its children, its stacked devices between its branches.
  const slot = new Map();
  const row = new Map();
  let next = 0;
  const place = (id) => {
    const k = kids.get(id);
    if (!k.length) {
      slot.set(id, next++);
      return;
    }
    const leaves = k.filter((c) => !kids.get(c).length);
    const branches = k.filter((c) => kids.get(c).length);
    const half = Math.ceil(branches.length / 2);
    branches.slice(0, half).forEach(place);
    if (leaves.length) {
      const rows = leaves.length < 4 ? 1 : Math.min(4, Math.ceil(Math.sqrt(leaves.length / 2)));
      const cols = Math.ceil(leaves.length / rows);
      const base = next;
      leaves.forEach((c, j) => {
        const r = Math.floor(j / cols);
        slot.set(c, base + (j % cols) + (r % 2 ? 0.5 : 0));
        row.set(c, r);
      });
      next += cols + (rows > 1 ? 0.5 : 0);
    }
    branches.slice(half).forEach(place);
    const ss = k.map((c) => slot.get(c));
    slot.set(id, (Math.min(...ss) + Math.max(...ss)) / 2);
  };
  const tops = hub != null ? kids.get(hub) : roots;
  tops.forEach((r, i) => {
    if (i && roots.length > 1) next += 0.25;
    place(r);
  });
  const slots = Math.max(1, next);
  // Something sits above the middle (the trunk, or the source): keep clear
  // of it at the top.
  const span = Math.min(2 * Math.PI - (hub != null ? RING.top : 0), slots * RING.perSlot);
  const angle = (id) => Math.PI / 2 + span * ((slot.get(id) + 0.5) / slots - 0.5);

  // Place: the middle and the trunk first, then outward level by level (and
  // stacked row by row), the middle of each level before its edges.
  const M = RING.margin * 2;
  const size = (id) => ({ w: NODE_W * scaleOf(id), h: nodeH * scaleOf(id) });
  const centre = new Map(); // centres and sizes
  const placed = [];
  const put = (id, c) => {
    centre.set(id, c);
    placed.push(c);
  };
  const STEP = nodeH + 42;
  if (hub != null) {
    put(hub, { x: 0, y: 0, ...size(hub) });
    trunk.forEach((id, i) => put(id, { x: 0, y: -(trunk.length - i) * STEP, ...size(id) }));
  } else {
    placed.push({ x: 0, y: 0, w: NODE_W, h: nodeH }); // the source
  }
  const src = hub != null ? { x: 0, y: -trunk.length * STEP - nodeH / 2 - 40 } : { x: 0, y: 0 };
  // The source above the hub (or its trunk) is in the way too: without this,
  // a hub that branches straight away (no trunk) gets a child drawn over it.
  if (hub != null) placed.push({ x: src.x, y: src.y, ...HOLE_BOX });
  const radius = new Map(hub != null ? [[hub, 0]] : []);
  const parentOf = new Map();
  for (const [id, k] of kids) for (const c of k) parentOf.set(c, id);
  const mid = (slots - 1) / 2;
  const order = monitors.map((m) => m.id).filter((id) => !centre.has(id))
    .sort((a, b) => level.get(a) + (row.get(a) ?? 0) - level.get(b) - (row.get(b) ?? 0) || Math.abs(slot.get(a) - mid) - Math.abs(slot.get(b) - mid) || byName(a, b));
  for (const id of order) {
    const u = { x: Math.cos(angle(id)), y: Math.sin(angle(id)) };
    const { w, h } = size(id);
    let r = (radius.get(parentOf.get(id)) ?? 0) + RING.gap * scaleOf(id);
    const DX = (q) => (w + q.w) / 2 + M;
    const DY = (q) => (h + q.h) / 2 + M;
    for (let guard = 0; guard < 200; guard++) {
      const p = { x: r * u.x, y: r * u.y };
      const hits = placed.filter((q) => Math.abs(p.x - q.x) < DX(q) && Math.abs(p.y - q.y) < DY(q));
      if (!hits.length) break;
      // jump straight to where the ray leaves the furthest of them
      r = Math.max(...hits.map((q) => {
        const out = [];
        if (Math.abs(u.x) > 1e-6) out.push((q.x + DX(q)) / u.x, (q.x - DX(q)) / u.x);
        if (Math.abs(u.y) > 1e-6) out.push((q.y + DY(q)) / u.y, (q.y - DY(q)) / u.y);
        return Math.min(...out.filter((t) => t > r));
      })) + 0.5;
    }
    radius.set(id, r);
    put(id, { x: r * u.x, y: r * u.y, w, h });
  }

  // Shifted so everything (and the source) sits inside the padding.
  const cs = [...centre.values()];
  const minX = Math.min(src.x - 12, ...cs.map((c) => c.x - c.w / 2));
  const minY = Math.min(src.y - 12, ...cs.map((c) => c.y - c.h / 2));
  const maxX = Math.max(src.x + 12, ...cs.map((c) => c.x + c.w / 2));
  const maxY = Math.max(src.y + 12, ...cs.map((c) => c.y + c.h / 2));
  const dx = PAD - minX;
  const dy = PAD - minY;
  const pos = new Map([...centre].map(([id, c]) => [id, { x: c.x - c.w / 2 + dx, y: c.y - c.h / 2 + dy, w: c.w, h: c.h, s: scaleOf(id) }]));
  const source = { x: src.x + dx, y: src.y + dy };
  const middle = { x: dx, y: dy };
  const box = (p) => p && { x: p.x, y: p.y, w: p.w, h: p.h };
  return {
    pos,
    source,
    centre: middle,
    width: maxX - minX + PAD * 2,
    height: maxY - minY + PAD * 2,
    stream: (from, to, seed) => river(middle, from ? { x: from.x + from.w / 2, y: from.y + from.h / 2 } : source, { x: to.x + to.w / 2, y: to.y + to.h / 2 }, box(from), box(to), seed),
  };
}

// A stream that winds outward around the middle (following the angle and
// the radius at the same time, so it bends with the rings) with a gentle
// meander, trimmed to start and end at the edges of the two cards.
function river(mid, a, b, fromBox, toBox, seed) {
  const pa = { r: Math.hypot(a.x - mid.x, a.y - mid.y), t: Math.atan2(a.y - mid.y, a.x - mid.x) };
  const pb = { r: Math.hypot(b.x - mid.x, b.y - mid.y), t: Math.atan2(b.y - mid.y, b.x - mid.x) };
  if (pa.r < 1) pa.t = pb.t;
  if (pb.r < 1) pb.t = pa.t;
  let dt = pb.t - pa.t;
  while (dt > Math.PI) dt -= 2 * Math.PI;
  while (dt < -Math.PI) dt += 2 * Math.PI;
  const along = (u) => {
    const r = pa.r + (pb.r - pa.r) * u;
    const t = pa.t + dt * u;
    return { x: mid.x + r * Math.cos(t), y: mid.y + r * Math.sin(t) };
  };
  // rough length, for the number of points and the size of the bends
  let len = 0;
  for (let i = 1, q = along(0); i <= 16; i++) {
    const p = along(i / 16);
    len += Math.hypot(p.x - q.x, p.y - q.y);
    q = p;
  }
  const n = Math.max(8, Math.ceil(len / 8));
  const amp = Math.min(16, len * 0.05) * (seed % 2 ? 1 : -1);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const p = along(u);
    const q = along(Math.min(1, u + 0.01));
    const o = along(Math.max(0, u - 0.01));
    const tx = q.x - o.x;
    const ty = q.y - o.y;
    const tl = Math.hypot(tx, ty) || 1;
    const off = amp * Math.sin(2 * Math.PI * u) * Math.sin(Math.PI * u);
    pts.push({ x: p.x - (ty / tl) * off, y: p.y + (tx / tl) * off });
  }
  const inside = (p, bx) => bx && p.x > bx.x - 1 && p.x < bx.x + bx.w + 1 && p.y > bx.y - 1 && p.y < bx.y + bx.h + 1;
  let i0 = 0;
  while (i0 < pts.length - 2 && inside(pts[i0 + 1], fromBox)) i0++;
  let i1 = pts.length - 1;
  while (i1 > i0 + 1 && inside(pts[i1 - 1], toBox)) i1--;
  const kept = pts.slice(i0, i1 + 1);
  if (inside(kept[0], fromBox)) kept[0] = edgePoint(kept[0], kept[1], fromBox);
  if (inside(kept[kept.length - 1], toBox)) kept[kept.length - 1] = edgePoint(kept[kept.length - 1], kept[kept.length - 2], toBox);
  return kept.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');
}

// Where the segment from `p` (inside the box) to `q` (outside) leaves it.
function edgePoint(p, q, b) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const m = (lo + hi) / 2;
    const x = p.x + (q.x - p.x) * m;
    const y = p.y + (q.y - p.y) * m;
    if (x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h) lo = m;
    else hi = m;
  }
  return { x: p.x + (q.x - p.x) * hi, y: p.y + (q.y - p.y) * hi };
}

export const LAYOUTS = {
  tree: { label: 'Tree', title: 'Tree: a waterfall, top to bottom' },
  rings: { label: 'Rings', title: 'Rings: levels in circles around the source, streams winding outward' },
};

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

// Toggle icons: a little tree, and a node with others around it on a ring.
function layoutIcon(mode) {
  const icon = (...kids) => svg('svg', { class: 'layout-icon', viewBox: '0 0 18 18', width: 16, height: 16, 'aria-hidden': 'true' }, ...kids);
  if (mode === 'tree') {
    return icon(
      svg('path', { class: 'li-line', d: 'M9 5V8.5M3.5 13V10.5Q3.5 8.5 5.5 8.5H12.5Q14.5 8.5 14.5 10.5V13M9 8.5V13' }),
      svg('circle', { class: 'li-dot', cx: 9, cy: 3.2, r: 2.2 }),
      ...[3.5, 9, 14.5].map((cx) => svg('circle', { class: 'li-dot', cx, cy: 14.8, r: 2.2 })));
  }
  return icon(
    svg('circle', { class: 'li-line', cx: 9, cy: 9, r: 6.2 }),
    svg('circle', { class: 'li-dot', cx: 9, cy: 9, r: 2.4 }),
    ...[-90, 30, 150].map((d) => svg('circle', { class: 'li-dot', cx: 9 + 6.2 * Math.cos((d * Math.PI) / 180), cy: 9 + 6.2 * Math.sin((d * Math.PI) / 180), r: 2 })));
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const iconKey = (i) => (i ? `${i.kind}:${i.src ?? i.name ?? i.value}` : '');

let measureCtx;
function textWidth(s, font = TAG_FONT) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = font;
  return measureCtx.measureText(s).width;
}

function fitText(s, width, font = TAG_FONT) {
  if (textWidth(s, font) <= width) return s;
  let n = s.length;
  while (n > 1 && textWidth(`${s.slice(0, n)}…`, font) > width) n--;
  return `${s.slice(0, n)}…`;
}

const SUB_FONT = '10.5px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

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
  // SNMP: the values picked for the card (the check's message)
  if (m.type === 'snmp' && m.msg && m.msg !== 'SNMP OK') return fitText(m.msg, NODE_W - TEXT_X - ((m.allParents ?? m.parents).length > 1 ? 34 : 12), SUB_FONT);
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
// monitors changes. `height` is a height the user dragged the map to (null =
// sized to the diagram).
// ---- the source: the hole everything flows from -------------------------

// docs/brand/node.svg: rim, water and core, centred on HOLE.c (in its own
// 205-unit box) and drawn HOLE.scale times that size.
const HOLE = {
  c: [104, 106],
  scale: 0.36,
  rim: 'M162.999 155.053C125.999 180.553 90.4989 172.285 70.9989 167.553C43.9989 161.002 3.49887 125.053 41.4988 72.0532C92.196 1.34393 144.999 49.9701 150.499 54.5532C156.499 59.5532 203.671 127.022 162.999 155.053Z',
  water: 'M149.482 143.61C120.774 163.466 93.2302 157.027 78.1003 153.343C57.1512 148.241 25.7277 120.249 55.2115 78.9797C94.5469 23.9202 135.516 61.7842 139.784 65.3529C144.439 69.2463 181.04 121.782 149.482 143.61Z',
  core: 'M128.847 128.367C112.684 139.398 97.1761 135.822 88.6576 133.775C76.8627 130.94 59.1705 115.389 75.7706 92.4617C97.9175 61.8731 120.984 82.9086 123.387 84.8912C126.008 87.0542 146.615 116.241 128.847 128.367Z',
};

// Frames of a path whose edge warbles: every point (control points too, so
// the curves stay smooth) is pushed in or out from the centre by two waves
// running around it. One full turn of the phase, so the last frame is the first.
function warbleFrames(d, { amp, lobes: [k1, k2], dir = 1, frames = 12 }) {
  const [cx, cy] = HOLE.c;
  const nums = d.match(/-?\d*\.?\d+(?:e-?\d+)?/g).map(Number);
  const cmds = d.match(/[MCZ]/g);
  const out = [];
  for (let f = 0; f <= frames; f++) {
    const phase = (dir * 2 * Math.PI * f) / frames;
    const moved = [];
    for (let i = 0; i < nums.length; i += 2) {
      const dx = nums[i] - cx;
      const dy = nums[i + 1] - cy;
      const t = Math.atan2(dy, dx);
      const k = 1 + amp * (0.65 * Math.sin(k1 * t + phase) + 0.35 * Math.sin(k2 * t - 2 * phase));
      moved.push((cx + dx * k).toFixed(2), (cy + dy * k).toFixed(2));
    }
    // M x y, then C with three points each, then Z
    let j = 0;
    out.push(cmds.map((c) => {
      if (c === 'Z') return 'Z';
      const n = c === 'M' ? 2 : 6;
      const part = moved.slice(j, j + n);
      j += n;
      return `${c}${part.join(' ')}`;
    }).join(''));
  }
  return out.join(';');
}

const STILL = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
let holeFrames = null;

function sourceHole(x, y, focused) {
  const [cx, cy] = HOLE.c;
  const s = HOLE.scale;
  holeFrames ??= {
    rim: warbleFrames(HOLE.rim, { amp: 0.07, lobes: [3, 5] }),
    water: warbleFrames(HOLE.water, { amp: 0.06, lobes: [2, 4], dir: -1 }),
  };
  // SMIL, since CSS can't animate a path's shape everywhere; it's one element
  const warble = (frames, dur) => (STILL ? null : svg('animate', { attributeName: 'd', values: frames, dur, repeatCount: 'indefinite' }));
  const at = { transform: `translate(${x - cx * s} ${y - cy * s}) scale(${s})` };
  // The rim goes under the streams and the water over them, so the streams
  // seem to come out of the water.
  return {
    under: svg('g', { class: `source source-rim${focused ? ' focused' : ''}`, ...at }, svg('path', { class: 'hole-rim', d: HOLE.rim }, warble(holeFrames.rim, '7s'))),
    over: svg('g', {
      class: `source${focused ? ' focused' : ''}`,
      ...at,
      tabindex: 0,
      role: 'button',
      'aria-pressed': String(Boolean(focused)),
      'aria-label': focused ? 'Upstream Kuma, traced. Activate to show everything.' : 'Trace everything from the source, smaller the further downstream',
    },
      svg('title', {}, focused ? 'Show everything' : 'Trace from the source'),
      svg('path', { class: 'hole-water', d: HOLE.water }, warble(holeFrames.water, '5s')),
      svg('path', { class: 'hole-core', d: HOLE.core })),
  };
}

export class FlowView {
  constructor(container, { onSelect, onExpand, onClear, onToggle, onMarquee, onLayout, view, height = null, layout = 'rings' }) {
    this.userH = height;
    this.mode = LAYOUTS[layout] ? layout : 'rings';
    this.onLayout = onLayout;
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
    this.layoutBtns = Object.entries(LAYOUTS).map(([mode, { title }]) => {
      const b = button(layoutIcon(mode), title, () => {
        this.setLayout(mode);
        this.onLayout?.(mode);
      }, ' map-layout');
      b.dataset.mode = mode;
      b.setAttribute('aria-pressed', String(mode === this.mode));
      return b;
    });
    this.controls = h('div', { class: 'map-controls' },
      h('span', { class: 'map-layouts', role: 'group', 'aria-label': 'Layout' }, this.layoutBtns),
      button('−', 'Zoom out', () => this.#zoomBy(1 / ZOOM.step)),
      this.zoomLabel,
      button('+', 'Zoom in', () => this.#zoomBy(ZOOM.step)),
      button(svg('svg', { class: 'map-fit', viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true' },
        svg('path', { d: 'M1.5 5.5v-4h4M10.5 1.5h4v4M14.5 10.5v4h-4M5.5 14.5h-4v-4' })), 'Fit to view', () => this.#fit(true)));
    this.hint = h('div', { class: 'map-hint', 'aria-hidden': 'true' },
      `Hold ${isMac ? '⌘' : 'Ctrl'} and scroll to zoom · drag to move around`);
    this.width = 0;
    this.height = 0;
    this.expanded = false;
    this.resizer = new ResizeObserver(() => {
      if (!container.isConnected) return this.resizer.disconnect();
      // Normally the map sets its own height; only popped out does it follow the box.
      const H = this.expanded ? container.clientHeight : 0;
      if (container.clientWidth === this.width && H === this.height) return;
      this.width = container.clientWidth;
      this.height = H;
      if (!this.svgEl) return;
      if (this.view.auto) return this.#fit(false);
      if (this.expanded) this.view.h = H;
      this.#apply(false);
    });
    this.resizer.observe(container);
  }

  // A height chosen by dragging (null: back to sizing itself to the diagram).
  // A fitted view re-fits to the new size; otherwise the middle stays put.
  setHeight(px) {
    const v = this.view;
    const h0 = v.h;
    this.userH = px == null ? null : Math.round(clamp(px, MAP_H.min, MAP_H.max));
    if (!this.svgEl || v.k == null || this.expanded) return this.userH;
    if (v.auto) this.#fit(false);
    else {
      v.h = this.#height(v.k);
      v.y += (v.h - h0) / 2;
      this.#apply(false);
    }
    return this.userH;
  }

  // Popped out, the map fills its box (sized by CSS) instead of sizing it.
  // The middle of what was on screen stays in the middle.
  setExpanded(on) {
    if (this.expanded === on) return;
    const v = this.view;
    const w0 = this.container.clientWidth;
    const h0 = v.h;
    this.expanded = on;
    this.container.style.height = '';
    if (!this.svgEl || v.k == null) return;
    if (v.auto) return this.#fit(false);
    const h = this.#height(v.k);
    Object.assign(v, { x: v.x + (this.container.clientWidth - w0) / 2, y: v.y + (h - h0) / 2, h });
    this.#apply(false);
  }

  // 'tree' or 'rings'. The nodes glide to their new places.
  setLayout(mode) {
    if (!LAYOUTS[mode] || mode === this.mode) return;
    this.mode = mode;
    for (const b of this.layoutBtns) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    if (this.last) this.render(...this.last);
  }

  // With `focusId`, only that monitor's upstream and downstream are drawn.
  // With SOURCE, everything is, smaller the further it is from the source.
  // Monitors may carry `tagList` ([{name, color}]) and `context` (shown only
  // because something below them matches the filter; drawn faded).
  render(monitors, focusId = null, { selected = new Set(), selectMode = false } = {}) {
    this.last = [monitors, focusId, { selected, selectMode }];
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
    const focus = focusId === SOURCE || monitors.some((m) => m.id === focusId) ? focusId : null;
    let shown = monitors;
    let rel = null;
    if (focus === SOURCE) rel = fromSource(monitors);
    else if (focus != null) {
      rel = lineage(monitors, focus);
      const keep = new Set([focus, ...rel.up.keys(), ...rel.down.keys()]);
      shown = monitors.filter((m) => keep.has(m.id)).map((m) => ({ ...m, parents: m.parents.filter((p) => keep.has(p)), allParents: m.parents }));
    }
    const key = JSON.stringify([this.mode, focus, shown.map((m) => [m.id, m.name, m.parents, iconKey(m.icon), m.tagList?.map((t) => t.name + t.color)])]);
    if (key !== this.topology) this.#build(shown, key, focus, rel);
    this.#paint(monitors);
  }

  #build(monitors, key, focus, rel) {
    // Where each node is on screen now, so moved nodes can glide over.
    const before = new Map([...this.nodeEls].map(([id, n]) => [id, n.pool.getBoundingClientRect()]));

    this.topology = key;
    const nodeH = monitors.some((m) => m.tagList?.length) ? TAGGED_H : NODE_H;
    // Tracing a monitor (or the source), everything downstream of it gets a
    // little smaller with each step away.
    const scaleOf = (id) => (rel?.down.has(id) ? Math.max(SHRINK.min, SHRINK.step ** rel.down.get(id)) : 1);
    const L = (this.mode === 'rings' ? ringLayout : treeLayout)(monitors, nodeH, scaleOf);
    const { pos, width, height } = L;
    const oldBoxes = this.boxes;
    this.boxes = new Map([...pos].map(([id, p]) => [id, { x: p.x, y: p.y, w: p.w, h: p.h }]));
    const { x: srcX, y: srcY } = L.source;

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

    for (const m of monitors) {
      const c = pos.get(m.id);
      if (!m.parents.length) addEdge(null, m.id, L.stream(null, c, m.id));
      for (const parentId of m.parents) {
        const p = pos.get(parentId);
        if (!p) continue;
        addEdge(parentId, m.id, L.stream(p, c, m.id + parentId));
      }
    }

    for (const m of monitors) {
      const { x, y, s: scale } = pos.get(m.id);
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
        transform: `translate(${x},${y})${scale !== 1 ? ` scale(${scale})` : ''}`,
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
      this.nodeEls.set(m.id, { g, inner, pool, title, sub, role, tags: m.tagList ?? [], s: scale });
    }

    const hole = sourceHole(srcX, srcY, focus === SOURCE);
    hole.over.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      this.onSelect(SOURCE);
    });

    this.viewEl = svg('g', { class: 'viewport' }, hole.under, edges, nodes, hole.over);
    const root = svg('svg', {
      class: `flow-svg layout-${this.mode}${focus != null ? ' focusing' : ''}`,
      role: 'group',
      'aria-label': 'Monitor hierarchy flow diagram. Drag to move around; hold Ctrl or ⌘ and scroll, or pinch, to zoom.',
      onclick: (e) => {
        if (this.#swallowClick()) return;
        if (e.target.closest('.source') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !this.selectMode) this.onSelect(SOURCE);
        else if (!e.target.closest('.node')) this.onClear();
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
      glowFilter('glow-box', { x: '-50%', y: '-50%', width: '200%', height: '200%' })),
    this.viewEl);
    root.addEventListener('wheel', (e) => this.#wheel(e), { passive: false });
    fill(this.container, root, this.controls, this.hint);
    // Each stream's extent, so the ones off screen can stop animating.
    for (const e of this.edgeEls) {
      const b = e.g.getBBox();
      e.box = { x: b.x, y: b.y, w: b.width, h: b.height };
      e.off = false;
    }
    this.svgEl = root;
    this.gesture = null;
    this.pointers.clear();

    const oldSource = this.sourceAt;
    this.sourceAt = { x: srcX, y: srcY };
    const anchor = focus === SOURCE ? this.sourceAt
      : focus != null ? { x: pos.get(focus).x + pos.get(focus).w / 2, y: pos.get(focus).y + pos.get(focus).h / 2 }
      : L.centre ?? null;
    this.content = { width, height, anchor };
    const fitKey = JSON.stringify([this.mode, focus, monitors.map((m) => m.id)]);
    const v = this.view;
    const keyChanged = v.key !== fitKey || v.k == null;
    // Leaving a trace: the monitor that was traced stays exactly where it is
    // on screen, at the same zoom, and the rest fills in around it.
    const was = keyChanged && focus == null ? (v.focus === SOURCE ? oldSource : oldBoxes?.get(v.focus)) : null;
    const now = was && (v.focus === SOURCE ? this.sourceAt : this.boxes.get(v.focus));
    v.key = fitKey;
    v.focus = focus;
    if (keyChanged) v.auto = true;
    this.width = this.container.clientWidth;
    if (now) {
      Object.assign(v, { x: v.x + (was.x - now.x) * v.k, y: v.y + (was.y - now.y) * v.k, h: this.#height(v.k), auto: false });
      this.#apply(false);
    } else if (v.auto) this.#fit(false);
    else this.#apply(false);
    if (before.size && !reducedMotion()) this.#animate(before, edges);
  }

  // ---- map navigation -------------------------------------------------------

  #maxHeight() {
    if (this.expanded) return this.container.clientHeight;
    if (this.userH) return this.userH;
    return Math.max(VIEW_MIN_H, Math.round(window.innerHeight * (this.container.clientWidth < 600 ? 0.6 : 0.72)));
  }

  // The map's height: the diagram at zoom `k`, within limits.
  #height(k) {
    if (this.expanded) return this.container.clientHeight;
    if (this.userH) return this.userH;
    return clamp(Math.ceil(this.content.height * k), VIEW_MIN_H, this.#maxHeight());
  }

  // Fit the whole diagram (or, when focused and too big, the part around the
  // focused monitor), never larger than actual size.
  #fit(animate) {
    const W = this.container.clientWidth;
    if (!W || !this.content) return;
    const { width: cw, height: ch, anchor } = this.content;
    const k = clamp(Math.min(1, W / cw, this.#maxHeight() / ch), FIT_MIN, 1);
    const H = this.#height(k);
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
    this.svgEl.classList.toggle('lod-far', v.k < LOD.details);
    this.#scheduleCull();
    if (!this.expanded) this.container.style.height = `${v.h}px`;
    const glide = animate && !reducedMotion();
    this.viewEl.classList.toggle('glide', glide);
    clearTimeout(this.glideTimer);
    if (glide) this.glideTimer = setTimeout(() => this.viewEl?.classList.remove('glide'), 320);
    this.viewEl.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
    this.zoomLabel.textContent = `${Math.round(v.k * 100)}%`;
  }

  // Only what is on screen (plus a margin) animates; checked a few times a
  // second while the view moves.
  #scheduleCull() {
    if (this.cullTimer) return;
    this.cullTimer = setTimeout(() => {
      this.cullTimer = null;
      this.#cull();
    }, 120);
  }

  #cull() {
    const v = this.view;
    if (!this.svgEl?.isConnected || !this.edgeEls) return;
    const m = 80 / v.k;
    const x0 = -v.x / v.k - m;
    const y0 = -v.y / v.k - m;
    const x1 = x0 + this.container.clientWidth / v.k + 2 * m;
    const y1 = y0 + v.h / v.k + 2 * m;
    const out = (b) => b.x > x1 || b.y > y1 || b.x + b.w < x0 || b.y + b.h < y0;
    let shown = 0;
    for (const e of this.edgeEls) {
      const off = !e.box || out(e.box);
      if (!off) shown++;
      if (off !== e.off) e.g.classList.toggle('offscreen', (e.off = off));
    }
    this.svgEl.classList.toggle('calm', shown > LOD.animate);
    for (const [id, n] of this.nodeEls) {
      const off = out(this.boxes.get(id));
      if (off !== n.off) n.g.classList.toggle('offscreen', (n.off = off));
    }
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
      // in the node's own units, which its scale shrinks too
      const now = n.pool.getBoundingClientRect();
      const dx = (was.left - now.left) / (k * n.s);
      const dy = (was.top - now.top) / (k * n.s);
      const r = was.width / now.width;
      if (Math.abs(dx) + Math.abs(dy) < 1 && Math.abs(r - 1) < 0.01) continue;
      n.inner.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${r})` }, { transform: 'none' }],
        { duration: 520, easing: 'cubic-bezier(.2,.75,.25,1)' });
    }
    edges.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, delay: 380, easing: 'ease-out', fill: 'backwards' });
  }

  // Update colours and text in place so the flow animation never restarts.
  #paint(monitors) {
    const byId = new Map(monitors.map((m) => [m.id, m]));
    for (const { parentId, childId, g, off } of this.edgeEls) {
      const state = parentId == null ? 'flow' : streamState(byId.get(parentId));
      const child = byId.get(childId);
      g.setAttribute('class', `stream ${state} to-${child?.status}${off ? ' offscreen' : ''}`);
    }
    this.svgEl?.classList.toggle('selecting', this.selectMode);
    for (const [id, { g, title, sub, role, tags, off }] of this.nodeEls) {
      const m = byId.get(id);
      if (!m) continue;
      const sel = this.selected.has(id) ? ' selected' : '';
      const sev = m.sev && m.sev !== 'info' ? ` sev-${m.sev}` : '';
      g.setAttribute('class', `node ${m.status} type-${m.type}${role}${sel}${sev}${m.context ? ' context' : ''}${off ? ' offscreen' : ''}`);
      sub.textContent = subline(m);
      const issues = (m.issues ?? []).map((i) => `\n⚠ ${i.name}${i.value ? `: ${i.value}` : ''}`).join('');
      title.textContent = `${m.name} — ${STATUS_LABEL[m.status]}${m.msg ? `\n${m.msg}` : ''}${issues}${tags.length ? `\nTags: ${tags.map((t) => t.name).join(', ')}` : ''}`;
    }
  }
}
