import { Graph } from './graph.js';
import { MONITOR_TYPES } from './checkers/index.js';
import { deliver, providerCatalog, providers } from './notifier.js';
import { config, isAddon } from './config.js';
import { validateIconSpec, decodeDataUrl } from './icons.js';
import fs from 'node:fs';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// A non-JSON response (icon images).
export class RawResponse {
  constructor(type, body, headers = {}) {
    this.type = type;
    this.body = body;
    this.headers = headers;
  }
}

const badRequest = (fn) => {
  try {
    return fn();
  } catch (err) {
    throw new HttpError(400, err.message);
  }
};

const int = (v, def, min, max) => {
  const n = v === undefined || v === null || v === '' ? def : Math.round(Number(v));
  if (!Number.isFinite(n)) throw new HttpError(400, `Expected a number, got "${v}"`);
  return Math.min(max, Math.max(min, n));
};

const idList = (v) => (Array.isArray(v) ? [...new Set(v.map(Number).filter(Number.isInteger))] : undefined);

function normalizeMonitor(body, existing) {
  const base = existing ?? {};
  const name = String(body.name ?? base.name ?? '').trim();
  if (!name) throw new HttpError(400, 'Name is required');
  const type = body.type ?? base.type;
  if (!MONITOR_TYPES.includes(type)) throw new HttpError(400, `Unknown monitor type "${type}"`);
  const interval = int(body.interval, base.interval ?? 60, 10, 86400);
  return {
    name,
    type,
    config: body.config && typeof body.config === 'object' ? body.config : base.config ?? {},
    interval,
    retries: int(body.retries, base.retries ?? 1, 0, 20),
    retryInterval: int(body.retryInterval, base.retryInterval ?? 20, 5, 86400),
    timeout: int(body.timeout, base.timeout ?? 10, 1, 300),
    resendInterval: int(body.resendInterval, base.resendInterval ?? 0, 0, 10000),
    parentMode: (body.parentMode ?? base.parentMode) === 'any' ? 'any' : 'all',
    active: body.active ?? base.active ?? true,
    description: String(body.description ?? base.description ?? ''),
    icon: body.icon === undefined ? base.icon ?? '' : badRequest(() => validateIconSpec(body.icon)),
  };
}

