import net from 'node:net';
import dns from 'node:dns';
import { execFile } from 'node:child_process';

export function checkTcp(monitor) {
  const { host, port } = monitor.config;
  if (!host || !port) throw new Error('Host and port are required');
  return new Promise((resolve) => {
    const start = performance.now();
    const sock = net.connect({ host, port: Number(port) });
    const done = (result) => {
      sock.destroy();
      resolve(result);
    };
    sock.setTimeout(monitor.timeout * 1000);
    sock.once('connect', () => done({ ok: true, ping: Math.round(performance.now() - start), msg: `Port ${port} open` }));
    sock.once('timeout', () => done({ ok: false, msg: `Connection to ${host}:${port} timed out` }));
    sock.once('error', (err) => done({ ok: false, msg: err.code ? `${err.code} ${host}:${port}` : err.message }));
  });
}

export function checkPing(monitor) {
  const { host } = monitor.config;
  if (!host) throw new Error('Host is required');
  if (!/^[a-zA-Z0-9.:_-]+$/.test(host)) throw new Error('Invalid host');
  const timeout = Math.max(1, monitor.timeout);
  // BusyBox/iputils use -W <seconds>; macOS (dev only) uses -t <seconds>.
  const args = process.platform === 'darwin'
    ? ['-c', '1', '-t', String(timeout), host]
    : ['-c', '1', '-W', String(timeout), host];
  return new Promise((resolve) => {
    execFile('ping', args, { timeout: (timeout + 2) * 1000 }, (err, stdout, stderr) => {
      const m = /time[=<]\s*([\d.]+)\s*ms/.exec(stdout);
      if (!err && m) {
        resolve({ ok: true, ping: Math.round(Number(m[1]) * 10) / 10, msg: 'Reply received' });
        return;
      }
      const reason = (stderr || '').trim().split('\n').pop() || (err?.killed ? 'Timed out' : 'No reply');
      resolve({ ok: false, msg: `${host}: ${reason}` });
    });
  });
}

export async function checkDns(monitor) {
  const { hostname, recordType = 'A', server, expected } = monitor.config;
  if (!hostname) throw new Error('Hostname is required');
  const resolver = new dns.promises.Resolver({ timeout: monitor.timeout * 1000, tries: 1 });
  if (server) resolver.setServers([server]);
  const start = performance.now();
  let records;
  try {
    records = await resolver.resolve(hostname, recordType);
  } catch (err) {
    return { ok: false, msg: `${recordType} ${hostname}: ${err.code || err.message}` };
  }
  const ping = Math.round(performance.now() - start);
  const flat = records.map((r) => {
    if (typeof r === 'string') return r;
    if (Array.isArray(r)) return r.join('');
    if (r.exchange) return r.exchange;
    if (r.port != null && r.name) return `${r.name}:${r.port}`; // SRV
    return JSON.stringify(r);
  });
  if (expected && !flat.some((v) => v.includes(expected))) {
    return { ok: false, ping, msg: `Expected "${expected}", got ${flat.join(', ') || 'nothing'}` };
  }
  return { ok: true, ping, msg: flat.slice(0, 3).join(', ') };
}
