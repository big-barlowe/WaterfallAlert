// A small SNMP v1/v2c client: GET, and walks with GETBULK (v2c) or GETNEXT
// (v1), over UDP. No dependencies. The message encoding is exported so the
// tests can run a fake agent.
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';

// ---- BER --------------------------------------------------------------------

const T = {
  INTEGER: 0x02, OCTETS: 0x04, NULL: 0x05, OID: 0x06, SEQUENCE: 0x30,
  IPADDRESS: 0x40, COUNTER32: 0x41, GAUGE32: 0x42, TIMETICKS: 0x43, OPAQUE: 0x44, COUNTER64: 0x46, UINTEGER32: 0x47,
  NO_SUCH_OBJECT: 0x80, NO_SUCH_INSTANCE: 0x81, END_OF_MIB_VIEW: 0x82,
};
export const PDU = { GET: 0xa0, GETNEXT: 0xa1, RESPONSE: 0xa2, GETBULK: 0xa5 };
export const ERROR = { tooBig: 1, noSuchName: 2 };

// Value types by tag, as they appear in `{ oid, type, value }`.
const TYPE_NAMES = {
  [T.INTEGER]: 'integer', [T.OCTETS]: 'octets', [T.NULL]: 'null', [T.OID]: 'oid', [T.IPADDRESS]: 'ip',
  [T.COUNTER32]: 'counter32', [T.GAUGE32]: 'gauge32', [T.TIMETICKS]: 'timeticks', [T.OPAQUE]: 'opaque',
  [T.COUNTER64]: 'counter64', [T.UINTEGER32]: 'gauge32',
  [T.NO_SUCH_OBJECT]: 'noSuchObject', [T.NO_SUCH_INSTANCE]: 'noSuchInstance', [T.END_OF_MIB_VIEW]: 'endOfMibView',
};
const TYPE_TAGS = Object.fromEntries(Object.entries(TYPE_NAMES).map(([tag, name]) => [name, Number(tag)]));
export const MISSING = new Set(['noSuchObject', 'noSuchInstance', 'endOfMibView']);

function tlv(tag, body) {
  const n = body.length;
  let len;
  if (n < 0x80) len = Buffer.from([n]);
  else {
    const bytes = [];
    for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
    len = Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), len, body]);
}

// Two's complement, as few bytes as it takes.
function intBody(v) {
  let n = BigInt(v);
  const bytes = [];
  for (;;) {
    const b = Number(n & 0xffn);
    bytes.unshift(b);
    n >>= 8n;
    if ((n === 0n && !(b & 0x80)) || (n === -1n && b & 0x80)) break;
  }
  return Buffer.from(bytes);
}

// Unsigned (counters, gauges, ticks): a leading zero keeps the top bit clear.
function uintBody(v) {
  let n = BigInt(v);
  const bytes = [];
  do {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  } while (n > 0n);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return Buffer.from(bytes);
}

