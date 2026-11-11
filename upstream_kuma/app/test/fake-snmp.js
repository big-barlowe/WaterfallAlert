// A fake SNMP agent for the tests, over real UDP on 127.0.0.1.
import dgram from 'node:dgram';
import { encodeMessage, decodeMessage, compareOids, PDU, ERROR } from '../src/snmp.js';

// A switch with two ports and a loopback, a little HOST-RESOURCES data and
// one enterprise value.
export function mib() {
  const v = [];
  const add = (oid, type, value) => v.push({ oid, type, value });
  const sys = '1.3.6.1.2.1.1';
  add(`${sys}.1.0`, 'octets', 'Test switch v1.2');
  add(`${sys}.2.0`, 'oid', '1.3.6.1.4.1.9.1.1');
  add(`${sys}.3.0`, 'timeticks', 123456);
  add(`${sys}.4.0`, 'octets', 'Network team');
  add(`${sys}.5.0`, 'octets', 'core-sw');
  add(`${sys}.6.0`, 'octets', 'Server room');
  const ifs = [
    { i: 1, descr: 'GigabitEthernet1/0/1', type: 6, oper: 1, name: 'Gi1/0/1', alias: 'Uplink', hc: true },
    { i: 2, descr: 'GigabitEthernet1/0/2', type: 6, oper: 2, name: 'Gi1/0/2', alias: '', hc: true },
    { i: 3, descr: 'lo', type: 24, oper: 1, name: 'lo', alias: '', hc: false },
  ];
  const col = (n, i) => `1.3.6.1.2.1.2.2.1.${n}.${i}`;
  const xcol = (n, i) => `1.3.6.1.2.1.31.1.1.1.${n}.${i}`;
  for (const f of ifs) {
    add(col(2, f.i), 'octets', f.descr);
    add(col(3, f.i), 'integer', f.type);
    add(col(5, f.i), 'gauge32', f.type === 24 ? 10000000 : 1000000000);
    add(col(6, f.i), 'octets', f.type === 24 ? Buffer.alloc(0) : Buffer.from([0x00, 0x1a, 0x2b, 0x3c, 0x4d, f.i]));
    add(col(7, f.i), 'integer', 1);
    add(col(8, f.i), 'integer', f.oper);
    add(col(10, f.i), 'counter32', 1000 * f.i);
    add(col(14, f.i), 'counter32', f.i === 2 ? 7 : 0);
    add(col(16, f.i), 'counter32', 2000 * f.i);
    add(col(20, f.i), 'counter32', 0);
    add(xcol(1, f.i), 'octets', f.name);
    if (f.hc) {
      add(xcol(6, f.i), 'counter64', 5_000_000_000 * f.i);
      add(xcol(10, f.i), 'counter64', 6_000_000_000 * f.i);
    }
    add(xcol(15, f.i), 'gauge32', f.type === 24 ? 10 : 1000);
    add(xcol(18, f.i), 'octets', f.alias);
  }
  add('1.3.6.1.2.1.25.2.3.1.2.1', 'oid', '1.3.6.1.2.1.25.2.1.2'); // RAM
  add('1.3.6.1.2.1.25.2.3.1.2.3', 'oid', '1.3.6.1.2.1.25.2.1.3'); // virtual memory: left out
  add('1.3.6.1.2.1.25.2.3.1.2.31', 'oid', '1.3.6.1.2.1.25.2.1.4'); // fixed disk
  add('1.3.6.1.2.1.25.2.3.1.3.1', 'octets', 'Physical memory');
  add('1.3.6.1.2.1.25.2.3.1.3.3', 'octets', 'Virtual memory');
  add('1.3.6.1.2.1.25.2.3.1.3.31', 'octets', '/');
  for (const [i, units, size, used] of [[1, 1024, 1000, 250], [3, 1024, 500, 1], [31, 4096, 1000, 500]]) {
    add(`1.3.6.1.2.1.25.2.3.1.4.${i}`, 'integer', units);
    add(`1.3.6.1.2.1.25.2.3.1.5.${i}`, 'integer', size);
    add(`1.3.6.1.2.1.25.2.3.1.6.${i}`, 'integer', used);
  }
  add('1.3.6.1.2.1.25.3.3.1.2.196608', 'integer', 10);
  add('1.3.6.1.2.1.25.3.3.1.2.196609', 'integer', 30);
  add('1.3.6.1.4.1.99.1.0', 'integer', 42);
  return v.sort((a, b) => compareOids(a.oid, b.oid));
}

// Answers GET/GETNEXT/GETBULK from `values`. Wrong community: silence, like
// a real agent. `tooBigAbove`: GETBULKs asking for more get tooBig.
export async function agent({ version = '2c', community = 'public', values = mib(), tooBigAbove = Infinity } = {}) {
  const sock = dgram.createSocket('udp4');
  const stats = { requests: 0, bulk: 0, next: 0 };
  sock.on('message', (msg, rinfo) => {
    const req = decodeMessage(msg);
    stats.requests++;
    if (req.community !== community || req.version !== version) return;
    const { type, id, a, b, varbinds } = req.pdu;
    const after = (oid) => values.find((x) => compareOids(x.oid, oid) > 0);
    let out = [];
    let err = 0;
    let index = 0;
    if (type === PDU.GET) {
      varbinds.forEach((vb, i) => {
        const hit = values.find((x) => x.oid === vb.oid);
        if (hit) out.push(hit);
        else if (version === '1') {
          if (!err) [err, index] = [ERROR.noSuchName, i + 1];
        } else out.push({ oid: vb.oid, type: 'noSuchObject' });
      });
      if (err) out = varbinds;
    } else if (type === PDU.GETNEXT) {
      stats.next++;
      const hit = after(varbinds[0].oid);
      if (hit) out.push(hit);
      else [err, index, out] = [ERROR.noSuchName, 1, varbinds];
    } else if (type === PDU.GETBULK) {
      stats.bulk++;
      if (b > tooBigAbove) [err, out] = [ERROR.tooBig, []];
      else {
        let oid = varbinds[0].oid;
        for (let n = 0; n < b; n++) {
          const hit = after(oid);
          if (!hit) {
            out.push({ oid, type: 'endOfMibView' });
            break;
          }
          out.push(hit);
          oid = hit.oid;
        }
      }
    }
    sock.send(encodeMessage({ version, community, pdu: { type: PDU.RESPONSE, id, a: err, b: index, varbinds: out } }), rinfo.port, rinfo.address);
  });
  await new Promise((r) => sock.bind(0, '127.0.0.1', r));
  return { port: sock.address().port, stats, values, close: () => sock.close() };
}

