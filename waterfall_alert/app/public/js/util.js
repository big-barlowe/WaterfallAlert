// All URLs are relative so the app works under Home Assistant ingress,
// which serves it from /api/hassio_ingress/<token>/.
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`api/${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Tiny hyperscript: h('div', { class: 'x', onclick }, child, [children], 'text')
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [p, val] of Object.entries(v)) {
        if (p.startsWith('--')) el.style.setProperty(p, val);
        else el.style[p] = val;
      }
    }
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

// replaceChildren that accepts nested arrays and skips null/false.
export function fill(el, ...children) {
  if (!el) return;
  el.replaceChildren();
  append(el, children);
}

export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

export const STATUS_LABEL = {
  up: 'Up',
  down: 'Down',
  pending: 'Pending',
  blocked: 'Blocked upstream',
  paused: 'Paused',
};
export const BEAT_STATUS = { 0: 'down', 1: 'up', 2: 'pending', 4: 'blocked' };

export const TYPE_LABEL = {
  group: 'Group',
  http: 'HTTP(S)',
  tcp: 'TCP port',
  ping: 'Ping',
  dns: 'DNS',
  ha_entity: 'HA entity',
  minecraft: 'Minecraft',
  snmp: 'SNMP',
  push: 'Push',
};

export function fmtTime(t) {
  return t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

export function fmtAgo(t) {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function fmtPct(v) {
  if (v == null) return '—';
  const p = v * 100;
  return `${p >= 99.995 ? '100' : p.toFixed(2)}%`;
}

export function fmtMs(v) {
  return v == null ? '—' : `${Math.round(v)} ms`;
}

let toastHost;
export function toast(message, kind = 'info') {
  toastHost ||= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }));
  const el = h('div', { class: `toast ${kind}` }, message);
  toastHost.append(el);
  setTimeout(() => el.classList.add('leaving'), 3500);
  setTimeout(() => el.remove(), 4000);
}

// In-page modal (the HA frontend and some browsers block window.confirm).
export function modal(title, body, actions) {
  const close = () => back.remove();
  const back = h('div', { class: 'modal-back', onclick: (e) => e.target === back && close() },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h3', null, title),
      h('div', { class: 'modal-body' }, body),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn ghost', onclick: close }, 'Cancel'),
        actions.map((a) => h('button', {
          class: `btn ${a.kind || 'primary'}`,
          onclick: async () => {
            if ((await a.onClick()) !== false) close();
          },
        }, a.label)))));
  document.body.append(back);
  back.querySelector('input,select,button.primary,button.danger')?.focus();
  return close;
}

export function confirmDialog(title, text, label, onConfirm) {
  modal(title, h('p', null, text), [{ label, kind: 'danger', onClick: onConfirm }]);
}

export function storage(key, fallback) {
  try {
    const v = localStorage.getItem(`waterfall:${key}`);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function store(key, value) {
  try {
    localStorage.setItem(`waterfall:${key}`, JSON.stringify(value));
  } catch {
    // private mode / blocked storage: just don't persist
  }
}
