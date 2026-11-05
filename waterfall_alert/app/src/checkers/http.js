import http from 'node:http';
import https from 'node:https';

const MAX_BODY = 1024 * 1024;
const MAX_REDIRECTS = 5;

// "200-299,301,404" -> predicate
export function parseStatusCodes(spec) {
  const ranges = String(spec || '200-299')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const [lo, hi] = part.split('-').map((n) => Number(n.trim()));
      return [lo, Number.isFinite(hi) ? hi : lo];
    });
  return (code) => ranges.some(([lo, hi]) => code >= lo && code <= hi);
}

function request(url, opts, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: opts.method,
      headers: { 'User-Agent': 'WaterfallAlert/0.1', Accept: '*/*', ...opts.headers },
      rejectUnauthorized: !opts.ignoreTls,
      timeout: opts.timeoutMs,
    }, (res) => {
      const code = res.statusCode;
      if (code >= 300 && code < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        resolve(request(new URL(res.headers.location, u).toString(), opts, redirectsLeft - 1));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        if (size < MAX_BODY) chunks.push(c);
        size += c.length;
      });
      res.on('end', () => resolve({ code, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`Timed out after ${opts.timeoutMs / 1000}s`)));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

export async function checkHttp(monitor) {
  const c = monitor.config;
  if (!c.url) throw new Error('No URL configured');
  let headers = {};
  if (c.headers) {
    try {
      headers = typeof c.headers === 'string' ? JSON.parse(c.headers) : c.headers;
    } catch {
      throw new Error('Headers must be valid JSON');
    }
  }
  const start = performance.now();
  const res = await request(c.url, {
    method: c.method || 'GET',
    headers,
    body: c.body || null,
    ignoreTls: Boolean(c.ignoreTls),
    timeoutMs: monitor.timeout * 1000,
  }, MAX_REDIRECTS);
  const ping = Math.round(performance.now() - start);

  if (!parseStatusCodes(c.acceptedCodes)(res.code)) {
    return { ok: false, ping, msg: `HTTP ${res.code}` };
  }
  if (c.keyword) {
    const found = res.body.includes(c.keyword);
    if (found === Boolean(c.invertKeyword)) {
      return {
        ok: false,
        ping,
        msg: c.invertKeyword ? `Keyword "${c.keyword}" is present` : `Keyword "${c.keyword}" not found`,
      };
    }
  }
  return { ok: true, ping, msg: `HTTP ${res.code}` };
}
