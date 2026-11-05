import { h, svg, BEAT_STATUS, STATUS_LABEL, fmtTime, fmtMs, fill } from './util.js';

// Row of heartbeat pills, newest on the right (like Uptime Kuma).
export function heartbeatBar(beats, slots = 40, { compact = false } = {}) {
  const list = beats.slice(-slots);
  const pad = Math.max(0, slots - list.length);
  return h('div', { class: `beats${compact ? ' compact' : ''}`, role: 'img', 'aria-label': `Last ${list.length} heartbeats` },
    Array.from({ length: pad }, () => h('span', { class: 'beat none' })),
    list.map(([time, status, ping]) => {
      const name = BEAT_STATUS[status];
      return h('span', { class: `beat ${name}`, title: `${fmtTime(time)} · ${STATUS_LABEL[name]}${ping != null ? ` · ${fmtMs(ping)}` : ''}` });
    }));
}

function niceStep(max, ticks = 4) {
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) || mag * 10;
}

// Bucket raw beats so we draw at most ~one point per 2px.
function bucket(beats, start, end, buckets) {
  const size = (end - start) / buckets;
  const out = [];
  for (const b of beats) {
    const i = Math.min(buckets - 1, Math.floor((b.time - start) / size));
    const cur = (out[i] ||= { time: start + (i + 0.5) * size, sum: 0, n: 0, down: 0, blocked: 0, beats: 0, msg: '' });
    cur.beats++;
    if (b.status === 1 && b.ping != null) {
      cur.sum += b.ping;
      cur.n++;
    } else if (b.status === 0) {
      cur.down++;
      cur.msg = b.msg;
    } else if (b.status === 4) cur.blocked++;
  }
  return out.filter(Boolean).map((c) => ({
    time: c.time,
    ping: c.n ? c.sum / c.n : null,
    status: c.down ? 'down' : c.blocked && !c.n ? 'blocked' : c.n ? 'up' : 'pending',
    msg: c.msg,
    beats: c.beats,
  }));
}

/**
 * Response time over a window. One series, so no legend: the card title
 * names it. Down/blocked periods are shaded behind the line, and a
 * crosshair + tooltip follows the pointer.
 */
export function responseChart(container, beats, { hours }) {
  const W = Math.max(280, container.clientWidth || 600);
  const H = 200;
  const M = { t: 12, r: 12, b: 26, l: 48 };
  const end = Date.now();
  const start = end - hours * 3600000;
  const nBuckets = Math.max(20, Math.floor((W - M.l - M.r) / 3));
  const pts = bucket(beats, start, end, nBuckets);
  const pings = pts.map((p) => p.ping).filter((v) => v != null);

  if (!pts.length) {
    fill(container, h('div', { class: 'chart-empty' }, 'No heartbeats in this window yet.'));
    return;
  }

  const step = niceStep(Math.max(10, ...pings) * 1.1);
  const yMax = Math.ceil((Math.max(10, ...pings) * 1.1) / step) * step;
  const x = (t) => M.l + ((t - start) / (end - start)) * (W - M.l - M.r);
  const y = (v) => M.t + (1 - v / yMax) * (H - M.t - M.b);
  const bw = Math.max(2, (W - M.l - M.r) / nBuckets);

  const grid = svg('g', { class: 'grid' });
  for (let v = 0; v <= yMax; v += step) {
    grid.append(
      svg('line', { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v) }),
      svg('text', { x: M.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, `${v}`));
  }
  grid.append(svg('text', { x: 4, y: M.t + 4, class: 'unit' }, 'ms'));
  const xTicks = W < 520 ? 3 : 5;
  for (let i = 0; i <= xTicks; i++) {
    const t = start + ((end - start) * i) / xTicks;
    const label = hours <= 24
      ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
    grid.append(svg('text', { x: x(t), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === xTicks ? 'end' : 'middle' }, label));
  }

  const bands = svg('g', { class: 'bands' });
  for (const p of pts) {
    if (p.status === 'down' || p.status === 'blocked') {
      bands.append(svg('rect', { class: p.status, x: x(p.time) - bw / 2, y: M.t, width: bw, height: H - M.t - M.b }));
    }
  }

  // Break the line wherever there is no successful ping.
  let line = '';
  let area = '';
  let seg = [];
  const flush = () => {
    if (!seg.length) return;
    line += 'M' + seg.map((p) => `${x(p.time).toFixed(1)},${y(p.ping).toFixed(1)}`).join('L');
    area += `M${x(seg[0].time).toFixed(1)},${y(0)}` + seg.map((p) => `L${x(p.time).toFixed(1)},${y(p.ping).toFixed(1)}`).join('') + `L${x(seg[seg.length - 1].time).toFixed(1)},${y(0)}Z`;
    seg = [];
  };
  for (const p of pts) {
    if (p.ping == null) flush();
    else seg.push(p);
  }
  flush();

  const cross = svg('line', { class: 'crosshair', y1: M.t, y2: H - M.b, visibility: 'hidden' });
  const marker = svg('circle', { class: 'marker', r: 4.5, visibility: 'hidden' });
  const tip = h('div', { class: 'chart-tip', hidden: true });

  const chart = svg('svg', { class: 'response-chart', width: W, height: H, viewBox: `0 0 ${W} ${H}` },
    svg('defs', {},
      svg('linearGradient', { id: 'rt-fill', x1: 0, y1: 0, x2: 0, y2: 1 },
        svg('stop', { offset: '0%', 'stop-color': 'var(--water)', 'stop-opacity': 0.35 }),
        svg('stop', { offset: '100%', 'stop-color': 'var(--water)', 'stop-opacity': 0 }))),
    grid, bands,
    svg('path', { class: 'area', d: area }),
    svg('path', { class: 'line', d: line }),
    cross, marker,
    svg('rect', { class: 'hit', x: M.l, y: 0, width: W - M.l - M.r, height: H }));

  const hit = chart.lastChild;
  const hide = () => {
    cross.setAttribute('visibility', 'hidden');
    marker.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('pointermove', (e) => {
    const rect = chart.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const t = start + ((px - M.l) / (W - M.l - M.r)) * (end - start);
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.time - t) < Math.abs(best.time - t)) best = p;
    const bx = x(best.time);
    cross.setAttribute('x1', bx);
    cross.setAttribute('x2', bx);
    cross.setAttribute('visibility', 'visible');
    if (best.ping != null) {
      marker.setAttribute('cx', bx);
      marker.setAttribute('cy', y(best.ping));
      marker.setAttribute('visibility', 'visible');
    } else marker.setAttribute('visibility', 'hidden');
    fill(tip, 
      h('div', { class: 'tip-time' }, fmtTime(best.time)),
      h('div', { class: 'tip-row' }, h('span', { class: `dot ${best.status}` }), STATUS_LABEL[best.status]),
      best.ping != null ? h('div', { class: 'tip-val' }, fmtMs(best.ping)) : null,
      best.msg ? h('div', { class: 'tip-msg' }, best.msg) : null);
    tip.hidden = false;
    const left = (bx / W) * rect.width;
    tip.style.left = `${Math.min(rect.width - 170, Math.max(0, left + 12))}px`;
  });

  fill(container, h('div', { class: 'chart-wrap' }, chart, tip));
}
