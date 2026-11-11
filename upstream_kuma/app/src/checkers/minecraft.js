import net from 'node:net';
import dns from 'node:dns';

const DEFAULT_PORT = 25565;
const MAX_PACKET = 1024 * 1024; // status JSON with a 64px favicon is ~10-30 KB

// ---- protocol bits ----------------------------------------------------------

function varint(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

// { value, size } or null if `buf` ends mid-VarInt.
function readVarint(buf, offset) {
  let value = 0;
  for (let shift = 0, pos = offset; pos < buf.length; shift += 7) {
    if (shift > 28) throw new Error('bad VarInt from server');
    const b = buf[pos++];
    value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return { value, size: pos - offset };
  }
  return null;
}

const mcString = (s) => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([varint(b.length), b]);
};

const packet = (id, ...fields) => {
  const body = Buffer.concat([varint(id), ...fields]);
  return Buffer.concat([varint(body.length), body]);
};

// ---- address resolution -----------------------------------------------------

const defaultResolveSrv = (name, timeoutMs) => new dns.promises.Resolver({ timeout: timeoutMs, tries: 1 }).resolveSrv(name);

// Like the game: an explicit port skips the SRV lookup; otherwise follow
// _minecraft._tcp.<host>, falling back to <host>:25565 when there is none.
export async function resolveMinecraft(host, port, timeoutMs, resolveSrv = defaultResolveSrv) {
  if (port) return { host, port: Number(port), srv: false };
  if (net.isIP(host)) return { host, port: DEFAULT_PORT, srv: false };
  const name = `_minecraft._tcp.${host}`;
  try {
    const records = await resolveSrv(name, timeoutMs);
    if (records.length) {
      const best = [...records].sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
      return { host: best.name.replace(/\.$/, ''), port: best.port, srv: true };
    }
  } catch (err) {
    if (err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') throw new Error(`SRV lookup for ${name} failed: ${err.code || err.message}`);
  }
  return { host, port: DEFAULT_PORT, srv: false };
}

// ---- status query -----------------------------------------------------------

// Java Edition "Server List Ping": handshake (next state = status), status
// request, then read the JSON status response. `ping` is the time from the
// request to the response, i.e. excluding the TCP connect.
export function queryStatus(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    let sentAt = 0;
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs);

    socket.on('connect', () => {
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);
      // protocol version -1: "just probing", accepted by every server version
      socket.write(Buffer.concat([packet(0x00, varint(-1), mcString(host), portBuf, varint(1)), packet(0x00)]));
      sentAt = performance.now();
    });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        const len = readVarint(buf, 0);
        if (!len) return;
        if (len.value > MAX_PACKET) throw new Error('status response too large');
        if (buf.length < len.size + len.value) return;
        const body = buf.subarray(len.size, len.size + len.value);
        const id = readVarint(body, 0);
        if (id?.value !== 0) throw new Error('unexpected reply (not a Minecraft Java server?)');
        const strLen = readVarint(body, id.size);
        if (!strLen) throw new Error('truncated status response');
        const start = id.size + strLen.size;
        const status = JSON.parse(body.subarray(start, start + strLen.value).toString('utf8'));
        finish(null, { status, ping: Math.round(performance.now() - sentAt) });
      } catch (err) {
        finish(err instanceof SyntaxError ? new Error('server sent invalid status JSON') : err);
      }
    });
    socket.on('error', (err) => finish(new Error(err.code || err.message)));
    socket.on('close', () => finish(new Error('connection closed without a status reply (not a Minecraft Java server?)')));
  });
}

// Chat components ({text, extra: [...]}) or legacy strings with § colour codes.
const plainText = (c) => {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(plainText).join('');
  if (!c || typeof c !== 'object') return '';
  return `${c.text ?? ''}${(c.extra ?? []).map(plainText).join('')}`;
};
const clean = (s) => plainText(s).replace(/§./g, '').replace(/\s+/g, ' ').trim();

export async function minecraftStatus(config, timeoutMs) {
  const target = await resolveMinecraft(String(config.host).trim(), config.port, timeoutMs);
  const where = `${target.host}:${target.port}${target.srv ? ' (via SRV)' : ''}`;
  try {
    return { ...(await queryStatus(target.host, target.port, timeoutMs)), where };
  } catch (err) {
    err.message = `${where}: ${err.message}`;
    throw err;
  }
}

export async function checkMinecraft(monitor) {
  if (!monitor.config.host) throw new Error('Server address is required');
  const { status, ping } = await minecraftStatus(monitor.config, monitor.timeout * 1000);
  const players = status.players ? `${status.players.online}/${status.players.max} players` : null;
  const version = status.version?.name ? clean(status.version.name).slice(0, 40) : null;
  return { ok: true, ping, msg: [players, version].filter(Boolean).join(' · ') || 'Status OK' };
}
