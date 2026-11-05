import { h, svg } from './util.js';

// Built-in glyphs: 24x24, stroked with currentColor. Keys are stored on the
// monitor as `builtin:<key>`, so never rename one.
export const GLYPHS = {
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.4 2.6 3.6 5.6 3.6 9s-1.2 6.4-3.6 9c-2.4-2.6-3.6-5.6-3.6-9S9.6 5.6 12 3z"/>',
  cloud: '<path d="M7 18.5h10.5a4 4 0 0 0 .5-8 6 6 0 0 0-11.6-1.4A4.6 4.6 0 0 0 7 18.5z"/>',
  router: '<rect x="3" y="12.5" width="18" height="7.5" rx="2"/><path d="M7 16.25h.01M10.5 16.25h.01M17 12.5V6.5M14.5 5a3.6 3.6 0 0 1 5 0"/>',
  switch: '<rect x="2.5" y="7.5" width="19" height="9" rx="2"/><path d="M6 12h.01M9 12h.01M12 12h.01M15 12h.01M18 12h.01"/>',
  wifi: '<path d="M2.5 9a14 14 0 0 1 19 0M5.6 12.4a9.5 9.5 0 0 1 12.8 0M8.7 15.8a5 5 0 0 1 6.6 0M12 19.5h.01"/>',
  server: '<rect x="4" y="3.5" width="16" height="7" rx="1.8"/><rect x="4" y="13.5" width="16" height="7" rx="1.8"/><path d="M8 7h.01M8 17h.01M12 7h4.5M12 17h4.5"/>',
  nas: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8.5 7h7M8.5 10.5h7"/><circle cx="12" cy="16" r="1.8"/>',
  database: '<ellipse cx="12" cy="6" rx="7" ry="2.8"/><path d="M5 6v12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8"/>',
  container: '<path d="M12 2.8l8 4.6v9.2l-8 4.6-8-4.6V7.4z"/><path d="M4 7.4l8 4.6 8-4.6M12 12v9.2"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="1.5"/><rect x="9.5" y="9.5" width="5" height="5" rx=".6"/><path d="M9.5 2.5V6M14.5 2.5V6M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.5-3.2 8.2-7.5 9.5-4.3-1.3-7.5-5-7.5-9.5V6z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  home: '<path d="M3.5 11L12 4l8.5 7M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>',
  bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>',
  camera: '<rect x="3" y="7" width="18" height="13" rx="2"/><circle cx="12" cy="13.5" r="3.5"/><path d="M8.5 7l1.5-2.5h4L15.5 7"/>',
  sensor: '<path d="M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0z"/><path d="M12 17.5h.01"/>',
  bolt: '<path d="M13 2.5L5 13.5h6l-1 8 8-11h-6z"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>',
  tv: '<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M8.5 20.5h7M12 16.5v4"/>',
  speaker: '<rect x="5" y="2.5" width="14" height="19" rx="2"/><circle cx="12" cy="14.5" r="3.5"/><path d="M12 6.5h.01"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  printer: '<path d="M7 9V3.5h10V9"/><rect x="3.5" y="9" width="17" height="8" rx="2"/><path d="M7 14h10v6.5H7z"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3.5 7l8.5 6 8.5-6"/>',
  drop: '<path d="M12 3.5c3.5 4.3 6 7.6 6 10.8a6 6 0 0 1-12 0c0-3.2 2.5-6.5 6-10.8z"/>',
  folder: '<path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
};

function glyph(name, attrs) {
  const el = svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', ...attrs });
  el.innerHTML = GLYPHS[name]; // our own constant markup
  return el;
}

// HTML icon for lists and headings. `icon` is the descriptor from the state
// snapshot ({ kind: 'image' | 'builtin' | 'emoji', … }) or null.
export function iconEl(icon, size = 18) {
  if (!icon) return null;
  const style = { width: `${size}px`, height: `${size}px` };
  if (icon.kind === 'image') {
    return h('span', { class: 'mon-icon img', style, 'aria-hidden': 'true' },
      h('img', { src: icon.src, alt: '', loading: 'lazy', onerror: (e) => e.target.parentNode.classList.add('broken') }));
  }
  if (icon.kind === 'emoji') {
    return h('span', { class: 'mon-icon emoji', style: { ...style, fontSize: `${Math.round(size * 0.85)}px` }, 'aria-hidden': 'true' }, icon.value);
  }
  if (icon.kind === 'builtin' && GLYPHS[icon.name]) {
    return h('span', { class: 'mon-icon glyph', style }, glyph(icon.name, { width: size, height: size }));
  }
  return null;
}

// The same, as SVG content centred on (cx, cy) for the falls diagram.
export function iconSvg(icon, cx, cy, size) {
  if (!icon) return null;
  const x = cx - size / 2;
  const y = cy - size / 2;
  if (icon.kind === 'image') {
    return svg('image', { class: 'icon-img', href: icon.src, x, y, width: size, height: size, preserveAspectRatio: 'xMidYMid meet' });
  }
  if (icon.kind === 'emoji') {
    return svg('text', { class: 'icon-emoji', x: cx, y: cy, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': size * 0.85 }, icon.value);
  }
  if (icon.kind === 'builtin' && GLYPHS[icon.name]) {
    return glyph(icon.name, { class: 'icon-glyph', x, y, width: size, height: size });
  }
  return null;
}

export const glyphPreview = (name, size) => glyph(name, { width: size, height: size });
