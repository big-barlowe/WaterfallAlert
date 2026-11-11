import fs from 'node:fs';
import path from 'node:path';

// Home Assistant writes add-on options to /data/options.json. Outside HA we
// fall back to environment variables so the app runs standalone for dev.
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.resolve('data'));

let options = {};
try {
  options = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'options.json'), 'utf8'));
} catch {
  // not running under the Supervisor (or no options yet)
}

export const config = {
  dataDir: DATA_DIR,
  port: Number(process.env.PORT || 8099),
  logLevel: options.log_level || process.env.LOG_LEVEL || 'info',
  allowDirectAccess: options.allow_direct_access ?? process.env.ALLOW_DIRECT_ACCESS !== 'false',
  supervisorToken: process.env.SUPERVISOR_TOKEN || null,
  // HA API: via the Supervisor proxy when running as an add-on, or a
  // user-supplied URL + long-lived token for standalone dev.
  haUrl: process.env.SUPERVISOR_TOKEN ? 'http://supervisor/core' : (process.env.HA_URL || null),
  haToken: process.env.SUPERVISOR_TOKEN || process.env.HA_TOKEN || null,
};

export const isAddon = Boolean(config.supervisorToken);

const LEVELS = { debug: 10, info: 20, warning: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? 20;

function emit(level, args) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  console[level === 'error' ? 'error' : 'log'](`${ts} [${level.toUpperCase()}]`, ...args);
}

export const log = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warning', a),
  error: (...a) => emit('error', a),
};