// Builds the router. `ctx` = { store, engine, icons }.
export function createApi({ store, engine, icons }) {
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, handler });
  };

  const monitorOr404 = (id) => {
    const m = store.getMonitor(Number(id));
    if (!m) throw new HttpError(404, 'Monitor not found');
    return m;
  };

  // Replace the edges touching `id` and refuse anything that makes a loop.
  const applyEdges = (id, parentIds, childIds) => {
    let edges = store.listEdges();
    if (parentIds) edges = edges.filter((e) => e.childId !== id).concat(parentIds.map((p) => ({ parentId: p, childId: id })));
    if (childIds) edges = edges.filter((e) => e.parentId !== id).concat(childIds.map((c) => ({ parentId: id, childId: c })));
    const ids = store.listMonitors().map((m) => m.id);
    for (const e of edges) {
      if (!ids.includes(e.parentId) || !ids.includes(e.childId)) throw new HttpError(400, 'Unknown monitor in hierarchy');
      if (e.parentId === e.childId) throw new HttpError(400, 'A monitor cannot be its own parent');
    }
    if (new Graph(ids, edges).hasCycle()) {
      throw new HttpError(400, 'That would create a loop: a monitor cannot be upstream of itself');
    }
    if (parentIds) store.setParents(id, parentIds);
    if (childIds) store.setChildren(id, childIds);
  };

  // An uploaded image arrives with the monitor as a data URL in `iconData`.
  const iconUpload = (body, data, id) => {
    if (data.icon !== 'upload') return null;
    if (body.iconData) return badRequest(() => decodeDataUrl(body.iconData));
    if (id == null || !icons.hasUpload(id)) throw new HttpError(400, 'Choose an image to upload for the icon');
    return null;
  };

  const iconsChanged = (id) => icons.sync(store.listMonitors(), id == null ? [] : [id]);

  const monitorDetail = (m) => ({
    ...m,
    parentIds: engine.graph.parentsOf(m.id),
    childIds: engine.graph.childrenOf(m.id),
    notificationIds: store.monitorNotificationIds(m.id),
  });

  route('GET', '/api/info', () => ({ version: VERSION, addon: isAddon, directAccess: config.allowDirectAccess }));

  route('GET', '/api/state', ({ query }) => {
    if (query.v && Number(query.v) === engine.version) return { version: engine.version, unchanged: true };
    const snap = engine.snapshot();
    for (const m of snap.monitors) m.icon = icons.describe(engine.monitors.get(m.id));
    return snap;
  });

  route('GET', '/api/events', () => store.recentEvents(50));

  // ---- monitors -----------------------------------------------------------

  route('GET', '/api/monitors/:id', ({ params }) => monitorDetail(monitorOr404(params.id)));

  route('POST', '/api/monitors', ({ body }) => {
    const data = normalizeMonitor(body);
    const upload = iconUpload(body, data, null);
    const parentIds = idList(body.parentIds) ?? [];
    const childIds = idList(body.childIds) ?? [];
    const id = store.tx(() => {
      const newId = store.createMonitor(data);
      applyEdges(newId, parentIds, childIds);
      const notif = idList(body.notificationIds) ?? store.listNotifications().filter((n) => n.isDefault).map((n) => n.id);
      store.setMonitorNotifications(newId, notif);
      return newId;
    });
    if (upload) icons.saveUpload(id, upload);
    engine.reload([id, ...childIds]);
    iconsChanged(id);
    return monitorDetail(store.getMonitor(id));
  });

  route('PUT', '/api/monitors/:id', ({ params, body }) => {
    const existing = monitorOr404(params.id);
    const data = normalizeMonitor(body, existing);
    const upload = iconUpload(body, data, existing.id);
    const parentIds = idList(body.parentIds);
    const childIds = idList(body.childIds);
    const oldChildren = engine.graph.childrenOf(existing.id);
    store.tx(() => {
      store.updateMonitor(existing.id, data);
      applyEdges(existing.id, parentIds, childIds);
      const notif = idList(body.notificationIds);
      if (notif) store.setMonitorNotifications(existing.id, notif);
    });
    if (upload) icons.saveUpload(existing.id, upload);
    engine.reload([existing.id, ...oldChildren, ...(childIds ?? [])]);
    iconsChanged(existing.id);
    return monitorDetail(store.getMonitor(existing.id));
  });

  route('DELETE', '/api/monitors/:id', ({ params }) => {
    const m = monitorOr404(params.id);
    const orphans = engine.graph.childrenOf(m.id);
    store.deleteMonitor(m.id);
    engine.reload(orphans);
    iconsChanged(null);
    return { ok: true };
  });

  route('POST', '/api/monitors/:id/pause', ({ params }) => {
    const m = monitorOr404(params.id);
    store.updateMonitor(m.id, { active: false });
    engine.reload([m.id]);
    return { ok: true };
  });

  route('POST', '/api/monitors/:id/resume', ({ params }) => {
    const m = monitorOr404(params.id);
    store.updateMonitor(m.id, { active: true });
    engine.reload([m.id]);
    return { ok: true };
  });

  route('POST', '/api/monitors/:id/check', async ({ params }) => {
    const m = monitorOr404(params.id);
    await engine.refresh(m.id);
    return { ok: true };
  });

  // Drag-and-drop in the tree: move a monitor from one parent to another
  // (fromParentId/toParentId null = top level), or with link=true add the
  // new parent while keeping the old one.
  route('POST', '/api/monitors/:id/move', ({ params, body }) => {
    const m = monitorOr404(params.id);
    const from = body.fromParentId == null ? null : Number(body.fromParentId);
    const to = body.toParentId == null ? null : Number(body.toParentId);
    let parents = engine.graph.parentsOf(m.id);
    if (from != null && !body.link) parents = parents.filter((p) => p !== from);
    if (to != null && !parents.includes(to)) parents.push(to);
    store.tx(() => applyEdges(m.id, parents, undefined));
    engine.reload([m.id]);
    return monitorDetail(store.getMonitor(m.id));
  });

  route('POST', '/api/edges/remove', ({ body }) => {
    store.removeEdge(Number(body.parentId), Number(body.childId));
    engine.reload([Number(body.childId)]);
    return { ok: true };
  });

  route('GET', '/api/monitors/:id/heartbeats', ({ params, query }) => {
    const m = monitorOr404(params.id);
    const hours = int(query.hours, 24, 1, 24 * 90);
    return store.heartbeatsSince(m.id, Date.now() - hours * 3600000);
  });

  // Images come from arbitrary sites, so make sure an SVG can never run
  // script in this origin, even if someone opens the URL directly.
  route('GET', '/api/monitors/:id/icon', ({ params }) => {
    const icon = store.getIcon(monitorOr404(params.id).id);
    if (!icon) throw new HttpError(404, 'No icon');
    return new RawResponse(icon.mime, icon.data, {
      'Cache-Control': 'private, max-age=604800',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    });
  });

  route('GET', '/api/monitors/:id/events', ({ params }) => store.importantHeartbeats(monitorOr404(params.id).id, 50));

  route('GET', '/api/monitors/:id/uptime', ({ params }) => {
    const m = monitorOr404(params.id);
    const now = Date.now();
    const pick = (since) => store.uptimeSince(since).get(m.id) ?? { uptime: null, avgPing: null };
    return { day: pick(now - 86400000), week: pick(now - 7 * 86400000), month: pick(now - 30 * 86400000) };
  });

  // ---- notifications ------------------------------------------------------

  const normalizeNotification = (body) => {
    const name = String(body.name ?? '').trim();
    if (!name) throw new HttpError(400, 'Name is required');
    if (!providers[body.type]) throw new HttpError(400, `Unknown notification type "${body.type}"`);
    return { name, type: body.type, config: body.config ?? {}, isDefault: Boolean(body.isDefault), active: body.active !== false };
  };

  route('GET', '/api/notification-types', () => providerCatalog());
  route('GET', '/api/notifications', () => store.listNotifications());

  route('POST', '/api/notifications', ({ body }) => {
    const n = normalizeNotification(body);
    const id = store.createNotification(n);
    if (body.applyToAll) {
      for (const m of store.listMonitors()) {
        store.setMonitorNotifications(m.id, [...store.monitorNotificationIds(m.id), id]);
      }
    }
    return store.getNotification(id);
  });

  route('PUT', '/api/notifications/:id', ({ params, body }) => {
    const id = Number(params.id);
    if (!store.getNotification(id)) throw new HttpError(404, 'Notification not found');
    store.updateNotification(id, normalizeNotification(body));
    return store.getNotification(id);
  });

  route('DELETE', '/api/notifications/:id', ({ params }) => {
    store.deleteNotification(Number(params.id));
    return { ok: true };
  });

  route('POST', '/api/notifications/test', async ({ body }) => {
    const n = normalizeNotification({ name: 'Test', ...body });
    const [res] = await deliver([{ id: 0, ...n }], {
      kind: 'test',
      title: 'Test: Waterfall Alert is flowing',
      message: [
        'This is a test notification from Waterfall Alert.',
        '',
        'A real alert looks like this:',
        'Alert: Host 2 is unreachable',
        '',
        'Other affected monitors (3):',
        '- Service 2.1',
        '-- Microservice 2.1.1',
        '- Service 2.2',
      ].join('\n'),
      time: Date.now(),
      monitor: null,
      affected: [],
    });
    if (!res.ok) throw new HttpError(502, res.error);
    return { ok: true };
  });

  // ---- alert log & settings -------------------------------------------------

  route('GET', '/api/alerts', ({ query }) => store.listAlerts(int(query.limit, 100, 1, 1000)));

  route('GET', '/api/settings', () => store.getSettings());
  route('PUT', '/api/settings', ({ body }) => {
    store.setSettings({ retentionDays: int(body.retentionDays, 90, 1, 3650) });
    return store.getSettings();
  });

  // ---- push monitors (external services call this) -------------------------

  const push = async ({ params, query }) => {
    const res = await engine.receivePush(params.token, { status: query.status, msg: query.msg, ping: query.ping });
    if (!res.found) throw new HttpError(404, 'Unknown push token');
    return res;
  };
  route('GET', '/api/push/:token', push);
  route('POST', '/api/push/:token', push);

  return async function handle(req, url, body) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = r.re.exec(url.pathname);
      if (!match) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
      return r.handler({ params, query: Object.fromEntries(url.searchParams), body: body ?? {} });
    }
    throw new HttpError(404, 'Not found');
  };
}
