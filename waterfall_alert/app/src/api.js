import { Graph } from './graph.js';
import { deliver, providerCatalog, providers } from './notifier.js';
import { config, isAddon } from './config.js';
import { decodeDataUrl } from './icons.js';
import { HttpError, badRequest, int, idList, normalizeMonitor, normalizeTag } from './validate.js';
import { exportCsv, importCsv, CSV_COLUMNS, CSV_EXAMPLE, csvTemplate } from './transfer.js';
import { DISPLAY_KEYS, snmpBrowse } from './checkers/snmp.js';
import { isOid } from './snmp.js';
import { buildLibrary, mibLibrary, parseMib, setMibLibrary, splitModules } from './mib.js';

// A monitor's config without the keys that only change how its data is
// shown, to tell whether what it checks has changed.
const checkedConfig = (config) => JSON.stringify(Object.fromEntries(Object.entries(config ?? {}).filter(([k]) => !DISPLAY_KEYS.includes(k))));
const displayOf = (m) => ({ oids: m.config?.oids ?? '', hide: m.config?.hide ?? [], card: m.config?.card ?? [] });
import fs from 'node:fs';

export { HttpError };

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// A non-JSON response (icon images).
// Icons may be SVGs from anywhere, and the add-on shares Home Assistant's
// origin, so they are served sandboxed.
const ICON_HEADERS = {
  'Cache-Control': 'private, max-age=604800',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'X-Content-Type-Options': 'nosniff',
};

export class RawResponse {
  constructor(type, body, headers = {}) {
    this.type = type;
    this.body = body;
    this.headers = headers;
  }
}

