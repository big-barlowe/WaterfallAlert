import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { checkMinecraft, resolveMinecraft } from '../src/checkers/minecraft.js';
import { Store } from '../src/db.js';
import { IconCache } from '../src/icons.js';

function readVarint(buf, offset) {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    const b = buf[pos++];
    value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return { value, size: pos - offset };
    shift += 7;
  }
}

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

// A tiny Java Edition server: records the handshake, answers the status
// request with `status`, split across two writes to exercise buffering.
async function fakeServer(status, { raw } = {}) {
  const seen = {};
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (raw) return sock.end(raw);
      const len = readVarint(buf, 0);
      if (buf.length < len.size + len.value) return;
      const body = buf.subarray(len.size, len.size + len.value);
      let o = readVarint(body, 0).size; // packet id
      const proto = readVarint(body, o);
      o += proto.size;
      const hostLen = readVarint(body, o);
      o += hostLen.size;
      Object.assign(seen, {
        protocol: proto.value | 0,
        host: body.subarray(o, o + hostLen.value).toString(),
        port: body.readUInt16BE(o + hostLen.value),
        nextState: body[o + hostLen.value + 2],
      });
      const json = Buffer.from(JSON.stringify(status));
      const payload = Buffer.concat([varint(0), varint(json.length), json]);
      const reply = Buffer.concat([varint(payload.length), payload]);
      sock.write(reply.subarray(0, 5));
      setTimeout(() => sock.end(reply.subarray(5)), 10);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, close: () => server.close() };
}

const monitor = (config) => ({ type: 'minecraft', config, timeout: 3 });

test('reads players and version from a Java Edition status reply', async () => {
  const srv = await fakeServer({
    version: { name: '§aPaper 1.21.4', protocol: 769 },
    players: { max: 20, online: 3 },
    description: { text: 'Bulldog ', extra: [{ text: 'Club' }] },
  });
  try {
    const res = await checkMinecraft(monitor({ host: '127.0.0.1', port: String(srv.port) }));
    assert.equal(res.ok, true);
    assert.equal(res.msg, '3/20 players · Paper 1.21.4');
    assert.ok(res.ping >= 0);
    assert.deepEqual(srv.seen, { protocol: -1, host: '127.0.0.1', port: srv.port, nextState: 1 });
  } finally {
    srv.close();
  }
});

test('something that is not a Minecraft server counts as down', async () => {
  const srv = await fakeServer(null, { raw: 'HTTP/1.1 400 Bad Request\r\n\r\n' });
  try {
    await assert.rejects(checkMinecraft(monitor({ host: '127.0.0.1', port: srv.port })), /127\.0\.0\.1:\d+: /);
  } finally {
    srv.close();
  }
});

test('a closed port is down, with the address in the message', async () => {
  const srv = await fakeServer({});
  srv.close();
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(checkMinecraft(monitor({ host: '127.0.0.1', port: srv.port })), /ECONNREFUSED/);
});

test('follows the SRV record like the game does', async () => {
  const srv = (records, code) => async (name) => {
    assert.equal(name, '_minecraft._tcp.gsc.example.net');
    if (code) throw Object.assign(new Error(code), { code });
    return records;
  };
  assert.deepEqual(
    await resolveMinecraft('gsc.example.net', '', 1000, srv([
      { name: 'backup.example.net', port: 25570, priority: 10, weight: 5 },
      { name: 'ip.example.net.', port: 25600, priority: 0, weight: 5 },
    ])),
    { host: 'ip.example.net', port: 25600, srv: true });
  assert.deepEqual(await resolveMinecraft('gsc.example.net', '', 1000, srv([], 'ENODATA')), { host: 'gsc.example.net', port: 25565, srv: false });
  await assert.rejects(resolveMinecraft('gsc.example.net', '', 1000, srv([], 'ETIMEOUT')), /SRV lookup .* ETIMEOUT/);
  // an explicit port skips the lookup entirely
  assert.deepEqual(await resolveMinecraft('gsc.example.net', 25601, 1000, () => assert.fail('looked up SRV')), { host: 'gsc.example.net', port: 25601, srv: false });
});

test('Minecraft monitors use the server icon automatically', async () => {
  const store = new Store(':memory:');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
  let favicon = `data:image/png;base64,${png.toString('base64')}`;
  const icons = new IconCache({ store, minecraftStatus: async () => ({ status: { favicon } }) });
  const add = (name) => store.createMonitor({
    name, type: 'minecraft', config: { host: `${name}.example.net` }, interval: 60, retries: 0, retryInterval: 20,
    timeout: 5, resendInterval: 0, parentMode: 'all', active: true,
  });
  const withIcon = add('a');
  icons.sync(store.listMonitors());
  await icons.idle();
  assert.equal(icons.describe(store.getMonitor(withIcon)).kind, 'image');

  favicon = undefined;
  const without = add('b');
  icons.sync(store.listMonitors());
  await icons.idle();
  assert.deepEqual(icons.describe(store.getMonitor(without)), { kind: 'builtin', name: 'gamepad' });
});
