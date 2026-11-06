// Input validation shared by the REST routes and the CSV import.
import { MONITOR_TYPES } from './checkers/index.js';
import { validateIconSpec } from './icons.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (fn) => {
  try {
    return fn();
  } catch (err) {
    throw new HttpError(400, err.message);
  }
};

export const int = (v, def, min, max) => {
  const n = v === undefined || v === null || v === '' ? def : Math.round(Number(v));
  if (!Number.isFinite(n)) throw new HttpError(400, `Expected a number, got "${v}"`);
  return Math.min(max, Math.max(min, n));
};

export const idList = (v) => (Array.isArray(v) ? [...new Set(v.map(Number).filter(Number.isInteger))] : undefined);

export function normalizeMonitor(body, existing) {
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

export const TAG_COLOR = /^#[0-9a-f]{6}$/;

// Same presets as the colour picker (public/js/tags.js), for tags created
// without a colour, e.g. by a CSV import.
export const TAG_COLORS = ['#60a5fa', '#818cf8', '#a78bfa', '#e879f9', '#f472b6', '#fb923c', '#facc15', '#a3e635', '#22d3ee', '#94a3b8'];

export function normalizeTag(body, existing) {
  const name = String(body.name ?? existing?.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new HttpError(400, 'Tag name is required');
  if (name.length > 32) throw new HttpError(400, 'Tag names can be at most 32 characters');
  if (name.includes('|')) throw new HttpError(400, 'Tag names cannot contain "|"');
  const color = String(body.color ?? existing?.color ?? '').toLowerCase();
  if (!TAG_COLOR.test(color)) throw new HttpError(400, 'Tag colour must look like #38bdf8');
  return { name, color };
}