// Builds the router. `ctx` = { store, engine, icons }.
export function createApi({ store, engine, icons }) {
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, handler });
  };

  // The MIB library: the bundled modules plus the uploaded ones. SNMP
  // monitors are checked again after a change, so card values pick up new
  // names and units.
  setMibLibrary(buildLibrary(store.listMibs()));
  const mibsChanged = () => {
    setMibLibrary(buildLibrary(store.listMibs()));
    engine.reload(store.listMonitors().filter((m) => m.type === 'snmp').map((m) => m.id));
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

  const tagIdsFrom = (v) => {
    const ids = idList(v);
    if (!ids) return undefined;
    const known = new Set(store.listTags().map((t) => t.id));
    if (ids.some((t) => !known.has(t))) throw new HttpError(400, 'Unknown tag');
    return ids;
  };

  // Set a monitor's tags; with `downstream`, tags it didn't have before are
  // also added to everything below it.
  const applyMonitorTags = (id, tagIds, downstream) => {
    if (!tagIds) return;
    const before = new Set(store.monitorTagIds(id));
    store.setMonitorTags(id, tagIds);
    const added = tagIds.filter((t) => !before.has(t));
    if (!downstream || !added.length) return;
    const graph = new Graph(store.listMonitors().map((m) => m.id), store.listEdges());
    for (const d of graph.descendants(id)) for (const t of added) store.tagMonitor(d, t);
  };

  const iconsChanged = (id) => icons.sync(store.listMonitors(), id == null ? [] : [id]);

  const monitorDetail = (m) => ({
    ...m,
    parentIds: engine.graph.parentsOf(m.id),
    childIds: engine.graph.childrenOf(m.id),
    notificationIds: store.monitorNotificationIds(m.id),
    tagIds: store.monitorTagIds(m.id),
  });

  route('GET', '/api/info', () => ({ version: VERSION, addon: isAddon, directAccess: config.allowDirectAccess }));

  route('GET', '/api/state', ({ query }) => {
    if (query.v && Number(query.v) === engine.version) return { version: engine.version, unchanged: true };
    const snap = engine.snapshot();
    const tagMap = store.monitorTagMap();
    for (const m of snap.monitors) {
      m.icon = icons.describe(engine.monitors.get(m.id));
      m.tags = tagMap.get(m.id) ?? [];
    }
    snap.tags = store.listTags();
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
    const tagIds = tagIdsFrom(body.tagIds);
    const id = store.tx(() => {
      const newId = store.createMonitor(data);
      applyEdges(newId, parentIds, childIds);
      applyMonitorTags(newId, tagIds, body.tagsDownstream);
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
    const tagIds = tagIdsFrom(body.tagIds);
    const oldChildren = engine.graph.childrenOf(existing.id);
    store.tx(() => {
      store.updateMonitor(existing.id, data);
      // Collected data describes the old target; the next check refills it.
      if (existing.type !== data.type || checkedConfig(existing.config) !== checkedConfig(data.config)) store.clearMonitorData(existing.id);
      applyEdges(existing.id, parentIds, childIds);
      applyMonitorTags(existing.id, tagIds, body.tagsDownstream);
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
    moveMonitors([{ id: m.id, fromParentId: body.fromParentId ?? null }], body.toParentId, body.link);
    return monitorDetail(store.getMonitor(m.id));
  });

  // The same for several monitors at once: moves = [{id, fromParentId}].
  // Without a fromParentId (selected in the Falls, not under one particular
  // parent) a move replaces all of the monitor's parents. A monitor whose
  // parent is moving too stays under it, so moved subtrees keep their shape.
  route('POST', '/api/monitors/move', ({ body }) => {
    if (!Array.isArray(body.moves) || !body.moves.length) throw new HttpError(400, 'Nothing to move');
    return { ok: true, ...moveMonitors(body.moves, body.toParentId, body.link) };
  });

  const moveMonitors = (list, toParentId, link) => {
    const to = toParentId == null ? null : monitorOr404(toParentId).id;
    const moves = new Map();
    for (const mv of list) {
      const id = monitorOr404(mv?.id).id;
      moves.set(id, mv.fromParentId === undefined ? undefined : mv.fromParentId === null ? null : Number(mv.fromParentId));
    }
    if (moves.has(to)) throw new HttpError(400, 'A monitor cannot be moved under itself');
    let moved = 0;
    let along = 0;
    store.tx(() => {
      for (const [id, from] of moves) {
        let parents = engine.graph.parentsOf(id);
        if (from === undefined ? parents.some((p) => moves.has(p)) : moves.has(from)) {
          along++;
          continue;
        }
        if (!link) parents = from === undefined ? [] : parents.filter((p) => p !== from);
        if (to != null && !parents.includes(to)) parents.push(to);
        applyEdges(id, parents, undefined);
        moved++;
      }
    });
    engine.reload([...moves.keys()]);
    return { moved, along };
  };

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
    return new RawResponse(icon.mime, icon.data, ICON_HEADERS);
  });

  route('GET', '/api/monitors/:id/events', ({ params }) => store.importantHeartbeats(monitorOr404(params.id).id, 50));

  // The latest data the monitor's checks collected (SNMP): { at, data,
  // display }, at and data null before the first. `display` holds the
  // settings for how it is shown (extra OIDs, hidden items, the card).
  route('GET', '/api/monitors/:id/data', ({ params }) => {
    const m = monitorOr404(params.id);
    return { at: null, data: null, ...store.getMonitorData(m.id), display: displayOf(m) };
  });

  // Change how an SNMP monitor's data is shown: any of { oids, hide, card }.
  // The monitor is checked again so its card text follows.
  route('PUT', '/api/monitors/:id/snmp-display', ({ params, body }) => {
    const m = monitorOr404(params.id);
    if (m.type !== 'snmp') throw new HttpError(400, 'Not an SNMP monitor');
    const config = { ...m.config };
    for (const key of DISPLAY_KEYS) if (body?.[key] !== undefined) config[key] = body[key];
    store.updateMonitor(m.id, normalizeMonitor({ config }, m));
    engine.reload([m.id]);
    return displayOf(store.getMonitor(m.id));
  });

  // A page of everything the device reports, for the "All data" view.
  route('GET', '/api/monitors/:id/snmp/walk', async ({ params, query }) => {
    const m = monitorOr404(params.id);
    if (m.type !== 'snmp') throw new HttpError(400, 'Not an SNMP monitor');
    const start = query.start && isOid(query.start) ? query.start : undefined;
    try {
      return await snmpBrowse(m, { start, limit: int(query.limit, 2000, 50, 10000) });
    } catch (err) {
      throw new HttpError(502, err.message);
    }
  });

  // ---- MIB library

  route('GET', '/api/mibs', () => ({ modules: mibLibrary().list() }));

  // { files: [{ filename, text }] }. Each module in a file is stored on its
  // own, replacing an uploaded or bundled one of the same name.
  route('POST', '/api/mibs', ({ body }) => {
    if (!Array.isArray(body?.files)) throw new HttpError(400, 'files must be a list');
    const files = body.files;
    const before = mibLibrary();
    const added = [];
    const errors = [];
    store.tx(() => {
      for (const f of files) {
        const filename = String(f?.filename ?? '').slice(0, 200) || 'MIB';
        if (typeof f?.text !== 'string' || !f.text.trim()) {
          errors.push({ filename, error: 'Empty file' });
          continue;
        }
        let mods;
        try {
          mods = parseMib(f.text);
        } catch (err) {
          errors.push({ filename, error: err.message });
          continue;
        }
        const texts = splitModules(f.text);
        for (const mod of mods) {
          store.putMib({ name: mod.name, filename, text: texts.get(mod.name) ?? f.text });
          added.push({ name: mod.name, filename, replaced: before.modules.get(mod.name)?.source ?? null });
        }
      }
    });
    if (added.length) mibsChanged();
    return { added, errors, modules: mibLibrary().list() };
  });

  route('DELETE', '/api/mibs/:name', ({ params }) => {
    if (!store.deleteMib(params.name)) throw new HttpError(404, 'No uploaded MIB by that name');
    mibsChanged();
    return { modules: mibLibrary().list() };
  });

  route('GET', '/api/monitors/:id/uptime', ({ params }) => {
    const m = monitorOr404(params.id);
    const now = Date.now();
    const pick = (since) => store.uptimeSince(since).get(m.id) ?? { uptime: null, avgPing: null };
    return { day: pick(now - 86400000), week: pick(now - 7 * 86400000), month: pick(now - 30 * 86400000) };
  });

  // ---- tags ----------------------------------------------------------------

  const tagOr404 = (id) => {
    const t = store.getTag(Number(id));
    if (!t) throw new HttpError(404, 'Tag not found');
    return t;
  };

  const uniqueTagName = (name, id) => {
    const clash = store.findTagByName(name);
    if (clash && clash.id !== id) throw new HttpError(400, `There is already a tag called "${clash.name}"`);
  };

  route('GET', '/api/tags', () => {
    const counts = new Map();
    for (const ids of store.monitorTagMap().values()) for (const t of ids) counts.set(t, (counts.get(t) ?? 0) + 1);
    return store.listTags().map((t) => ({ ...t, count: counts.get(t.id) ?? 0 }));
  });

  // A tag's uploaded icon arrives as a data URL in `iconData`, as for monitors.
  const tagIconUpload = (body, t, existing) => {
    if (t.icon !== 'upload') return null;
    if (body.iconData) return badRequest(() => decodeDataUrl(body.iconData));
    if (!existing || !store.getTagIcon(existing.id)) throw new HttpError(400, 'Choose an image to upload for the icon');
    return null;
  };

  route('POST', '/api/tags', ({ body }) => {
    const t = normalizeTag(body);
    uniqueTagName(t.name, null);
    const upload = tagIconUpload(body, t, null);
    const id = store.tx(() => {
      const newId = store.createTag(t);
      if (upload) store.setTagIcon(newId, upload);
      return newId;
    });
    engine.touch();
    return store.getTag(id);
  });

  route('PUT', '/api/tags/:id', ({ params, body }) => {
    const existing = tagOr404(params.id);
    const t = normalizeTag(body, existing);
    uniqueTagName(t.name, existing.id);
    const upload = tagIconUpload(body, t, existing);
    store.tx(() => {
      store.updateTag(existing.id, t);
      if (upload) store.setTagIcon(existing.id, upload);
    });
    engine.touch();
    iconsChanged(null);
    return store.getTag(existing.id);
  });

  route('DELETE', '/api/tags/:id', ({ params }) => {
    store.deleteTag(tagOr404(params.id).id);
    engine.touch();
    iconsChanged(null);
    return { ok: true };
  });

  route('GET', '/api/tags/:id/icon', ({ params }) => {
    const icon = store.getTagIcon(tagOr404(params.id).id);
    if (!icon) throw new HttpError(404, 'No icon');
    return new RawResponse(icon.mime, icon.data, ICON_HEADERS);
  });

  // Add (or with remove=true, take off) a tag on several monitors at once,
  // optionally including everything downstream of them.
  route('POST', '/api/tags/:id/apply', ({ params, body }) => {
    const tag = tagOr404(params.id);
    const ids = idList(body.monitorIds) ?? [];
    if (ids.some((id) => !engine.monitors.has(id))) throw new HttpError(400, 'Unknown monitor');
    const targets = new Set(ids);
    if (body.downstream) for (const id of ids) for (const d of engine.graph.descendants(id)) targets.add(d);
    let changed = 0;
    store.tx(() => {
      for (const id of targets) changed += body.remove ? store.untagMonitor(id, tag.id) : store.tagMonitor(id, tag.id);
    });
    if (changed) {
      engine.touch();
      iconsChanged(null);
    }
    return { ok: true, changed, monitors: targets.size };
  });

  // ---- CSV import & export -------------------------------------------------

  const csvFile = (name, text) => new RawResponse('text/csv; charset=utf-8', text, {
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store',
  });

  route('GET', '/api/csv/export', () => csvFile(`waterfall-alert-monitors-${new Date().toISOString().slice(0, 10)}.csv`, exportCsv(store)));
  route('GET', '/api/csv/template', () => csvFile('waterfall-alert-template.csv', csvTemplate()));
  route('GET', '/api/csv/example', () => csvFile('waterfall-alert-example.csv', CSV_EXAMPLE));
  route('GET', '/api/csv/columns', () => CSV_COLUMNS.map(({ name, types, values, def, required, help }) => ({ name, types, values, def, required, help })));

  // With dryRun nothing is saved; the result says what would happen.
  route('POST', '/api/csv/import', ({ body }) => {
    const mode = ['add', 'update', 'skip'].includes(body.mode) ? body.mode : 'add';
    const res = importCsv(store, String(body.csv ?? ''), { mode, dryRun: Boolean(body.dryRun) });
    if (res.applied) {
      for (const u of res.uploads) icons.saveUpload(u.id, u.img);
      engine.reload(res.affected);
      icons.sync(store.listMonitors(), res.affected);
    }
    const { affected, uploads, ...summary } = res;
    return summary;
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
