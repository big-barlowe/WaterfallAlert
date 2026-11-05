import { request as httpRequest } from './checkers/http.js';
import { minecraftStatus as defaultMinecraftStatus } from './checkers/minecraft.js';
import { log } from './config.js';

export const MAX_ICON_BYTES = 256 * 1024;
const REFRESH_MS = 7 * 86400000; // re-fetch favicons and image URLs weekly
const RETRY_MS = 6 * 3600000;    // after a failed fetch
const TIMEOUT_MS = 8000;
const MAX_PAGE_BYTES = 512 * 1024;

// The icon spec stored on a monitor:
//   ''               automatic: the site's favicon for HTTP monitors, the server
//                    icon for Minecraft, a folder for groups
//   'none'           no icon
//   'builtin:<name>' one of the UI's built-in glyphs (public/js/icons.js)
//   'emoji:<text>'   an emoji
//   'url:<url>'      an image the server fetches and caches
//   'upload'         an image uploaded through the UI
export function parseIconSpec(spec) {
  const s = String(spec ?? '');
  if (s === 'none' || s === 'upload') return { kind: s };
  const i = s.indexOf(':');
  const kind = s.slice(0, i);
  const value = s.slice(i + 1);
  if (i > 0 && value && ['builtin', 'emoji', 'url'].includes(kind)) return { kind, value };
  return { kind: 'auto' };
}

// Normalizes a spec from the API, throwing on anything malformed.
export function validateIconSpec(spec) {
  const s = String(spec ?? '').trim();
  if (!s || s === 'none' || s === 'upload') return s;
  const { kind, value } = parseIconSpec(s);
  if (kind === 'builtin' && /^[a-z0-9-]{1,32}$/.test(value)) return s;
  if (kind === 'emoji' && value.trim() && value.length <= 16) return `emoji:${value.trim()}`;
  if (kind === 'url') {
    let u;
    try {
      u = new URL(value);
    } catch {
      throw new Error('Icon URL is not a valid URL');
    }
    if (!/^https?:$/.test(u.protocol) || value.length > 2000) throw new Error('Icon URL must be an http(s) URL');
    return `url:${u}`;
  }
  throw new Error('Unknown icon setting');
}

