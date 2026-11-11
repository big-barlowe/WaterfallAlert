// Problems besides "a monitor is down": kind 'value' watches a value on the
// monitors with certain tags and is open while a test on it holds.
//
// A value problem's config:
//   tagIds, tagMatch, tagExpr  which monitors (as a rule picks them; none = all)
//   readings   [{ source, oid?, op, values?, value?, label?, names? }]: ways to
//              read the value. Devices differ (a standard MIB, or each vendor's
//              own), so a monitor uses the first reading it answers.
//                source  'oid' (an SNMP GET) or 'cpu' | 'memory' | 'disk' (%,
//                        from what the SNMP check collects; disk = the fullest)
//                op      'in' | 'not-in' (values) or '<' '<=' '>' '>=' (value)
//                names   { "5": "battery" }, for values no loaded MIB names
//                where   { sysObjectId?, monitorIds? }: only devices of that
//                        model (sysObjectID, exact) or only those monitors
//   checks     how many checks in a row before it opens (default 1)
//   recovery   send a resolved alert when it clears (default true)
//   downstream list everything below the monitor in its alert (default false)

import { HttpError } from './validate.js';
import { isOid } from './snmp.js';
import { parseTagExpr } from '../public/js/filter.js';
import { ruleTagTest, SEVERITIES } from '../public/js/rules.js';

export { SEVERITIES };
export const SOURCES = ['oid', 'cpu', 'memory', 'disk'];
export const OPS = ['in', 'not-in', '<', '<=', '>', '>='];
const MAX_READINGS = 20;

// Whether `m` is one of the monitors a problem watches (null: its tags are
// broken, so it watches nothing).
export function inScope(problem, tagIdsOfMonitor, tags) {
  const t = ruleTagTest(problem.config, tags);
  return t.error ? false : t.test(tagIdsOfMonitor);
}

// The OIDs a set of problems needs read on one monitor.
export function probeOids(problems) {
  const oids = new Set();
  for (const p of problems) for (const r of p.config.readings ?? []) if (r.source === 'oid') oids.add(r.oid);
  return [...oids];
}

// The value one reading gets out of a successful check, or null.
// probe: { [oid]: { value, text } }; data: the SNMP snapshot.
export function readValue(reading, { probe = {}, data = null } = {}) {
  if (reading.source === 'oid') {
    const got = probe[reading.oid];
    if (!got || got.value == null) return null;
    const named = reading.names?.[String(got.value)];
    return { value: got.value, text: named ? `${named} (${got.value})` : got.text ?? String(got.value) };
  }
  if (!data) return null;
  if (reading.source === 'cpu') {
    return data.cpu?.load == null ? null : { value: data.cpu.load, text: `CPU ${data.cpu.load}%` };
  }
  const pct = (s) => (s.size ? Math.round((s.used / s.size) * 100) : null);
  if (reading.source === 'memory') {
    const mem = data.storage?.find((s) => s.kind === 'memory');
    const v = mem && pct(mem);
    return v == null ? null : { value: v, text: `Memory ${v}%` };
  }
  if (reading.source === 'disk') {
    const disks = (data.storage ?? []).filter((s) => s.kind === 'disk' && s.size).map((s) => ({ name: s.name, v: pct(s) }));
    if (!disks.length) return null;
    const worst = disks.reduce((a, b) => (b.v > a.v ? b : a));
    return { value: worst.v, text: `${worst.name} ${worst.v}% full` };
  }
  return null;
}

const same = (a, b) => (typeof a === 'number' || /^-?\d+(\.\d+)?$/.test(String(a))) && /^-?\d+(\.\d+)?$/.test(String(b))
  ? Number(a) === Number(b)
  : String(a).toLowerCase() === String(b).toLowerCase();

export function testReading(reading, value) {
  const n = Number(value);
  switch (reading.op) {
    case 'in': return reading.values.some((v) => same(value, v));
    case 'not-in': return !reading.values.some((v) => same(value, v));
    case '<': return n < reading.value;
    case '<=': return n <= reading.value;
    case '>': return n > reading.value;
    case '>=': return n >= reading.value;
    default: return false;
  }
}

// Whether a reading is meant for this monitor at all.
export function readingApplies(reading, monitor, result) {
  const w = reading.where;
  if (!w) return true;
  if (w.monitorIds?.length && !w.monitorIds.includes(monitor?.id)) return false;
  if (w.sysObjectId && String(result?.data?.system?.objectId ?? '').replace(/^\./, '') !== w.sysObjectId) return false;
  return true;
}

