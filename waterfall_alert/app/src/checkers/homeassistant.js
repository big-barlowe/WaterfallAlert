import { config } from '../config.js';

export async function haRequest(path, { method = 'GET', body, timeoutMs = 10000 } = {}) {
  if (!config.haUrl || !config.haToken) {
    throw new Error('Home Assistant API not available (run as an add-on, or set HA_URL and HA_TOKEN)');
  }
  const res = await fetch(`${config.haUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.haToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Home Assistant API: HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}

const DEAD_STATES = new Set(['unavailable', 'unknown']);

export async function checkHaEntity(monitor) {
  const { entityId, expectedState } = monitor.config;
  if (!entityId) throw new Error('Entity ID is required');
  const start = performance.now();
  let state;
  try {
    state = await haRequest(`/api/states/${encodeURIComponent(entityId)}`, { timeoutMs: monitor.timeout * 1000 });
  } catch (err) {
    if (/HTTP 404/.test(err.message)) return { ok: false, msg: `${entityId} does not exist` };
    throw err;
  }
  const ping = Math.round(performance.now() - start);
  const value = String(state.state);
  if (expectedState) {
    const wanted = expectedState.split(',').map((s) => s.trim().toLowerCase());
    const ok = wanted.includes(value.toLowerCase());
    return { ok, ping, msg: ok ? `State: ${value}` : `State is "${value}", expected ${expectedState}` };
  }
  const ok = !DEAD_STATES.has(value);
  return { ok, ping, msg: `State: ${value}` };
}
