import { Graph } from './graph.js';
import { deliver, providerCatalog, providers } from './notifier.js';
import { config, isAddon } from './config.js';
import { decodeDataUrl } from './icons.js';
import { HttpError, badRequest, int, idList, normalizeMonitor, normalizeTag } from './validate.js';
import { exportCsv, importCsv, CSV_COLUMNS, CSV_EXAMPLE, csvTemplate } from './transfer.js';
import { DISPLAY_KEYS, snmpBrowse } from './checkers/snmp.js';
import { isOid } from './snmp.js';
import { buildLibrary, mibLibrary, parseMib, setMibLibrary, splitModules } from './mib.js';
import { parseTagExpr, renameInExpr } from '../public/js/filter.js';
import { normalizeValueProblem, inScope, SEVERITIES } from './problems.js';

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
    snap.problems = store.listProblems().map(({ id, kind, name, severity }) => ({ id, kind, name, severity }));
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

  // What the MIBs know about an OID: { name, module, enums, units, desc } or null.
  route('GET', '/api/mibs/object', ({ query }) => {
    const oid = String(query.oid ?? '').trim().replace(/^\./, '');
    if (!isOid(oid)) return null;
    const hit = mibLibrary().label(oid);
    if (!hit) return null;
    const syn = hit.entry.syntax ?? {};
    return { name: hit.name, module: hit.entry.module, type: syn.tc ?? syn.base ?? null, enums: syn.enums ?? null, units: hit.entry.units ?? null, desc: hit.entry.desc ?? null };
  });

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
      // Rules written as expressions name their tags; keep them working.
      if (t.name !== existing.name) {
        for (const r of store.listRules()) {
          const expr = r.tagExpr && renameInExpr(r.tagExpr, existing.name, t.name);
          if (expr && expr !== r.tagExpr) store.updateRule(r.id, { ...r, tagExpr: expr });
        }
        for (const p of store.listProblems()) {
          const expr = p.config.tagExpr && renameInExpr(p.config.tagExpr, existing.name, t.name);
          if (expr && expr !== p.config.tagExpr) store.updateProblem(p.id, { ...p, config: { ...p.config, tagExpr: expr } });
        }
      }
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
    return { name, type: body.type, config: body.config ?? {}, active: body.active !== false };
  };

  route('GET', '/api/notification-types', () => providerCatalog());
  route('GET', '/api/notifications', () => store.listNotifications());

  route('POST', '/api/notifications', ({ body }) => {
    const n = normalizeNotification(body);
    const id = store.tx(() => {
      const newId = store.createNotification(n);
      // "Send it everything": a rule for every problem on every monitor.
      if (body.alertAll) store.createRule({ channelIds: [newId] });
      return newId;
    });
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
      title: 'Test: BlueHole is flowing',
      message: [
        'This is a test notification from BlueHole.',
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

  // ---- notification rules and problems ---------------------------------------
  // Rules only decide where alerts go, so changing them needs no reload.

  const ruleOr404 = (id) => store.getRule(Number(id)) ?? (() => { throw new HttpError(404, 'Rule not found'); })();

  // Unknown channels and problems are dropped. Tag ids are kept even when the
  // tag is gone: a rule whose tags were all deleted must stop matching rather
  // than quietly widen to every monitor.
  const normalizeRule = (body, base = {}) => {
    const pick = (key, list) => {
      const known = new Set(list.map((x) => x.id));
      return (idList(body[key]) ?? base[key] ?? []).filter((id) => known.has(id));
    };
    let tagExpr = String(body.tagExpr ?? base.tagExpr ?? '').trim();
    if (tagExpr) {
      const expr = parseTagExpr(tagExpr, store.listTags());
      if (expr?.error) throw new HttpError(400, expr.error);
      tagExpr += ')'.repeat(expr?.unclosed ?? 0);
    }
    return {
      channelIds: pick('channelIds', store.listNotifications()),
      problemIds: pick('problemIds', store.listProblems()),
      minSeverity: SEVERITIES[body.minSeverity ?? base.minSeverity] ? (body.minSeverity ?? base.minSeverity) : '',
      tagIds: tagExpr ? [] : (idList(body.tagIds) ?? base.tagIds ?? []),
      tagMatch: (body.tagMatch ?? base.tagMatch) === 'all' ? 'all' : 'any',
      tagExpr,
      downstream: (body.downstream ?? base.downstream) !== false,
    };
  };

  route('GET', '/api/rules', () => store.listRules());

  route('POST', '/api/rules', ({ body }) => store.getRule(store.createRule(normalizeRule(body))));

  route('PUT', '/api/rules/:id', ({ params, body }) => {
    const existing = ruleOr404(params.id);
    store.updateRule(existing.id, normalizeRule(body, existing));
    return store.getRule(existing.id);
  });

  route('DELETE', '/api/rules/:id', ({ params }) => {
    if (!store.deleteRule(Number(params.id))) throw new HttpError(404, 'Rule not found');
    return { ok: true };
  });

  // Value problems come with who they watch: [{ monitorId, state, since, value }]
  // for each watched monitor that has been read, and `waiting` for the rest
  // (SNMP monitors not checked since), `notSnmp` for tagged monitors that
  // can't be read at all.
  const problemsWithCoverage = () => {
    const tags = store.listTags();
    const tagMap = store.monitorTagMap();
    const state = engine.problemState();
    return store.listProblems().map((p) => {
      if (p.kind !== 'value') return p;
      const watched = [];
      const notSnmp = [];
      const tagged = p.config.tagExpr || p.config.tagIds.length;
      for (const m of engine.monitors.values()) {
        if (!m.active || m.type === 'group' || !inScope(p, tagMap.get(m.id) ?? [], tags)) continue;
        if (m.type === 'snmp') watched.push(m.id);
        else if (tagged) notSnmp.push(m.id);
      }
      const known = new Map(state.filter((x) => x.problemId === p.id).map((x) => [x.monitorId, x]));
      return {
        ...p,
        coverage: {
          monitors: watched.filter((id) => known.has(id)).map((id) => known.get(id)),
          waiting: watched.filter((id) => !known.has(id)),
          notSnmp,
        },
      };
    });
  };

  const problemOr404 = (id) => store.getProblem(Number(id)) ?? (() => { throw new HttpError(404, 'Problem definition not found'); })();

  // The SNMP monitors a problem watches, to check straight away after a change.
  const watchedBy = (p) => {
    const tags = store.listTags();
    const tagMap = store.monitorTagMap();
    return store.listMonitors().filter((m) => m.type === 'snmp' && inScope(p, tagMap.get(m.id) ?? [], tags)).map((m) => m.id);
  };

  route('GET', '/api/problems', () => problemsWithCoverage());

  // The value problems watching one monitor, for its page: its state for
  // each, and which reading it answered. state: 'open' | 'ok' | 'unknown'
  // (answers none of the readings) | 'waiting' (not checked since) |
  // 'notSnmp' (tagged, but there is nothing to read).
  route('GET', '/api/monitors/:id/problems', ({ params }) => {
    const m = engine.monitors.get(Number(params.id));
    if (!m) throw new HttpError(404, 'Monitor not found');
    const tags = store.listTags();
    const mine = store.monitorTagMap().get(m.id) ?? [];
    const state = new Map(engine.problemState().filter((x) => x.monitorId === m.id).map((x) => [x.problemId, x]));
    return store.listProblems()
      .filter((p) => p.kind === 'value' && inScope(p, mine, tags) && (m.type === 'snmp' || p.config.tagExpr || p.config.tagIds.length))
      .map((p) => {
        const x = state.get(p.id);
        return {
          problem: { id: p.id, name: p.name, severity: p.severity, readings: p.config.readings, checks: p.config.checks },
          state: m.type !== 'snmp' ? 'notSnmp' : x?.state ?? 'waiting',
          since: x?.since ?? null,
          value: x?.value ?? '',
          reading: x?.reading ?? null,
        };
      });
  });

  route('POST', '/api/problems', ({ body }) => {
    const p = { kind: 'value', ...normalizeValueProblem(body, undefined, store.listTags()) };
    const id = store.createProblem(p);
    engine.reload(watchedBy(p));
    return problemsWithCoverage().find((x) => x.id === id);
  });

  route('PUT', '/api/problems/:id', ({ params, body }) => {
    const existing = problemOr404(params.id);
    if (existing.kind === 'down') {
      const name = String(body.name ?? existing.name).trim();
      if (!name) throw new HttpError(400, 'Name is required');
      const config = { ...existing.config };
      if (body.config?.recovery != null) config.recovery = Boolean(body.config.recovery);
      store.updateProblem(existing.id, { name, severity: 'severe', config });
    } else {
      const next = normalizeValueProblem(body, existing, store.listTags());
      store.updateProblem(existing.id, next);
      // check the monitors it watched and watches now
      engine.reload([...new Set([...watchedBy(existing), ...watchedBy({ ...existing, ...next })])]);
    }
    return problemsWithCoverage().find((x) => x.id === existing.id);
  });

  // Rules that named only this problem would become "any problem" without
  // it, so they go too (the page warns first); others just drop it.
  route('DELETE', '/api/problems/:id', ({ params }) => {
    const existing = problemOr404(params.id);
    if (existing.kind === 'down') throw new HttpError(400, "The built-in problem definition can't be deleted");
    let rulesDeleted = 0;
    store.tx(() => {
      for (const r of store.listRules()) {
        if (!r.problemIds.includes(existing.id)) continue;
        const rest = r.problemIds.filter((id) => id !== existing.id);
        if (rest.length) store.updateRule(r.id, { ...r, problemIds: rest });
        else {
          store.deleteRule(r.id);
          rulesDeleted++;
        }
      }
      store.deleteProblem(existing.id);
    });
    engine.forgetProblem(existing.id);
    return { ok: true, rulesDeleted };
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