function oidBody(oid) {
  const arcs = parseOid(oid);
  if (arcs.length < 2) throw new Error(`Bad OID "${oid}"`);
  const out = [arcs[0] * 40 + arcs[1]];
  for (const a of arcs.slice(2)) {
    const chunk = [a & 0x7f];
    for (let v = Math.floor(a / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return Buffer.from(out);
}

export const parseOid = (oid) => String(oid).replace(/^\./, '').split('.').map(Number);
export const isOid = (s) => /^\.?\d+(\.\d+)+$/.test(String(s).trim());

function encodeValue(type, value) {
  switch (type) {
    case 'integer': return tlv(T.INTEGER, intBody(value));
    case 'octets': return tlv(T.OCTETS, Buffer.isBuffer(value) ? value : Buffer.from(String(value)));
    case 'oid': return tlv(T.OID, oidBody(value));
    case 'ip': return tlv(T.IPADDRESS, Buffer.from(String(value).split('.').map(Number)));
    case 'counter32': case 'gauge32': case 'timeticks': case 'counter64':
      return tlv(TYPE_TAGS[type], uintBody(value));
    case 'opaque': return tlv(T.OPAQUE, value);
    case 'noSuchObject': case 'noSuchInstance': case 'endOfMibView':
      return tlv(TYPE_TAGS[type], Buffer.alloc(0));
    default: return tlv(T.NULL, Buffer.alloc(0));
  }
}

// { tag, body, next } for the element at `pos`.
function read(buf, pos) {
  if (pos + 2 > buf.length) throw new Error('Truncated SNMP message');
  const tag = buf[pos];
  let len = buf[pos + 1];
  let start = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4) throw new Error('Bad length in SNMP message');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[start + i];
    start += n;
  }
  if (start + len > buf.length) throw new Error('Truncated SNMP message');
  return { tag, body: buf.subarray(start, start + len), next: start + len };
}

function children(body) {
  const out = [];
  for (let pos = 0; pos < body.length;) {
    const el = read(body, pos);
    out.push(el);
    pos = el.next;
  }
  return out;
}

function readInt(body) {
  if (!body.length) return 0;
  let n = BigInt.asIntN(8, BigInt(body[0]));
  for (let i = 1; i < body.length; i++) n = (n << 8n) | BigInt(body[i]);
  return Number(n);
}

function readUint(body) {
  let n = 0n;
  for (const b of body) n = (n << 8n) | BigInt(b);
  return Number(n); // counters past 2^53 lose precision, which rates can live with
}

function readOid(body) {
  const arcs = [];
  let v = 0;
  for (const b of body) {
    v = v * 128 + (b & 0x7f);
    if (!(b & 0x80)) {
      arcs.push(v);
      v = 0;
    }
  }
  if (!arcs.length) return '';
  const first = arcs.shift();
  const a = first < 80 ? Math.floor(first / 40) : 2;
  return [a, first - a * 40, ...arcs].join('.');
}

function decodeValue({ tag, body }) {
  const type = TYPE_NAMES[tag] ?? 'unknown';
  switch (tag) {
    case T.INTEGER: return { type, value: readInt(body) };
    case T.OCTETS: case T.OPAQUE: return { type, value: Buffer.from(body) };
    case T.OID: return { type, value: readOid(body) };
    case T.IPADDRESS: return { type, value: [...body].join('.') };
    case T.COUNTER32: case T.GAUGE32: case T.TIMETICKS: case T.COUNTER64: case T.UINTEGER32:
      return { type, value: readUint(body) };
    default: return { type, value: null };
  }
}

const VERSIONS = { 1: 0, '2c': 1 };

// pdu: { type, id, a, b, varbinds: [{ oid, type?, value? }] }. For GETBULK,
// a and b are non-repeaters and max-repetitions; otherwise error status and
// index.
export function encodeMessage({ version = '2c', community = 'public', pdu }) {
  const varbinds = pdu.varbinds.map((vb) => tlv(T.SEQUENCE, Buffer.concat([tlv(T.OID, oidBody(vb.oid)), encodeValue(vb.type ?? 'null', vb.value)])));
  const body = Buffer.concat([tlv(T.INTEGER, intBody(pdu.id)), tlv(T.INTEGER, intBody(pdu.a ?? 0)), tlv(T.INTEGER, intBody(pdu.b ?? 0)), tlv(T.SEQUENCE, Buffer.concat(varbinds))]);
  return tlv(T.SEQUENCE, Buffer.concat([tlv(T.INTEGER, intBody(VERSIONS[version] ?? 1)), tlv(T.OCTETS, Buffer.from(community)), tlv(pdu.type, body)]));
}

export function decodeMessage(buf) {
  const top = read(buf, 0);
  if (top.tag !== T.SEQUENCE) throw new Error('Not an SNMP message');
  const [ver, community, pdu] = children(top.body);
  if (!pdu) throw new Error('Not an SNMP message');
  const [id, a, b, list] = children(pdu.body);
  const varbinds = children(list.body).map((vb) => {
    const [oid, value] = children(vb.body);
    return { oid: readOid(oid.body), ...decodeValue(value) };
  });
  const v = readInt(ver.body);
  return {
    version: v === 0 ? '1' : '2c',
    community: community.body.toString(),
    pdu: { type: pdu.tag, id: readInt(id.body), a: readInt(a.body), b: readInt(b.body), varbinds },
  };
}

// ---- client -----------------------------------------------------------------

export function compareOids(x, y) {
  const a = parseOid(x);
  const b = parseOid(y);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

export const inSubtree = (oid, base) => oid.startsWith(`${base.replace(/^\./, '')}.`);

export class SnmpClient {
  constructor({ host, port = 161, community = 'public', version = '2c', timeout = 5000, retries = 1 }) {
    Object.assign(this, { host, port: Number(port) || 161, community, version: version === '1' ? '1' : '2c', timeout, retries });
    this.pending = new Map();
    this.nextId = Math.floor(Math.random() * 0x3fffffff) + 1;
    this.socket = null;
  }

  async #open() {
    if (this.socket) return;
    const address = net.isIP(this.host) ? this.host : (await dns.promises.lookup(this.host)).address;
    this.address = address;
    this.socket = dgram.createSocket(net.isIPv6(address) ? 'udp6' : 'udp4');
    this.socket.on('message', (msg) => {
      let res;
      try {
        res = decodeMessage(msg);
      } catch {
        return; // not for us, or garbled: let the request time out
      }
      const p = this.pending.get(res.pdu.id);
      if (!p) return;
      this.pending.delete(res.pdu.id);
      p.resolve(res.pdu);
    });
    this.socket.on('error', (err) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
    this.socket.unref();
  }

  // One request, resent `retries` times if nothing comes back. `timeout`
  // overrides the per-try timeout.
  async request(type, varbinds, a = 0, b = 0, { timeout = this.timeout, retries = this.retries } = {}) {
    await this.#open();
    const id = this.nextId++ & 0x7fffffff;
    const msg = encodeMessage({ version: this.version, community: this.community, pdu: { type, id, a, b, varbinds } });
    for (let attempt = 0; attempt <= retries; attempt++) {
      const reply = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          resolve(null);
        }, timeout);
        this.pending.set(id, {
          resolve: (pdu) => {
            clearTimeout(timer);
            resolve(pdu);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
        this.socket.send(msg, this.port, this.address, (err) => {
          if (err) this.pending.get(id)?.reject(err);
        });
      });
      if (reply) return reply;
    }
    throw new Error(`No SNMP reply from ${this.host}${this.port === 161 ? '' : `:${this.port}`} (check the address, version and community)`);
  }

  // [{ oid, type, value }] in order; a missing OID comes back as type
  // noSuchObject/noSuchInstance (v1 agents reject the whole request instead,
  // so there the missing ones are dropped and the rest asked again).
  async get(oids, opts) {
    let ask = oids.map((oid) => ({ oid }));
    const missing = new Map();
    for (let guard = 0; ask.length && guard <= oids.length; guard++) {
      const pdu = await this.request(PDU.GET, ask, 0, 0, opts);
      if (pdu.a === ERROR.noSuchName && pdu.b > 0) {
        missing.set(ask[pdu.b - 1].oid, true);
        ask = ask.filter((_, i) => i !== pdu.b - 1);
        continue;
      }
      if (pdu.a) throw new Error(`SNMP error ${pdu.a} for ${oids.join(', ')}`);
      const got = new Map(pdu.varbinds.map((vb, i) => [ask[i]?.oid ?? vb.oid, vb]));
      return oids.map((oid) => (missing.has(oid) ? { oid, type: 'noSuchObject', value: null } : got.get(oid) ?? { oid, type: 'noSuchObject', value: null }));
    }
    return oids.map((oid) => ({ oid, type: 'noSuchObject', value: null }));
  }

  // Everything under `base`, in order, at most `max` entries. `start`
  // continues after that OID; past `deadline` (ms timestamp) it stops early.
  async walk(base, { max = 5000, opts, start, deadline } = {}) {
    const out = [];
    let last = (start || base).replace(/^\./, '');
    let reps = 25;
    while (out.length < max && !(deadline && Date.now() > deadline)) {
      const pdu = this.version === '1'
        ? await this.request(PDU.GETNEXT, [{ oid: last }], 0, 0, opts)
        : await this.request(PDU.GETBULK, [{ oid: last }], 0, reps, opts);
      if (pdu.a === ERROR.tooBig && reps > 1) {
        reps = Math.max(1, Math.floor(reps / 2));
        continue;
      }
      if (pdu.a === ERROR.noSuchName && this.version === '1') break; // end of the MIB
      if (pdu.a) throw new Error(`SNMP error ${pdu.a} walking ${base}`);
      let done = !pdu.varbinds.length;
      for (const vb of pdu.varbinds) {
        if (vb.type === 'endOfMibView' || !inSubtree(vb.oid, base) || compareOids(vb.oid, last) <= 0) {
          done = true;
          break;
        }
        out.push(vb);
        last = vb.oid;
        if (out.length >= max) break;
      }
      if (done) break;
    }
    return out;
  }

  close() {
    for (const p of this.pending.values()) p.resolve(null);
    this.pending.clear();
    try {
      this.socket?.close();
    } catch {
      // already closed
    }
    this.socket = null;
  }
}