// { state: 'open' | 'ok' | 'unknown', value?, reading? } for one check.
export function evaluate(problem, result, monitor = null) {
  const readings = problem.config.readings ?? [];
  for (let i = 0; i < readings.length; i++) {
    if (!readingApplies(readings[i], monitor, result)) continue;
    const got = readValue(readings[i], result);
    if (!got) continue;
    return { state: testReading(readings[i], got.value) ? 'open' : 'ok', value: got.text, reading: i };
  }
  return { state: 'unknown', value: '' };
}

// ---- validation -------------------------------------------------------------

const idList = (v) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : null);
const text = (v, max) => String(v ?? '').trim().slice(0, max);

function normalizeReading(r, i) {
  const where = `Reading ${i + 1}`;
  const source = SOURCES.includes(r?.source) ? r.source : 'oid';
  const op = OPS.includes(r?.op) ? r.op : null;
  if (!op) throw new HttpError(400, `${where}: pick a test`);
  const out = { source, op };
  if (source === 'oid') {
    const oid = text(r.oid, 400).replace(/^\./, '');
    if (!isOid(oid)) throw new HttpError(400, `${where}: "${oid}" is not an OID`);
    out.oid = oid;
  }
  if (op === 'in' || op === 'not-in') {
    const values = (Array.isArray(r.values) ? r.values : String(r.values ?? '').split(','))
      .map((v) => (typeof v === 'number' ? v : text(v, 200))).filter((v) => v !== '');
    if (!values.length) throw new HttpError(400, `${where}: give at least one value`);
    out.values = values.map((v) => (/^-?\d+(\.\d+)?$/.test(String(v)) ? Number(v) : v)).slice(0, 50);
  } else {
    const value = Number(r.value);
    if (r.value === '' || r.value == null || !Number.isFinite(value)) throw new HttpError(400, `${where}: give a number to compare with`);
    out.value = value;
  }
  const label = text(r.label, 60);
  if (label) out.label = label;
  if (r.where && typeof r.where === 'object') {
    const scope = {};
    const sys = text(r.where.sysObjectId, 400).replace(/^\./, '');
    if (sys) {
      if (!isOid(sys)) throw new HttpError(400, `${where}: "${sys}" is not a sysObjectID`);
      scope.sysObjectId = sys;
    }
    const ids = idList(r.where.monitorIds);
    if (ids?.length) scope.monitorIds = [...new Set(ids)].slice(0, 500);
    if (Object.keys(scope).length) out.where = scope;
  }
  if (r.names && typeof r.names === 'object') {
    const names = Object.fromEntries(Object.entries(r.names).slice(0, 100).map(([k, v]) => [text(k, 40), text(v, 60)]).filter(([k, v]) => k && v));
    if (Object.keys(names).length) out.names = names;
  }
  return out;
}

// A value problem from a request body, over `base` (the stored one) for
// anything left out. Throws HttpError on anything invalid.
export function normalizeValueProblem(body, base = { name: '', severity: 'warning', config: {} }, tags = []) {
  const name = text(body.name ?? base.name, 80);
  if (!name) throw new HttpError(400, 'Name is required');
  const severity = body.severity ?? base.severity;
  if (!SEVERITIES[severity]) throw new HttpError(400, `Severity must be one of ${Object.keys(SEVERITIES).join(', ')}`);
  const c = { ...base.config, ...(body.config ?? {}) };
  let tagExpr = text(c.tagExpr, 1000);
  if (tagExpr) {
    const expr = parseTagExpr(tagExpr, tags);
    if (expr?.error) throw new HttpError(400, expr.error);
    tagExpr += ')'.repeat(expr?.unclosed ?? 0);
  }
  const readings = Array.isArray(c.readings) ? c.readings : [];
  if (!readings.length) throw new HttpError(400, 'Add at least one reading');
  if (readings.length > MAX_READINGS) throw new HttpError(400, `At most ${MAX_READINGS} readings`);
  const checks = Math.round(Number(c.checks ?? 1));
  return {
    name,
    severity,
    config: {
      tagIds: tagExpr ? [] : (idList(c.tagIds) ?? []),
      tagMatch: c.tagMatch === 'all' ? 'all' : 'any',
      tagExpr,
      readings: readings.map(normalizeReading),
      checks: Number.isFinite(checks) ? Math.min(20, Math.max(1, checks)) : 1,
      recovery: c.recovery !== false,
      downstream: c.downstream === true,
    },
  };
}
