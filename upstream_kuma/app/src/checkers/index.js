import { checkHttp } from './http.js';
import { checkTcp, checkPing, checkDns } from './network.js';
import { checkHaEntity } from './homeassistant.js';
import { checkMinecraft } from './minecraft.js';
import { checkSnmp } from './snmp.js';

// Each checker resolves to { ok, ping?, msg, data? } or throws (treated as
// down). It is called as fn(monitor, { previous }), where `previous` is the
// `data` the last successful check returned (kept by the engine).
// `group` has no checker: groups are folders whose state is derived from
// their children. `push` is evaluated by the engine from the last push time.
export const checkers = {
  http: checkHttp,
  tcp: checkTcp,
  ping: checkPing,
  dns: checkDns,
  ha_entity: checkHaEntity,
  minecraft: checkMinecraft,
  snmp: checkSnmp,
};

export const MONITOR_TYPES = ['group', 'http', 'tcp', 'ping', 'dns', 'ha_entity', 'minecraft', 'snmp', 'push'];
