import { checkHttp } from './http.js';
import { checkTcp, checkPing, checkDns } from './network.js';
import { checkHaEntity } from './homeassistant.js';

// Each checker resolves to { ok, ping?, msg } or throws (treated as down).
// `group` has no checker: groups are folders whose state is derived from
// their children. `push` is evaluated by the engine from the last push time.
export const checkers = {
  http: checkHttp,
  tcp: checkTcp,
  ping: checkPing,
  dns: checkDns,
  ha_entity: checkHaEntity,
};

export const MONITOR_TYPES = ['group', 'http', 'tcp', 'ping', 'dns', 'ha_entity', 'push'];