// Identify an image by its first bytes rather than trusting Content-Type.
export function sniffImage(buf) {
  if (!buf || buf.length < 4) return null;
  const b = (i) => buf[i];
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'image/png';
  if (b(0) === 0 && b(1) === 0 && (b(2) === 1 || b(2) === 2) && b(3) === 0) return 'image/x-icon';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  const head = Buffer.from(buf.subarray(0, 2048)).toString('latin1');
  if (head.startsWith('GIF8')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  if (/^(\xEF\xBB\xBF)?\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

export function decodeDataUrl(str) {
  const m = /^data:[^,;]*(;[^,;=]+=[^,;]*)*(;base64)?,/i.exec(String(str));
  if (!m) throw new Error('Expected an image data URL');
  const payload = String(str).slice(m[0].length);
  const data = m[2] ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
  if (data.length > MAX_ICON_BYTES) throw new Error('Icon images must be 256 KB or smaller');
  const mime = sniffImage(data);
  if (!mime) throw new Error('That is not a supported image (PNG, JPEG, GIF, WebP, ICO or SVG)');
  return { mime, data };
}

const decodeEntities = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");

// <link rel="icon" …> candidates in a page, best first. We display icons at
// ~20-28px, so prefer scalable or mid-sized ones over 16px and huge ones.
export function findIconLinks(html, base) {
  const out = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attrs = {};
    for (const [, k, v1, v2, v3] of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[k.toLowerCase()] = v1 ?? v2 ?? v3;
    }
    const rel = String(attrs.rel ?? '').toLowerCase().split(/\s+/);
    const touch = rel.some((r) => r.startsWith('apple-touch-icon'));
    if (!attrs.href || !(rel.includes('icon') || touch)) continue;
    let url;
    try {
      url = new URL(decodeEntities(attrs.href.trim()), base).toString();
    } catch {
      continue;
    }
    if (!/^(https?|data):/i.test(url)) continue;
    const sizes = String(attrs.sizes ?? '').toLowerCase();
    const size = Math.max(0, ...sizes.split(/\s+/).map((s) => parseInt(s, 10)).filter(Number.isFinite));
    let score;
    if (attrs.type === 'image/svg+xml' || /\.svg(\?|#|$)/i.test(url) || sizes === 'any') score = 90;
    else if (touch) score = 75;
    else if (size >= 32 && size <= 192) score = 100 - Math.abs(size - 64) / 10;
    else if (size > 192) score = 70;
    else if (size) score = 50;
    else score = 60;
    out.push({ url, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

// Keeps cached icon images in step with the monitors' settings. Fetches run
// in the background, one at a time; `onChange` fires when an image appears,
// changes or goes away, so the UI can pick it up.
export class IconCache {
  constructor({ store, onChange = () => {}, request = httpRequest, minecraftStatus = defaultMinecraftStatus, now = Date.now }) {
    this.store = store;
    this.onChange = onChange;
    this.request = request;
    this.minecraftStatus = minecraftStatus;
    this.now = now;
    this.meta = new Map(store.listIconMeta().map((r) => [r.monitorId, r]));
    this.monitors = new Map();
    this.queue = new Set();
    this.running = null;
  }

  // What the cache should hold for a monitor: a source key, or null.
  wanted(m) {
    const spec = parseIconSpec(m.icon);
    if (spec.kind === 'auto') {
      if (m.type === 'http' && m.config?.url) return `favicon:${m.config.url}`;
      if (m.type === 'minecraft' && m.config?.host) return `minecraft:${m.config.host}:${m.config.port ?? ''}`;
      return null;
    }
    if (spec.kind === 'url') return `url:${spec.value}`;
    if (spec.kind === 'upload') return 'upload';
    return null;
  }

  hasUpload(id) {
    const meta = this.meta.get(id);
    return meta?.source === 'upload' && meta.hasData;
  }

  // Drop images nothing uses any more and queue fetches for missing, stale or
  // `force`d ones.
  sync(monitors, force = []) {
    this.monitors = new Map(monitors.map((m) => [m.id, m]));
    let changed = false;
    for (const id of this.meta.keys()) if (!this.monitors.has(id)) this.meta.delete(id); // ON DELETE CASCADE
    for (const m of monitors) {
      const want = this.wanted(m);
      let meta = this.meta.get(m.id);
      if (meta && meta.source !== want) {
        this.store.deleteIcon(m.id);
        this.meta.delete(m.id);
        changed ||= meta.hasData;
        meta = null;
      }
      if (!want || want === 'upload') continue;
      const age = this.now() - (meta?.checkedAt ?? 0);
      if (!meta || force.includes(m.id) || age > (meta.hasData ? REFRESH_MS : RETRY_MS)) this.queue.add(m.id);
    }
    if (changed) this.onChange();
    this.#drain();
  }

  // Resolves once queued fetches are done. Used by tests.
  idle() {
    return this.running ?? Promise.resolve();
  }

  saveUpload(id, { mime, data }) {
    this.#save(id, { source: 'upload', mime, data });
    this.onChange();
  }

  // What the UI renders, or null for no icon.
  describe(m) {
    const spec = parseIconSpec(m.icon);
    if (spec.kind === 'none') return null;
    if (spec.kind === 'builtin') return { kind: 'builtin', name: spec.value };
    if (spec.kind === 'emoji') return { kind: 'emoji', value: spec.value };
    const meta = this.meta.get(m.id);
    if (meta?.hasData && meta.source === this.wanted(m)) {
      return { kind: 'image', src: `api/monitors/${m.id}/icon?v=${meta.updatedAt}` };
    }
    if (spec.kind === 'auto' && m.type === 'group') return { kind: 'builtin', name: 'folder' };
    if (spec.kind === 'auto' && m.type === 'minecraft') return { kind: 'builtin', name: 'gamepad' };
    return null;
  }

  #save(id, { source, mime = null, data = null, error = '' }) {
    const now = this.now();
    this.store.setIcon(id, { source, mime, data, error, updatedAt: now, checkedAt: now });
    this.meta.set(id, { monitorId: id, source, hasData: Boolean(data), updatedAt: now, checkedAt: now });
  }

  #drain() {
    if (this.running || !this.queue.size) return;
    this.running = (async () => {
      while (this.queue.size) {
        const [id] = this.queue;
        this.queue.delete(id);
        await this.#refresh(id).catch((err) => log.warn(`Icon for monitor ${id}:`, err.message));
      }
    })().finally(() => {
      this.running = null;
    });
  }

  async #refresh(id) {
    const m = this.monitors.get(id);
    const want = m && this.wanted(m);
    if (!want || want === 'upload') return;
    let img = null;
    let error = '';
    try {
      if (want.startsWith('favicon:')) img = await this.#favicon(m.config.url, Boolean(m.config.ignoreTls));
      else if (want.startsWith('minecraft:')) img = await this.#serverIcon(m);
      else img = await this.#image(want.slice('url:'.length), false);
    } catch (err) {
      error = err.message;
    }
    // The monitor may have been edited or deleted while we were fetching.
    const now = this.monitors.get(id);
    if (!now || this.wanted(now) !== want) return;
    const prev = this.meta.get(id);
    if (img) {
      this.#save(id, { source: want, ...img });
      this.onChange();
    } else if (prev?.source === want && prev.hasData) {
      // Keep showing the old image; try again later.
      const at = this.now() - REFRESH_MS + RETRY_MS;
      this.store.markIconChecked(id, at, error);
      prev.checkedAt = at;
    } else {
      this.#save(id, { source: want, error });
      log.debug(`No icon for ${m.name}: ${error}`);
    }
  }

  async #image(url, ignoreTls) {
    if (url.startsWith('data:')) return decodeDataUrl(url);
    const res = await this.request(url, {
      method: 'GET',
      headers: { Accept: 'image/*,*/*;q=0.8' },
      ignoreTls,
      timeoutMs: TIMEOUT_MS,
      maxBody: MAX_ICON_BYTES,
    });
    if (res.code !== 200) throw new Error(`HTTP ${res.code} from ${url}`);
    if (res.size > MAX_ICON_BYTES) throw new Error(`${url} is larger than 256 KB`);
    const mime = sniffImage(res.body);
    if (!mime) throw new Error(`${url} is not an image`);
    return { mime, data: res.body };
  }

  // Minecraft servers send their 64px icon as a data URL in the status reply.
  async #serverIcon(m) {
    const { status } = await this.minecraftStatus(m.config, TIMEOUT_MS);
    if (typeof status.favicon !== 'string') throw new Error('The server has no icon');
    return decodeDataUrl(status.favicon);
  }

  async #links(url, ignoreTls) {
    try {
      const res = await this.request(url, {
        method: 'GET',
        headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
        ignoreTls,
        timeoutMs: TIMEOUT_MS,
        maxBody: MAX_PAGE_BYTES,
      });
      const html = res.body.toString('utf8');
      return { base: res.url, links: /<link\b/i.test(html) ? findIconLinks(html, res.url) : [] };
    } catch {
      return { base: url, links: [] };
    }
  }

  // The monitored URL is often an API endpoint, so fall back to the site's
  // home page and finally /favicon.ico.
  async #favicon(pageUrl, ignoreTls) {
    let { base, links } = await this.#links(pageUrl, ignoreTls);
    const home = new URL('/', base).toString();
    if (!links.length && home !== base) links = (await this.#links(home, ignoreTls)).links;
    const candidates = [...links.slice(0, 4).map((l) => l.url), new URL('/favicon.ico', base).toString(), new URL('/favicon.ico', pageUrl).toString()];
    let lastError = 'no icon found';
    for (const url of new Set(candidates)) {
      try {
        return await this.#image(url, ignoreTls);
      } catch (err) {
        lastError = err.message;
      }
    }
    throw new Error(`No favicon for ${pageUrl} (${lastError})`);
  }
}
